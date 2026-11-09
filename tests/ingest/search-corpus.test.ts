import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
    buildSearchCorpus,
    SEARCH_CORPUS_PREFIX,
    type SearchCorpusEntry,
    uploadSearchCorpus,
} from "@/ingest/assets"
import { compileDocs } from "@/ingest/compile"

const envelopeSchema = z.object({
    formatVersion: z.literal(1),
    entries: z.array(
        z.object({
            path: z.string(),
            structuredData: z.object({
                headings: z.array(
                    z.object({ id: z.string(), content: z.string() }),
                ),
                contents: z.array(
                    z.object({
                        heading: z.string().optional(),
                        content: z.string(),
                    }),
                ),
            }),
        }),
    ),
})

/**
 * Postgres jsonb normalizes object key order, so structured_data read back
 * from docs_page rows never matches the in-memory compile object byte for
 * byte. Simulate that round-trip: rebuild every object with keys sorted the
 * way jsonb stores them (length, then bytewise).
 */
function jsonbRoundTrip(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(jsonbRoundTrip)
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(
            z.record(z.string(), z.unknown()).parse(value),
        ).sort(([a], [b]) =>
            a.length !== b.length
                ? a.length - b.length
                : a < b
                  ? -1
                  : a > b
                    ? 1
                    : 0,
        )
        return Object.fromEntries(
            entries.map(([key, entryValue]) => [
                key,
                jsonbRoundTrip(entryValue),
            ]),
        )
    }
    return value
}

const rowSchema = z.object({
    headings: z.array(z.object({ id: z.string(), content: z.string() })),
    contents: z.array(
        z.object({ heading: z.string().optional(), content: z.string() }),
    ),
})

// Compiled once and shared: no test mutates the pages.
let pages: SearchCorpusEntry[]
beforeAll(async () => {
    const compiled = await compileDocs([
        {
            path: "guide.mdx",
            kind: "text",
            content:
                "# Guide\n\nIntro paragraph.\n\n## Install\n\nRun the installer.\n\n## Verify\n\nCheck the output.\n",
        },
        {
            path: "about.mdx",
            kind: "text",
            content: "# About\n\nA plain page with no subheadings.\n",
        },
    ])
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
    pages = compiled.pages
})

describe("search corpus canonical serialization", () => {
    it("reproduces the ingest hash from a jsonb row round-trip", () => {
        const ingest = buildSearchCorpus(pages)
        // Rebuild path: rows come back key-normalized and in query order.
        const rowEntries = [...pages].reverse().map((page) => ({
            path: page.path,
            structuredData: rowSchema.parse(
                jsonbRoundTrip(page.structuredData),
            ),
        }))
        const rebuilt = buildSearchCorpus(rowEntries)
        expect(rebuilt.contentHash).toBe(ingest.contentHash)
        expect(rebuilt.json).toBe(ingest.json)
    })

    it("emits a versioned envelope that gunzips back to the entries", () => {
        const corpus = buildSearchCorpus(pages)
        const envelope = envelopeSchema.parse(
            JSON.parse(gunzipSync(corpus.gzipped).toString("utf8")),
        )
        expect(envelope.entries.map((entry) => entry.path)).toEqual(
            [...envelope.entries.map((entry) => entry.path)].sort(),
        )
        expect(envelope.entries.length).toBe(pages.length)
        const guide = envelope.entries.find(
            (entry) => entry.path === "guide.mdx",
        )
        expect(
            guide?.structuredData.headings.map((heading) => heading.content),
        ).toContain("Install")
    })
})

describe("search corpus upload", () => {
    it("uploads a random-suffixed public gzip under the corpus prefix", async () => {
        const calls: {
            pathname: string
            bytes: Uint8Array
            options: {
                access: "public"
                addRandomSuffix: boolean
                allowOverwrite: boolean
                contentType: string
            }
        }[] = []
        const url = await uploadSearchCorpus(pages, {
            namespace: "test-namespace",
            uploader: async (pathname, bytes, options) => {
                calls.push({ pathname, bytes, options })
                return { url: `https://blob.test/${pathname}-suffix` }
            },
        })
        expect(calls).toHaveLength(1)
        const call = calls[0]
        if (!call) throw new Error("uploader was not called")
        expect(call.pathname.startsWith(SEARCH_CORPUS_PREFIX)).toBe(true)
        expect(call.pathname.endsWith(".json.gz")).toBe(true)
        expect(call.options.addRandomSuffix).toBe(true)
        expect(call.options.access).toBe("public")
        expect(call.options.contentType).toBe("application/gzip")
        expect(url).toContain(SEARCH_CORPUS_PREFIX)
        // The pathname embeds the sha256 of the uploaded JSON itself
        // (debuggability + the rebuildability check in ops runbooks).
        const json = gunzipSync(Buffer.from(call.bytes)).toString("utf8")
        envelopeSchema.parse(JSON.parse(json))
        expect(call.pathname).toBe(
            `${SEARCH_CORPUS_PREFIX}test-namespace/${createHash("sha256").update(json, "utf8").digest("hex")}.json.gz`,
        )
    })
})

describe("search corpus without a blob store", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("refuses to upload when neither a token nor an uploader is configured", async () => {
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
        // Persist stores the corpus inline instead; an upload attempt here
        // would mean a no-blob install silently depended on a blob store.
        await expect(
            uploadSearchCorpus(pages, { namespace: "test-namespace" }),
        ).rejects.toThrow(/needs BLOB_READ_WRITE_TOKEN or an uploader/)
    })
})
