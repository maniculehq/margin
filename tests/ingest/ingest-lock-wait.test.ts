/**
 * A build waiting on the blob lock outlasts the role's request
 * statement_timeout. db:migrate sets that default to 20 s; this suite lowers
 * it to 1 s on a database created for it, holds the lock as another build
 * would for longer than that, and the waiting ingest must still succeed once
 * the lock is released. Needs a Postgres the DATABASE_URL role can create
 * databases on; skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { DOCS_BLOB_LOCK_KEY } from "@/ingest/assets"

const root = resolve(import.meta.dirname, "../..")
const adminUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!adminUrl)
    console.warn(
        "DATABASE_URL not set — skipping the ingest lock wait suite (docker compose up -d postgres)",
    )

const databaseName = `ingest_lock_${randomUUID().replaceAll("-", "")}`
const databaseUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

describe.skipIf(!adminUrl)("ingest waiting on the blob lock", () => {
    const holder = new Client({ connectionString: databaseUrl })

    beforeAll(async () => {
        await adminQuery(`create database "${databaseName}"`)
        await promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
            cwd: root,
            env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
        })
        // Applies to every session opened on this database from here on.
        await adminQuery(
            `alter role current_user in database "${databaseName}" set statement_timeout = '1s'`,
        )
        await holder.connect()
    }, 60_000)

    afterAll(async () => {
        await holder.end()
        await adminQuery(
            `drop database if exists "${databaseName}" with (force)`,
        )
    })

    it("succeeds after a lock holder outlasts the role's statement_timeout", async () => {
        await holder.query("select pg_advisory_lock($1)", [
            DOCS_BLOB_LOCK_KEY.toString(),
        ])
        const build = promisify(execFile)(
            "bun",
            [
                "scripts/ingest.ts",
                "--dir",
                "tests/fixtures/bare",
                "--slug",
                "lock-wait",
                "--sha",
                "sha-lock-wait",
            ],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? "",
                    DATABASE_URL: databaseUrl,
                },
            },
        )
        build.catch(() => {})
        // The build is queued behind the holder before the clock starts.
        await expect
            .poll(
                async () =>
                    (
                        await holder.query(
                            "select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())",
                        )
                    ).rows[0]?.waiting,
                { timeout: 30_000, interval: 100 },
            )
            .toBe(1)
        await sleep(2_500)
        await holder.query("select pg_advisory_unlock($1)", [
            DOCS_BLOB_LOCK_KEY.toString(),
        ])
        await build

        const [version] = z
            .array(z.object({ status: z.string() }))
            .parse(
                (
                    await holder.query(
                        "select v.status from docs_content_version v join docs_site s on s.id = v.site_id where s.slug = 'lock-wait' and v.commit_sha = 'sha-lock-wait'",
                    )
                ).rows,
            )
        expect(version).toEqual({ status: "ready" })
    }, 60_000)
})
