/**
 * One Blob store serving several databases: production and a preview
 * branch, or a developer's local Postgres, on one BLOB_READ_WRITE_TOKEN.
 * Neither database can see the other's rows, so collection in one must never
 * delete a blob the other still serves — whether the second database is an
 * independent one that ingested the same bytes, or a branch that copied its
 * parent's rows (a Neon preview branch; here `create database … template`).
 *
 * The Blob API is the one external service here, so a local stand-in plays
 * it (the SDK honours VERCEL_BLOB_API_URL). Needs a Postgres the
 * DATABASE_URL role can create databases on; skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
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
        "DATABASE_URL not set — skipping the blob namespace suite (docker compose up -d postgres)",
    )

const created: string[] = []
const databaseUrl = (name: string) => {
    const url = new URL(adminUrl ?? "")
    url.pathname = `/${name}`
    return url.toString()
}

/** Pathnames currently stored in the stand-in Blob store. */
const stored = new Set<string>()
let server: Server
let blobApiUrl = ""

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

const query = async (database: string, sql: string, params: unknown[]) => {
    const client = new Client({ connectionString: databaseUrl(database) })
    await client.connect()
    try {
        return (await client.query(sql, params)).rows
    } finally {
        await client.end()
    }
}

const createDatabase = async (template?: string) => {
    const name = `blob_ns_${randomUUID().replaceAll("-", "")}`
    created.push(name)
    await adminQuery(
        `create database "${name}"${template ? ` template "${template}"` : ""}`,
    )
    if (!template)
        await promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
            cwd: root,
            env: {
                PATH: process.env.PATH ?? "",
                DATABASE_URL: databaseUrl(name),
            },
        })
    return name
}

const ingest = (database: string, dir: string, sha: string, force = false) =>
    promisify(execFile)(
        "bun",
        [
            "scripts/ingest.ts",
            "--dir",
            dir,
            "--slug",
            "docs",
            "--sha",
            sha,
            ...(force ? ["--force"] : []),
        ],
        {
            cwd: root,
            env: {
                PATH: process.env.PATH ?? "",
                DATABASE_URL: databaseUrl(database),
                BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_secret",
                VERCEL_BLOB_API_URL: blobApiUrl,
                DOCS_KEEP_VERSIONS: "1",
            },
        },
    )

const age = (database: string, sha: string) =>
    query(
        database,
        "update docs_content_version set created_at = now() - interval '31 days' where commit_sha = $1",
        [sha],
    )

const shas = async (database: string) =>
    z
        .array(z.object({ commit_sha: z.string() }))
        .parse(
            await query(
                database,
                "select commit_sha from docs_content_version order by seq",
                [],
            ),
        )
        .map((row) => row.commit_sha)

/** The pathname of the asset blob a version references. */
const blobOf = async (database: string, sha: string) => {
    const [row] = z
        .array(z.object({ blob_url: z.string() }))
        .parse(
            await query(
                database,
                "select a.blob_url from docs_asset a join docs_content_version v on v.id = a.version_id where v.commit_sha = $1 and a.blob_url is not null",
                [sha],
            ),
        )
    if (!row) throw new Error(`${sha} references no blob`)
    return new URL(row.blob_url).pathname.slice(1)
}

