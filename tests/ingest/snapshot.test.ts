/**
 * readDocsDir sizes the tree before it reads it. Large files are sparse
 * (`truncate`), so they cost no disk, but a reader that loads them still
 * holds every byte in memory.
 */
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MAX_ASSET_BYTES } from "@/ingest/assets"
import { MAX_SNAPSHOT_BYTES, readDocsDir } from "@/ingest/snapshot"

let docs = ""

beforeEach(() => {
    docs = mkdtempSync(join(tmpdir(), "docs-snapshot-"))
    writeFileSync(join(docs, "index.mdx"), "# Home\n")
})

afterEach(() => {
    rmSync(docs, { recursive: true, force: true })
})

/** A sparse file of `bytes` zero bytes. */
const sparse = (path: string, bytes: number) => {
    writeFileSync(join(docs, path), "")
    truncateSync(join(docs, path), bytes)
}

describe("readDocsDir", () => {
    it("skips a media file over the per-asset cap with the asset warning", async () => {
        sparse("demo.mp4", MAX_ASSET_BYTES + 1)
        sparse("small.mp4", 1024)

        const snapshot = await readDocsDir(docs)

        expect(snapshot.files.map((file) => file.path)).toEqual([
            "index.mdx",
            "small.mp4",
        ])
        expect(snapshot.diagnostics).toEqual([
            {
                code: "asset_oversize",
                severity: "warn",
                message:
                    "Asset skipped because it exceeds the 20MB per-asset cap.",
                path: "demo.mp4",
            },
        ])
    })

    it("refuses a tree larger than the snapshot bound", async () => {
        sparse("openapi.json", MAX_SNAPSHOT_BYTES + 1)

        await expect(readDocsDir(docs)).rejects.toThrow(
            /over the 512 MB an ingest reads/,
        )
    })

    it("neither reads nor counts files the root .mintignore excludes", async () => {
        mkdirSync(join(docs, "recordings"))
        sparse("recordings/raw.json", MAX_SNAPSHOT_BYTES + 1)
        writeFileSync(join(docs, ".mintignore"), "recordings/\n")

        const snapshot = await readDocsDir(docs)

        expect(snapshot.files.map((file) => file.path)).toEqual([
            ".mintignore",
            "index.mdx",
        ])
    })
    // compileDocs re-applies the root ignore files to the snapshot, so they
    // must reach it intact: an ignore file can ignore itself and still carry
    // the negation that keeps a page another ignore file excludes.
    it("passes every root ignore file through, even one that ignores itself", async () => {
        writeFileSync(join(docs, ".docsignore"), "*.mdx\n")
        writeFileSync(join(docs, ".mintignore"), ".mintignore\n!index.mdx\n")

        const snapshot = await readDocsDir(docs)

        expect(snapshot.files.map((file) => file.path)).toEqual([
            ".docsignore",
            ".mintignore",
            "index.mdx",
        ])
    })
})
