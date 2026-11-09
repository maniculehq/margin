/**
 * The committed migrations in ./drizzle, applied by the real `db:migrate`
 * script to a database created empty for this suite. Needs a Postgres the
 * DATABASE_URL role can create databases on (`docker compose up -d
 * postgres`); skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { createDb } from "@/db"

const root = resolve(import.meta.dirname, "../..")
const adminUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!adminUrl)
    console.warn(
        "DATABASE_URL not set — skipping the migration suite (docker compose up -d postgres)",
    )

const databaseName = `migrations_${randomUUID().replaceAll("-", "")}`
const freshUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()
// Nothing listens on port 9: a run that connected here would fail.
const unreachableUrl = "postgres://nobody:nothing@127.0.0.1:9/none"
const migrationCount = readdirSync(resolve(root, "drizzle"), {
    withFileTypes: true,
}).filter((entry) => entry.isDirectory()).length

// Only the database variables this suite chooses reach the script.
const runMigrate = (env: Record<string, string>) =>
    promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", ...env },
    })

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

const query = async (sql: string) => {
    const client = new Client({ connectionString: freshUrl })
    await client.connect()
    try {
        return (await client.query(sql)).rows
    } finally {
        await client.end()
    }
}

describe.skipIf(!adminUrl)("db:migrate through the direct URL", () => {
    beforeAll(async () => {
        await adminQuery(`create database "${databaseName}"`)
        // The pooled URL is unreachable: the migration can only land if the
        // script connects through the direct URL.
        await runMigrate({
            DATABASE_URL: unreachableUrl,
            DATABASE_URL_UNPOOLED: freshUrl,
        })
    }, 60_000)

    afterAll(async () => {
        await adminQuery(
            `drop database if exists "${databaseName}" with (force)`,
        )
    })

    it("creates an empty, queryable docs_site", async () => {
        const [sites] = await query(
            "select count(*)::int as count from docs_site",
        )
        expect(z.object({ count: z.number() }).parse(sites).count).toBe(0)
    })

    // The only place tests name the multi-tenant schema: asserting it is gone.
    it("has no multi-tenant table", async () => {
        const [legacy] = await query(
            "select to_regclass('public.docs_tenant') is null as absent",
        )
        expect(z.object({ absent: z.boolean() }).parse(legacy).absent).toBe(
            true,
        )
    })

    it("uses site columns without hosting-platform columns", async () => {
        const rows = await query(
            "select column_name from information_schema.columns where table_schema = 'public'",
        )
        const columns = new Set(
            z
                .array(z.object({ column_name: z.string() }))
                .parse(rows)
                .map((row) => row.column_name),
        )
        expect(columns).toContain("site_id")
        expect(columns).toContain("webmcp_enabled")
        for (const removed of [
            "tenant_id",
            "client_id",
            "github_installation_id",
            "canonical_hostname",
            "webmcp_early_access",
        ])
            expect(columns).not.toContain(removed)
    })

    it("stores the search corpus inline as bytea", async () => {
        const rows = await query(
            "select data_type from information_schema.columns where table_name = 'docs_content_version' and column_name = 'search_corpus'",
        )
        expect(rows).toEqual([{ data_type: "bytea" }])
    })

    it("refuses a ready version that has no search corpus", async () => {
        const siteId = randomUUID()
        await query(
            `insert into docs_site (id, slug, name, analytics_mode) values ('${siteId}', 'corpus-${siteId}', 'Corpus', 'off')`,
        )
        const version = (seq: number, corpusUrl: string | null) =>
            query(
                `insert into docs_content_version (id, site_id, commit_sha, seq, status, search_corpus_url) values ('${randomUUID()}', '${siteId}', 'sha-${seq}', ${seq}, 'ready', ${corpusUrl === null ? "null" : `'${corpusUrl}'`})`,
            )
        // Identical row with a corpus: the refusal below is the corpus check.
        await expect(
            version(1, "https://blob.example/corpus.gz"),
        ).resolves.toEqual([])
        await expect(version(2, null)).rejects.toMatchObject({
            code: "23514",
            constraint: "docs_content_version_ready_corpus_check",
        })
    })

    it("gives new connections a 20 s statement timeout", async () => {
        const db = createDb(freshUrl, { max: 1 })
        try {
            const result = await db.$client.query("show statement_timeout")
            expect(result.rows).toEqual([{ statement_timeout: "20s" }])
        } finally {
            await db.$client.end()
        }
    })

    it("records every committed migration once and applies nothing on a second run", async () => {
        const before = await query(
            "select id from drizzle.__drizzle_migrations order by id",
        )
        await runMigrate({ DATABASE_URL: freshUrl })
        const after = await query(
            "select id from drizzle.__drizzle_migrations order by id",
        )
        expect(migrationCount).toBeGreaterThan(0)
        expect(before).toHaveLength(migrationCount)
        expect(after).toEqual(before)
    })
})
