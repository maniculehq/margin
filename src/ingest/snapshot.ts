/**
 * The files of a docs tree, read from disk at build time. Paths are relative
 * to the docs root with `/` separators.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import ignore from "ignore"
import type { Diagnostic } from "../types/docs"
import { MAX_ASSET_BYTES } from "./assets"

export type DocsSnapshotFile =
    | { path: string; kind: "text"; content: string }
    | { path: string; kind: "binary"; bytes: Uint8Array }

/** Files the pipeline reads: pages, config, styles, media, fonts and JS
 * snippets. Everything else in the tree is ignored. */
const ADMITTED =
    /^(?:snippets\/.*\.(?:js|jsx|ts|tsx)|.*\.(?:mdx|md|json|ya?ml|css|png|jpe?g|svg|webp|gif|ico|woff2?|mp4|webm|mov))$/i
const IGNORE_FILE = /^\.(mintignore|docsignore)$/i
const SKILL_FILE = /^\.mintlify\/skills\/[^/.][^/]*\/SKILL\.md$/
const TEXT = /\.(mdx|md|json|ya?ml|css)$/i
const SNIPPET_SCRIPT = /^snippets\/.*\.(js|jsx|ts|tsx)$/i

/** Upper bound on the bytes one ingest reads into memory: the admitted files
 * that survive the ignore files and the per-asset cap. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024

/**
 * Read a docs directory into snapshot files. Hidden files and directories are
 * skipped, except the ignore files and
 * `.mintlify/skills/<name>/SKILL.md`. `node_modules` and hidden directories
 * other than `.mintlify` are never descended into, so a docs root at the
 * repository root does not walk the dependency tree.
 *
 * Sizes are checked before anything is read: files the root ignore files
 * exclude are never read, a media file over the per-asset cap is skipped with
 * the warning prepareAssets gives, and a tree whose remaining files exceed
 * MAX_SNAPSHOT_BYTES fails with an error instead of exhausting memory.
 */
export async function readDocsDir(dir: string): Promise<{
    files: DocsSnapshotFile[]
    diagnostics: Diagnostic[]
}> {
    const candidates: {
        path: string
        full: string
        size: number
        text: boolean
    }[] = []
    const pending = [dir]
    for (let current = pending.pop(); current; current = pending.pop()) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = join(current, entry.name)
            if (entry.isDirectory()) {
                if (entry.name === "node_modules") continue
                if (entry.name.startsWith(".") && entry.name !== ".mintlify")
                    continue
                pending.push(full)
                continue
            }
            if (!entry.isFile()) continue
            const path = relative(dir, full).split(sep).join("/")
            if (!ADMITTED.test(path) && !IGNORE_FILE.test(entry.name)) continue
            if (
                !SKILL_FILE.test(path) &&
                path
                    .split("/")
                    .some(
                        (segment) =>
                            segment.startsWith(".") &&
                            !IGNORE_FILE.test(segment),
                    )
            )
                continue
            candidates.push({
                path,
                full,
                size: (await stat(full)).size,
                text:
                    TEXT.test(entry.name) ||
                    SNIPPET_SCRIPT.test(path) ||
                    IGNORE_FILE.test(entry.name),
            })
        }
    }

    // compileDocs applies the same root ignore files; applying them here
    // too keeps excluded media out of memory and out of the size bound.
    const ignoreFiles = candidates
        .filter((file) => IGNORE_FILE.test(file.path))
        .sort((a, b) => a.path.localeCompare(b.path))
    const ignoreMatcher = ignore()
    for (const file of ignoreFiles)
        ignoreMatcher.add(await readFile(file.full, "utf8"))

    const diagnostics: Diagnostic[] = []
    let total = 0
    const admitted = candidates.filter((file) => {
        // The ignore files themselves always pass: compileDocs re-reads
        // their rules, and one may ignore itself while carrying a negation.
        if (!IGNORE_FILE.test(file.path) && ignoreMatcher.ignores(file.path))
            return false
        if (!file.text && file.size > MAX_ASSET_BYTES) {
            diagnostics.push({
                code: "asset_oversize",
                severity: "warn",
                message: `Asset skipped because it exceeds the 20MB per-asset cap.`,
                path: file.path,
            })
            return false
        }
        total += file.size
        return true
    })
    if (total > MAX_SNAPSHOT_BYTES)
        throw new Error(
            `${dir} holds ${Math.ceil(total / 1024 / 1024)} MB of docs files, over the ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB an ingest reads: exclude large files with a .mintignore at the docs root`,
        )

    const files: DocsSnapshotFile[] = []
    for (const file of admitted)
        files.push(
            file.text
                ? {
                      path: file.path,
                      kind: "text",
                      content: await readFile(file.full, "utf8"),
                  }
                : {
                      path: file.path,
                      kind: "binary",
                      bytes: await readFile(file.full),
                  },
        )
    // Deterministic order: readdir's order varies by filesystem.
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, diagnostics }
}
