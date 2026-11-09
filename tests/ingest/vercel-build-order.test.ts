/**
 * A deploy build that ingests and then fails must not cost production its
 * content. Production serves version A (older than the 30-day window); build
 * B fails in the server build, so B never goes live; build C then collects
 * with DOCS_KEEP_VERSIONS=1 and must keep A, because the pointer it protects
 * as "served before this build" may only ever name a build that succeeded.
 *
 * Runs the real `scripts/vercel-build.ts`, migrate and ingest from a scratch
 * package whose server build fails (it has no Vite entry). The icon step is a
 * no-op there: the real one would rewrite this checkout's generated map, and
 * the icon map plays no part in what is published. Needs a Postgres the
 * DATABASE_URL role can create databases on; skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")
const adminUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!adminUrl)
    console.warn(
        "DATABASE_URL not set — skipping the deploy build order suite (docker compose up -d postgres)",
    )

const databaseName = `build_order_${randomUUID().replaceAll("-", "")}`
const databaseUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()
const fixture = resolve(root, "tests/fixtures/bare")

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

const query = async (sql: string, params: unknown[] = []) => {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
        return (await client.query(sql, params)).rows
    } finally {
        await client.end()
    }
}

const ingest = (sha: string, env: Record<string, string> = {}) =>
    promisify(execFile)(
        "bun",
        ["scripts/ingest.ts", "--dir", fixture, "--slug", "live", "--sha", sha],
        {
            cwd: root,
            env: {
                PATH: process.env.PATH ?? "",
                DATABASE_URL: databaseUrl,
                ...env,
            },
        },
    )

describe.skipIf(!adminUrl)("a deploy build whose server build fails", () => {
    const scratch = mkdtempSync(join(tmpdir(), "vercel-build-order-"))

    beforeAll(async () => {
        await adminQuery(`create database "${databaseName}"`)
        await promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
            cwd: root,
            env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
        })
        mkdirSync(join(scratch, "scripts"))
        copyFileSync(
            resolve(root, "scripts/vercel-build.ts"),
            join(scratch, "scripts/vercel-build.ts"),
        )
        writeFileSync(join(scratch, "scripts/build-icon-map.ts"), "")
        for (const script of ["db-migrate.ts", "ingest.ts"])
            symlinkSync(
                resolve(root, "scripts", script),
                join(scratch, "scripts", script),
            )
        for (const entry of ["node_modules", "bunfig.toml"])
            symlinkSync(resolve(root, entry), join(scratch, entry))
    }, 60_000)

    afterAll(async () => {
        rmSync(scratch, { recursive: true, force: true })
        await adminQuery(
            `drop database if exists "${databaseName}" with (force)`,
        )
    })

    it("keeps the version production serves through the next build's collection", async () => {
        await ingest("sha-a")
        await query(
            "update docs_content_version set created_at = now() - interval '31 days' where commit_sha = 'sha-a'",
        )

        await expect(
            promisify(execFile)("bun", ["scripts/vercel-build.ts"], {
                cwd: scratch,
                env: {
                    PATH: process.env.PATH ?? "",
                    HOME: process.env.HOME,
                    DATABASE_URL: databaseUrl,
                    DOCS_CONTENT_SHA: "sha-b",
                    DOCS_DIR: fixture,
                    SITE_SLUG: "live",
                    SITE_ORIGIN: "https://docs.test.invalid",
                },
            }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining("`bun x vite build` failed"),
        })

        await ingest("sha-c", { DOCS_KEEP_VERSIONS: "1" })
        const shas = z
            .array(z.object({ commit_sha: z.string() }))
            .parse(
                await query(
                    "select commit_sha from docs_content_version order by seq",
                ),
            )
            .map((row) => row.commit_sha)
        expect(shas).toContain("sha-c")
        expect(shas).toContain("sha-a")
    }, 120_000)
})
