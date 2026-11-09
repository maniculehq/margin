/**
 * Two builds of one site racing over a shared content-hash blob. Build C's
 * collection deletes an old version's blob while build D (a different
 * commit carrying the same asset) uploads it and commits a reference to it.
 * Interleaved freely, C deletes the blob D now serves; the per-site ingest
 * lock must keep D's upload and commit out of C's collection.
 *
 * The Blob API is the one external service here, so a local stand-in plays
 * it (the SDK honours VERCEL_BLOB_API_URL) and holds C's delete request open
 * to pin the interleaving. Needs a Postgres the DATABASE_URL role can create
 * databases on; skipped, loudly, without one.
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
        "DATABASE_URL not set — skipping the ingest blob race suite (docker compose up -d postgres)",
    )

const databaseName = `ingest_race_${randomUUID().replaceAll("-", "")}`
const databaseUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()

/** Pathnames currently stored in the stand-in Blob store. */
const stored = new Set<string>()
/** Holds the stand-in's deletes open until released; re-armed per case. */
const armDeleteGate = () => {
    let enter = () => {}
    let release = () => {}
    const gate = {
        entered: new Promise<void>((resolve) => {
            enter = resolve
        }),
        released: new Promise<void>((resolve) => {
            release = resolve
        }),
        enter: () => enter(),
        release: () => release(),
    }
    return gate
}
let deleteGate = armDeleteGate()
let server: Server
let blobApiUrl = ""

const query = async (sql: string, params: unknown[] = []) => {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
        return (await client.query(sql, params)).rows
    } finally {
        await client.end()
    }
}

const ingest = (dir: string, slug: string, sha: string) =>
    promisify(execFile)(
        "bun",
        ["scripts/ingest.ts", "--dir", dir, "--slug", slug, "--sha", sha],
        {
            cwd: root,
            env: {
                PATH: process.env.PATH ?? "",
                DATABASE_URL: databaseUrl,
                BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_secret",
                VERCEL_BLOB_API_URL: blobApiUrl,
                DOCS_KEEP_VERSIONS: "1",
            },
        },
    )

describe.skipIf(!adminUrl)("concurrent ingests sharing a blob", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ingest-race-"))
    const large = join(scratch, "large")
    const small = resolve(root, "tests/fixtures/bare")

    beforeAll(async () => {
        server = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", async () => {
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
                    const gate = deleteGate
                    gate.enter()
                    // Deletes stay open until the test releases them.
                    await gate.released
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

        const admin = new Client({ connectionString: adminUrl })
        await admin.connect()
        await admin.query(`create database "${databaseName}"`)
        await admin.end()
        await promisify(execFile)("bun", ["scripts/db-migrate.ts"], {
            cwd: root,
            env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
        })
        // Over the 1 MB inline cap, so it goes to the blob store.
        mkdirSync(large)
        writeFileSync(
            join(large, "index.mdx"),
            '# Asset\n\n<video src="/shared.mp4" controls />\n',
        )
    }, 60_000)

    afterAll(async () => {
        deleteGate.release()
        await new Promise((resolve) => server.close(resolve))
        rmSync(scratch, { recursive: true, force: true })
        const admin = new Client({ connectionString: adminUrl })
        await admin.connect()
        await admin.query(
            `drop database if exists "${databaseName}" with (force)`,
        )
        await admin.end()
    })

    // Blob paths are global, so the newer build may belong to another site.
    it.each([
        ["the same site", "same", "same"],
        ["another site", "first", "second"],
    ])(
        "never deletes a blob a newer build on %s has just referenced",
        async (_label, collector, writer) => {
            // Fresh bytes per case, over the 1 MB inline cap: its own blob.
            writeFileSync(
                join(large, "shared.mp4"),
                randomBytes(1024 * 1024 + 1),
            )
            deleteGate = armDeleteGate()
            // A owns the blob; B supersedes A; A ages past retention.
            await ingest(large, collector, "sha-a")
            await ingest(small, collector, "sha-b")
            await query(
                "update docs_content_version v set created_at = now() - interval '31 days' from docs_site s where s.id = v.site_id and s.slug = $1 and v.commit_sha = 'sha-a'",
                [collector],
            )
            const [owned] = z
                .array(z.object({ blob_url: z.string() }))
                .parse(
                    await query(
                        "select a.blob_url from docs_asset a join docs_content_version v on v.id = a.version_id join docs_site s on s.id = v.site_id where s.slug = $1 and v.commit_sha = 'sha-a' and a.blob_url is not null",
                        [collector],
                    ),
                )
            expect(owned).toBeDefined()

            // C collects A and is held inside its blob delete.
            const c = ingest(small, collector, "sha-c")
            await deleteGate.entered
            // D carries the same asset. Unserialised, it re-uploads and
            // commits while C is held; give it the time it needs.
            const d = ingest(large, writer, "sha-d")
            await Promise.race([
                d.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 5_000)),
            ])
            deleteGate.release()
            await Promise.all([c, d])

            const [served] = z
                .array(
                    z.object({ commit_sha: z.string(), blob_url: z.string() }),
                )
                .parse(
                    await query(
                        "select v.commit_sha, a.blob_url from docs_site s join docs_content_version v on v.id = s.current_version_id join docs_asset a on a.version_id = v.id where s.slug = $1 and a.blob_url is not null",
                        [writer],
                    ),
                )
            expect(served).toEqual({
                commit_sha: "sha-d",
                blob_url: owned?.blob_url,
            })
            // The blob the served version references still exists.
            expect(stored).toContain(
                new URL(served?.blob_url ?? "").pathname.slice(1),
            )
        },
        90_000,
    )
})
