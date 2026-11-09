/**
 * The build-time ingest CLI end to end: `bun scripts/ingest.ts` against a
 * database created empty for this suite and migrated with the real
 * `db:migrate`. Needs a Postgres the DATABASE_URL role can create databases
 * on (`docker compose up -d postgres`); skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
    mkdtempSync,
    readdirSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")
const adminUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!adminUrl)
    console.warn(
        "DATABASE_URL not set — skipping the ingest CLI suite (docker compose up -d postgres)",
    )

const databaseName = `ingest_${randomUUID().replaceAll("-", "")}`
const databaseUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()

// Every fixture that is a docs tree (hugeicons-pro-fake is an npm package).
const fixtures = readdirSync(resolve(root, "tests/fixtures"), {
    withFileTypes: true,
})
    .filter(
        (entry) => entry.isDirectory() && entry.name !== "hugeicons-pro-fake",
    )
    .map((entry) => entry.name)

/** Run the CLI with only the variables this suite chooses. */
const ingest = async (args: string[], env: Record<string, string> = {}) => {
    try {
        const { stdout, stderr } = await promisify(execFile)(
            "bun",
            ["scripts/ingest.ts", ...args],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? "",
                    DATABASE_URL: databaseUrl,
                    ...env,
                },
            },
        )
        return { code: 0, output: stdout + stderr }
    } catch (error) {
        const failed = z
            .object({
                code: z.number(),
                stdout: z.string(),
                stderr: z.string(),
            })
            .parse(error)
        return { code: failed.code, output: failed.stdout + failed.stderr }
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

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

const versionSchema = z.object({
    id: z.string(),
    status: z.string(),
    kind: z.string(),
    page_count: z.number(),
    error: z.string().nullable(),
    search_corpus: z.instanceof(Buffer).nullable(),
})

const versionsOf = async (slug: string) =>
    z
        .array(versionSchema)
        .parse(
            await query(
                "select v.id, v.status, v.kind, v.page_count, v.error, v.search_corpus from docs_content_version v join docs_site s on s.id = v.site_id where s.slug = $1 order by v.seq",
                [slug],
            ),
        )

const siteOf = async (slug: string) =>
    z
        .object({
            current_version_id: z.string().nullable(),
            ingest_seq: z.coerce.number(),
        })
        .parse(
            (
                await query(
                    "select current_version_id, ingest_seq from docs_site where slug = $1",
                    [slug],
                )
            )[0],
        )

describe.skipIf(!adminUrl)("scripts/ingest.ts", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ingest-cli-"))

    beforeAll(async () => {
        await adminQuery(`create database "${databaseName}"`)
        await promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
            cwd: root,
            env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
        })
    }, 60_000)

    afterAll(async () => {
        rmSync(scratch, { recursive: true, force: true })
        await adminQuery(
            `drop database if exists "${databaseName}" with (force)`,
        )
    })

    it.each(fixtures)(
        "ingests the %s fixture into a served, searchable version",
        async (fixture) => {
            const result = await ingest([
                "--dir",
                `tests/fixtures/${fixture}`,
                "--slug",
                fixture,
                "--sha",
                "a".repeat(40),
            ])
            expect(result).toMatchObject({ code: 0 })
            const [version, ...rest] = await versionsOf(fixture)
            expect(rest).toEqual([])
            expect(version).toMatchObject({
                status: "ready",
                kind: "production",
            })
            expect(version?.page_count).toBeGreaterThan(0)
            expect((await siteOf(fixture)).current_version_id).toBe(version?.id)
            // No blob store: the corpus is stored inline and lists the pages.
            const corpus = z
                .object({ entries: z.array(z.object({ path: z.string() })) })
                .parse(
                    JSON.parse(
                        gunzipSync(
                            version?.search_corpus ?? Buffer.alloc(0),
                        ).toString("utf8"),
                    ),
                )
            const pages = z
                .array(z.object({ path: z.string() }))
                .parse(
                    await query(
                        "select path from docs_page where version_id = $1 order by path",
                        [version?.id],
                    ),
                )
            expect(corpus.entries.map((entry) => entry.path).sort()).toEqual(
                pages.map((page) => page.path),
            )
        },
        60_000,
    )

    it("leaves an already-ingested commit untouched on a rerun", async () => {
        const args = [
            "--dir",
            "tests/fixtures/bare",
            "--slug",
            "rerun",
            "--sha",
            "b".repeat(40),
        ]
        expect(await ingest(args)).toMatchObject({ code: 0 })
        const [first] = await versionsOf("rerun")
        const before = await siteOf("rerun")
        expect(first?.status).toBe("ready")

        const second = await ingest(args)
        expect(second.code).toBe(0)
        expect(second.output).toContain("already ingested")
        // Same single row, and no ingest seq was even claimed.
        expect(await versionsOf("rerun")).toEqual([first])
        expect(await siteOf("rerun")).toEqual(before)
    }, 60_000)

    it("stores a preview version without moving the served pointer", async () => {
        const base = ["--dir", "tests/fixtures/bare", "--slug", "previewed"]
        expect(await ingest([...base, "--sha", "c".repeat(40)])).toMatchObject({
            code: 0,
        })
        const served = (await siteOf("previewed")).current_version_id
        expect(served).not.toBeNull()

        expect(
            await ingest([...base, "--sha", "d".repeat(40)], {
                VERCEL_ENV: "preview",
            }),
        ).toMatchObject({ code: 0 })
        const versions = await versionsOf("previewed")
        expect(versions.map((v) => [v.kind, v.status])).toEqual([
            ["production", "ready"],
            ["preview", "ready"],
        ])
        expect((await siteOf("previewed")).current_version_id).toBe(served)
    }, 60_000)

    it("leaves a suspended site suspended through a later build", async () => {
        const base = ["--dir", "tests/fixtures/bare", "--slug", "suspended"]
        expect(await ingest([...base, "--sha", "e".repeat(40)])).toMatchObject({
            code: 0,
        })
        await query(
            "update docs_site set status = 'suspended' where slug = $1",
            ["suspended"],
        )

        expect(
            await ingest([...base, "--sha", "f".repeat(40)], {
                VERCEL_ENV: "preview",
            }),
        ).toMatchObject({ code: 0 })
        expect((await versionsOf("suspended")).map((v) => v.kind)).toEqual([
            "production",
            "preview",
        ])
        expect(
            await query("select status from docs_site where slug = $1", [
                "suspended",
            ]),
        ).toEqual([{ status: "suspended" }])
    }, 60_000)

    const shasOf = async (slug: string) =>
        z
            .array(z.object({ commit_sha: z.string() }))
            .parse(
                await query(
                    "select v.commit_sha from docs_content_version v join docs_site s on s.id = v.site_id where s.slug = $1 order by v.seq",
                    [slug],
                ),
            )
            .map((row) => row.commit_sha)
    const age = (slug: string, sha: string) =>
        query(
            "update docs_content_version v set created_at = now() - interval '31 days' from docs_site s where s.id = v.site_id and s.slug = $1 and v.commit_sha = $2",
            [slug, sha],
        )

    it("never collects the version the live deployment still serves", async () => {
        const base = ["--dir", "tests/fixtures/bare", "--slug", "collected"]
        const keepOne = { DOCS_KEEP_VERSIONS: "1" }
        expect(await ingest([...base, "--sha", "sha-a"])).toMatchObject({
            code: 0,
        })
        await age("collected", "sha-a")
        // A serves until B's deployment is promoted, however old it is.
        expect(
            await ingest([...base, "--sha", "sha-b"], keepOne),
        ).toMatchObject({ code: 0 })
        expect(await shasOf("collected")).toEqual(["sha-a", "sha-b"])

        // Once B served, an old A beyond the keep count is collected.
        await age("collected", "sha-b")
        const result = await ingest([...base, "--sha", "sha-c"], keepOne)
        expect(result.output).toContain("collected 1 old version(s)")
        expect(await shasOf("collected")).toEqual(["sha-b", "sha-c"])
    }, 60_000)

    it("keeps old blob-backed versions it cannot delete the blobs of", async () => {
        const base = ["--dir", "tests/fixtures/bare", "--slug", "blobbed"]
        expect(await ingest([...base, "--sha", "sha-x"])).toMatchObject({
            code: 0,
        })
        // Two old superseded versions, identical but for a reference to a
        // blob in this database's namespace.
        const [{ namespace }] = z
            .tuple([z.object({ namespace: z.string() })])
            .parse(await query("select namespace from docs_blob_namespace"))
        const oldVersions: { seq: number; corpusUrl: string | null }[] = [
            {
                seq: -1,
                corpusUrl: `https://blob.example/docs-search/${namespace}/old.json.gz`,
            },
            { seq: -2, corpusUrl: null },
        ]
        for (const { seq, corpusUrl } of oldVersions)
            await query(
                "insert into docs_content_version (id, site_id, commit_sha, seq, status, search_corpus_url, created_at) select $1, id, $2, $3, 'superseded', $4, now() - interval '31 days' from docs_site where slug = 'blobbed'",
                [randomUUID(), `old${seq}`, seq, corpusUrl],
            )

        const result = await ingest([...base, "--sha", "sha-y"], {
            DOCS_KEEP_VERSIONS: "1",
        })
        expect(result.output).toContain("collected 1 old version(s)")
        expect(result.output).toContain(
            "kept 1 old version(s) whose blobs cannot be deleted",
        )
        expect(await shasOf("blobbed")).toEqual(["old-1", "sha-x", "sha-y"])
    }, 60_000)

    it("takes the blob lock on the direct connection, not the pooled one", async () => {
        // Only the lock uses the direct URL; pointing it nowhere fails the
        // build there, while the same run on the pooled URL alone succeeds
        // (every test above).
        const result = await ingest(
            [
                "--dir",
                "tests/fixtures/bare",
                "--slug",
                "direct",
                "--sha",
                "f".repeat(40),
            ],
            {
                DATABASE_URL_UNPOOLED:
                    "postgres://nobody:nothing@127.0.0.1:9/none",
            },
        )
        expect(result.code).toBe(1)
        expect(result.output).toContain("ECONNREFUSED 127.0.0.1:9")
    }, 60_000)

    it("publishes past an over-cap video and prints the asset warning", async () => {
        const docs = mkdtempSync(join(scratch, "oversize-"))
        writeFileSync(join(docs, "index.mdx"), "# Home\n\nBody.\n")
        // Sparse: over the 20 MB per-asset cap without using the disk.
        writeFileSync(join(docs, "demo.mp4"), "")
        truncateSync(join(docs, "demo.mp4"), 20 * 1024 * 1024 + 1)

        const result = await ingest([
            "--dir",
            docs,
            "--slug",
            "oversize",
            "--sha",
            "f".repeat(40),
        ])
        expect(result.code).toBe(0)
        expect(result.output).toContain(
            "warn: demo.mp4: Asset skipped because it exceeds the 20MB per-asset cap.",
        )
        const [version] = await versionsOf("oversize")
        expect(version?.status).toBe("ready")
    }, 60_000)

    it("fails the build on content violations and records the failed attempt", async () => {
        const docs = mkdtempSync(join(scratch, "broken-"))
        writeFileSync(join(docs, "index.mdx"), "# Fine\n\nBody.\n")
        writeFileSync(join(docs, "meta.json"), "{ not json")

        const result = await ingest([
            "--dir",
            docs,
            "--slug",
            "broken",
            "--sha",
            "e".repeat(40),
        ])
        expect(result.code).toBe(1)
        // The report names the offending file, as a check run would.
        expect(result.output).toContain("- `meta.json`: invalid JSON")
        const versions = await versionsOf("broken")
        expect(versions.map((v) => v.status)).toEqual(["failed"])
        expect(versions[0]?.error).toContain("- `meta.json`: invalid JSON")
        expect((await siteOf("broken")).current_version_id).toBeNull()
    }, 60_000)
})