describe.skipIf(!adminUrl)("databases sharing one blob store", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ingest-blob-ns-"))
    const large = join(scratch, "large")
    const small = resolve(root, "tests/fixtures/bare")

    beforeAll(async () => {
        server = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
                const url = new URL(request.url ?? "/", "http://localhost")
                response.setHeader("content-type", "application/json")
                if (request.method === "PUT") {
                    // Corpus uploads ask for a random suffix, as the real
                    // store gives every corpus its own URL.
                    const pathname = url.searchParams.get("pathname") ?? ""
                    const key = pathname.startsWith("docs-search/")
                        ? `${pathname}-${randomUUID()}`
                        : pathname
                    stored.add(key)
                    response.end(
                        JSON.stringify({
                            url: `https://store.test/${key}`,
                            downloadUrl: `https://store.test/${key}?download=1`,
                            pathname: key,
                            contentType: "application/octet-stream",
                            contentDisposition: "inline",
                            etag: "etag",
                        }),
                    )
                    return
                }
                if (request.method === "POST" && url.pathname === "/delete") {
                    const { urls } = z
                        .object({ urls: z.array(z.string()) })
                        .parse(
                            JSON.parse(Buffer.concat(chunks).toString("utf8")),
                        )
                    for (const blobUrl of urls)
                        stored.delete(new URL(blobUrl).pathname.slice(1))
                    response.end("{}")
                    return
                }
                response.statusCode = 404
                response.end(
                    JSON.stringify({
                        error: { code: "not_found", message: "" },
                    }),
                )
            })
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const address = server.address()
        if (address === null || typeof address === "string")
            throw new Error("blob stand-in did not bind a port")
        blobApiUrl = `http://127.0.0.1:${address.port}`
        mkdirSync(large)
        writeFileSync(
            join(large, "index.mdx"),
            '# Asset\n\n<video src="/shared.mp4" controls />\n',
        )
    })

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve))
        rmSync(scratch, { recursive: true, force: true })
        for (const name of created)
            await adminQuery(`drop database if exists "${name}" with (force)`)
    })

    it.each([
        {
            left: "db.example.test:5432",
            right: "db.example.test:6432",
            same: false,
        },
        {
            left: "db-pooler.example.test",
            right: "db.example.test",
            same: false,
        },
        {
            left: "ep-quiet-river-123-pooler.us-east-2.aws.neon.tech",
            right: "ep-quiet-river-123.us-east-2.aws.neon.tech",
            same: true,
        },
        {
            left: "ep-quiet-river-123-pooler.us-east-2.aws.neon.tech.attacker.test",
            right: "ep-quiet-river-123.us-east-2.aws.neon.tech.attacker.test",
            same: false,
        },
        { left: "localhost", right: "127.0.0.1", same: true },
        { left: "[::1]", right: "127.0.0.1", same: true },
        { left: "localhost.example.test", right: "127.0.0.1", same: false },
    ])(
        "isolates database addresses except guaranteed aliases: $left / $right",
        async ({ left, right, same }) => {
            const database = await createDatabase()
            const { stdout } = await promisify(execFile)(
                "bun",
                [
                    "--eval",
                    `
            import { resolveBlobNamespace } from "./src/ingest/assets.ts";
            import { db } from "./src/db/index.ts";
            const first = await resolveBlobNamespace(process.env.FIRST_ADDRESS);
            const second = await resolveBlobNamespace(process.env.SECOND_ADDRESS);
            console.log(JSON.stringify([first, second]));
            await db.$client.end();
        `,
                ],
                {
                    cwd: root,
                    env: {
                        PATH: process.env.PATH ?? "",
                        DATABASE_URL: databaseUrl(database),
                        FIRST_ADDRESS: `postgres://user:password@${left}/docs`,
                        SECOND_ADDRESS: `postgres://other:secret@${right}/docs?application_name=writer`,
                    },
                },
            )
            const [first, second] = z
                .tuple([z.uuid(), z.uuid()])
                .parse(JSON.parse(stdout))
            expect(first === second).toBe(same)
        },
    )

    it("never deletes a blob another database serves from the same bytes", async () => {
        // Fresh bytes, over the 1 MB inline cap: they go to the store.
        writeFileSync(join(large, "shared.mp4"), randomBytes(1024 * 1024 + 1))
        const production = await createDatabase()
        const preview = await createDatabase()

        await ingest(production, large, "sha-served")
        const served = await blobOf(production, "sha-served")

        // The preview database holds the same bytes in a version it then
        // supersedes and collects.
        await ingest(preview, large, "sha-a")
        const collected = await blobOf(preview, "sha-a")
        await ingest(preview, small, "sha-b")
        await age(preview, "sha-a")
        await ingest(preview, small, "sha-c")

        expect(await shas(preview)).toEqual(["sha-b", "sha-c"])
        expect(stored).not.toContain(collected)
        expect(stored).toContain(served)
    }, 120_000)

    it("never deletes a parent's blob from a branched copy", async () => {
        writeFileSync(join(large, "shared.mp4"), randomBytes(1024 * 1024 + 1))
        const production = await createDatabase()
        await ingest(production, large, "sha-a")
        await ingest(production, small, "sha-b")

        // The branch copies every row, sha-a's blob reference included.
        const branch = await createDatabase(production)

        // Production serves the same bytes again, from the same blob.
        await ingest(production, large, "sha-c")
        const served = await blobOf(production, "sha-c")
        expect(await blobOf(production, "sha-a")).toBe(served)

        // The branch collects its copy of sha-a.
        await age(branch, "sha-a")
        await ingest(branch, small, "sha-d")

        expect(await shas(branch)).toEqual(["sha-b", "sha-d"])
        expect(stored).toContain(served)
    }, 120_000)

    it("never deletes a parent's blob when a branch re-ingests its copy", async () => {
        writeFileSync(join(large, "shared.mp4"), randomBytes(1024 * 1024 + 1))
        const production = await createDatabase()
        await ingest(production, large, "sha-a")
        const served = await blobOf(production, "sha-a")
        const branch = await createDatabase(production)

        // --force replaces the branch's copy of sha-a, whose blob reference
        // is the parent's, with a version of its own.
        await ingest(branch, large, "sha-a", true)

        expect(await blobOf(branch, "sha-a")).not.toBe(served)
        expect(stored).toContain(served)
    }, 120_000)
})
