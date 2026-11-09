/**
 * Blob storage has one owner. `src/ingest/assets.ts` uploads docs assets and
 * search corpora to the public blob store, content-hash addressed, and every
 * row that points at a blob is written by the ingest that uploaded it. A
 * second module talking to `@vercel/blob` directly is how a blob ends up
 * with no row and no way to be found again. Allow-list entries are a
 * deliberate, reviewable act.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")

// This file names the forbidden specifier, so it is never scanned.
const SELF = "tests/conventions/storage.test.ts"

// The ONLY files allowed to import @vercel/blob (static or dynamic).
const BLOB_IMPORT_ALLOWLIST = new Set([
    // Uploads docs assets and the search corpus, and deletes the blobs no
    // row references any more.
    "src/ingest/assets.ts",
])

const sources = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
)
    .split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && file !== SELF)
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }))

const BLOB_IMPORT =
    /\b(?:from|import|require)\s*\(?\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]/

const blobImporters = sources
    .filter(({ text }) => BLOB_IMPORT.test(text))
    .map(({ file }) => file)

describe("storage conventions", () => {
    it("scans the package's sources", () => {
        const scanned = sources.map(({ file }) => file)
        expect(scanned).toContain("src/ingest/assets.ts")
        expect(scanned).toContain("scripts/ingest.ts")
    })

    it("imports @vercel/blob only from allow-listed files", () => {
        expect(
            blobImporters.filter((file) => !BLOB_IMPORT_ALLOWLIST.has(file)),
        ).toEqual([])
    })

    it("holds no allow-list entry that no longer imports @vercel/blob", () => {
        expect(
            [...BLOB_IMPORT_ALLOWLIST].filter(
                (file) => !blobImporters.includes(file),
            ),
        ).toEqual([])
    })
})
