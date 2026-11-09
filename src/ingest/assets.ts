import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { extname, posix } from "node:path"
import { gzipSync } from "node:zlib"
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm"
import { db, schema } from "../db"
import type { Diagnostic } from "../types/docs"
import type { RawDocsAsset } from "./compile"

// Documentation can ship multi-MB recordings and GIFs. The cap bounds
// each admitted asset; optional Blob storage handles larger uploads.
export const MAX_ASSET_BYTES = 20 * 1024 * 1024
export const INLINE_ASSET_BYTES = 1024 * 1024
export const INLINE_VERSION_BYTES = 25 * 1024 * 1024
// Hot-path assets (logos, favicons, icons) stay inline even when a version
// blows its inline budget: a redirect on every logo paint is the wrong
// trade for saving a few KB of row bytes.
export const SMALL_ASSET_BYTES = 64 * 1024
// …but the exemption is itself bounded: a repository can ship hundreds of
// megabytes as thousands of tiny files, and every inline byte is a Postgres
// row. Past this aggregate, small assets fall back to the ordinary budget.
export const SMALL_ASSET_INLINE_BYTES = 8 * 1024 * 1024

/**
 * Postgres advisory-lock key (bigint) guarding this database's blob
 * namespace. Its pathnames are content-hash addressed and shared by every
 * site in the database, so every writer that uploads blobs and commits
 * references to them, and every collector that deletes them, holds
 * `pg_advisory_lock(DOCS_BLOB_LOCK_KEY)` across that whole section, on a
 * direct (non-pooled) connection — whatever its site. Other databases
 * sharing the store write under their own namespaces (resolveBlobNamespace),
 * so the lock never needs to reach them.
 */
export const DOCS_BLOB_LOCK_KEY = 7_120_455_028_316_449n

const DOCS_ASSET_PREFIX = "docs-assets/"

/**
 * The blob namespace of the database `databaseUrl` addresses, minted on first
 * use. One Blob store commonly serves several databases — production, a Neon
 * branch per preview, a developer's local Postgres — and none of them can see
 * the others' rows, so each uploads under `<prefix><namespace>/` and deletes
 * only blobs under its own namespace. Content-hash dedupe holds within it.
 *
 * The namespace is a random id stored in the database, keyed by a fingerprint
 * of its address (host, port, database name): two databases never share one
 * by chance, and a branched or restored copy, which carries its parent's
 * row, misses it under its own address and mints a fresh namespace instead
 * of collecting blobs its parent still serves.
 *
 * The address, not anything the server reports, because a copy reports what
 * its parent does (a physical copy keeps the cluster's system identifier,
 * and the server's own port and database name repeat across copies), so a
 * server-reported identity would hand a copy its parent's namespace. The
 * known aliases of one database are normalized instead: credentials and
 * query parameters are ignored, strictly matched Neon AWS pooler hosts count
 * as their endpoint's direct host, and exactly `localhost`/`[::1]` count as
 * 127.0.0.1. Generic hosts and ports are never aliased. Any other change of address mints a new
 * namespace, which leaves the old one's blobs in the store rather than
 * deleting anything; keep every writer of a database on one address.
 */
export async function resolveBlobNamespace(
    databaseUrl: string,
): Promise<string> {
    const url = new URL(databaseUrl)
    const host = url.hostname
        .toLowerCase()
        .replace(
            /^(ep-[a-z0-9]+(?:-[a-z0-9]+)*)-pooler\.([a-z]{2}-[a-z]+-[0-9]+\.aws\.neon\.tech)$/,
            "$1.$2",
        )
    const port = url.port || "5432"
    const databaseFingerprint = createHash("sha256")
        .update(
            `${["localhost", "[::1]"].includes(host) ? "127.0.0.1" : host}:${port}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`,
        )
        .digest("hex")
    await db
        .insert(schema.docsBlobNamespace)
        .values({ databaseFingerprint, namespace: randomUUID() })
        .onConflictDoNothing({
            target: schema.docsBlobNamespace.databaseFingerprint,
        })
    const [row] = await db
        .select({ namespace: schema.docsBlobNamespace.namespace })
        .from(schema.docsBlobNamespace)
        .where(
            eq(
                schema.docsBlobNamespace.databaseFingerprint,
                databaseFingerprint,
            ),
        )
    if (!row) throw new Error("could not resolve the blob namespace")
    return row.namespace
}

const RASTER_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
])

const MIME_TYPES: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    // ttf/otf are not in the tarball admit-list — they exist for the
    // ingest-fetched Google Font binaries the OG renderer consumes
    // (satori reads ttf/otf, not woff2).
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
}

const ASSET_EXTENSION =
    /\.(?:png|jpe?g|svg|webp|gif|ico|woff2?|mp4|webm|mov)(?:[?#].*)?$/i
const SAFE_EMBEDDED_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i

/** Exported for reuse by document-assets.ts (deepdive/cookbook editor screenshots). */
export function sanitizeSvg(bytes: Uint8Array): Uint8Array | null {
    let svg: string
    try {
        svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
        return null
    }
    if (!/<(?:[A-Za-z_][\w.-]*:)?svg(?:\s|>)/i.test(svg)) return null

    const safeReference = (value: string): boolean => {
        const normalized = value.trim()
        return (
            normalized.startsWith("#") || SAFE_EMBEDDED_IMAGE.test(normalized)
        )
    }
    const hasUnsafeCssReference = (value: string): boolean => {
        if (/@import|javascript\s*:/i.test(value)) return true
        for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
            if (!safeReference(match[2] ?? "")) return true
        }
        return false
    }

    svg = svg
        .replace(/<!DOCTYPE[\s\S]*?(?:\]>|>)/gi, "")
        .replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, "")
        .replace(
            /<(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)\s*>/gi,
            "",
        )
        .replace(
            /<(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)\b[^>]*\/\s*>/gi,
            "",
        )
        .replace(
            /\s+(?:[A-Za-z_][\w.-]*:)?on[A-Za-z_][\w.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
            "",
        )
        .replace(
            /\s+(?:(?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
            (attribute, doubleQuoted, singleQuoted, unquoted) =>
                safeReference(doubleQuoted ?? singleQuoted ?? unquoted ?? "")
                    ? attribute
                    : "",
        )
        .replace(/\s+xml:base\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(
            /\s+style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
            (attribute, doubleQuoted, singleQuoted, unquoted) =>
                hasUnsafeCssReference(
                    doubleQuoted ?? singleQuoted ?? unquoted ?? "",
                )
                    ? ""
                    : attribute,
        )
        .replace(
            /<(?:[A-Za-z_][\w.-]*:)?style\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?style\s*>/gi,
            (element, css) => (hasUnsafeCssReference(css ?? "") ? "" : element),
        )
        .replace(
            /\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
            (attribute, doubleQuoted, singleQuoted, unquoted) =>
                hasUnsafeCssReference(
                    doubleQuoted ?? singleQuoted ?? unquoted ?? "",
                )
                    ? ""
                    : attribute,
        )
        .replace(
            /<(?:[A-Za-z_][\w.-]*:)?(?:animate|set)\b(?=[^>]*\battributeName\s*=\s*["']?(?:(?:xlink:)?href|src)\b)[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?(?:animate|set)\s*>)/gi,
            "",
        )

    return new TextEncoder().encode(svg)
}

export interface PreparedAsset {
    path: string
    contentHash: string
    mimeType: string
    byteSize: number
    bytes: Uint8Array | null
    blobUrl: string | null
    /** Intrinsic pixel size, measured at ingest so served <img> tags carry
     * width/height (no layout shift). Null for non-images and unreadable
     * files. */
    width: number | null
    height: number | null
}

export type AssetReferenceResolution =
    | { kind: "asset"; url: string }
    | { kind: "missing"; path: string }
    | { kind: "external"; allowed: boolean }
    | { kind: "other" }

export async function prepareAssets(raw: RawDocsAsset[]): Promise<{
    assets: PreparedAsset[]
    diagnostics: Diagnostic[]
}> {
    const assets: PreparedAsset[] = []
    const diagnostics: Diagnostic[] = []
    for (const asset of raw) {
        if (asset.bytes.byteLength > MAX_ASSET_BYTES) {
            diagnostics.push({
                code: "asset_oversize",
                severity: "warn",
                message: `Asset skipped because it exceeds the 20MB per-asset cap.`,
                path: asset.path,
            })
            continue
        }
        const extension = extname(asset.path).toLowerCase()
        const mimeType = MIME_TYPES[extension]
        if (!mimeType) continue
        const bytes =
            mimeType === "image/svg+xml"
                ? sanitizeSvg(asset.bytes)
                : asset.bytes
        if (!bytes) {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: "SVG asset skipped because it is not valid UTF-8 SVG.",
                path: asset.path,
            })
            continue
        }
        let width: number | null = null
        let height: number | null = null
        if (RASTER_MIME_TYPES.has(mimeType)) {
            // Outside the try: a missing native binary fails the ingest;
            // only a corrupt image is served without dimensions.
            const { default: sharp } = await import("sharp")
            try {
                const metadata = await sharp(bytes).metadata()
                // EXIF orientation 5-8 rotates the rendered image by 90°:
                // the browser (image-orientation: from-image) paints the
                // swapped box, so the stored dimensions must swap too.
                const rotated = (metadata.orientation ?? 1) >= 5
                // Animated GIF/WebP: sharp stacks every frame into `height`
                // and reports the displayed frame as `pageHeight`.
                const frameHeight = metadata.pageHeight ?? metadata.height
                width = rotated ? frameHeight : metadata.width
                height = rotated ? metadata.width : frameHeight
            } catch {
                // Unreadable/corrupt image: served without dimensions.
            }
        } else if (mimeType === "image/svg+xml") {
            const root = /<(?:[A-Za-z_][\w.-]*:)?svg\b([^>]*)>/i.exec(
                new TextDecoder().decode(bytes),
            )?.[1]
            const attr = (name: string) =>
                // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `name` is the literal "width" or "height" at both call sites
                new RegExp(
                    `\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`,
                    "i",
                ).exec(root ?? "")?.[1]
            const explicitWidth = Number(attr("width"))
            const explicitHeight = Number(attr("height"))
            if (explicitWidth > 0 && explicitHeight > 0) {
                width = Math.round(explicitWidth)
                height = Math.round(explicitHeight)
            } else {
                const viewBox = /\sviewBox\s*=\s*["']([^"']+)["']/i
                    .exec(root ?? "")?.[1]
                    ?.trim()
                    .split(/[\s,]+/)
                    .map(Number)
                if (
                    viewBox?.length === 4 &&
                    viewBox.every(Number.isFinite) &&
                    (viewBox[2] ?? 0) > 0 &&
                    (viewBox[3] ?? 0) > 0
                ) {
                    width = Math.round(viewBox[2] ?? 0)
                    height = Math.round(viewBox[3] ?? 0)
                }
            }
        }
        assets.push({
            path: asset.path.replaceAll("\\", "/").replace(/^\.\//, ""),
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            mimeType,
            byteSize: bytes.byteLength,
            bytes,
            blobUrl: null,
            width: width ?? null,
            height: height ?? null,
        })
    }
    return { assets, diagnostics }
}

export function isAssetShapedReference(value: string): boolean {
    return ASSET_EXTENSION.test(value)
}

export function isAllowedExternalAssetUrl(
    value: string,
    allowedHosts: string[],
): boolean {
    const hosts = new Set(
        ["fonts.googleapis.com", "fonts.gstatic.com", ...allowedHosts].map(
            (host) => {
                try {
                    return new URL(
                        host.includes("://") ? host : `https://${host}`,
                    ).hostname.toLowerCase()
                } catch {
                    return host.toLowerCase()
                }
            },
        ),
    )
    try {
        const url = new URL(value.startsWith("//") ? `https:${value}` : value)
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            hosts.has(url.hostname.toLowerCase())
        )
    } catch {
        return false
    }
}

export function resolveAssetReference(input: {
    value: string
    sourcePath: string
    assetHashes: ReadonlyMap<string, string>
    allowedHosts: string[]
}): AssetReferenceResolution {
    const value = input.value.trim()
    if (value.startsWith("/_assets/") || value.startsWith("#"))
        return { kind: "other" }
    if (/^(?:https?:)?\/\//i.test(value)) {
        return {
            kind: "external",
            allowed: isAllowedExternalAssetUrl(value, input.allowedHosts),
        }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: "other" }

    const suffixIndex = value.search(/[?#]/)
    const pathname = suffixIndex === -1 ? value : value.slice(0, suffixIndex)
    const suffix = suffixIndex === -1 ? "" : value.slice(suffixIndex)
    const resolved = posix.normalize(
        pathname.startsWith("/")
            ? pathname.slice(1)
            : posix.join(posix.dirname(input.sourcePath), pathname),
    )
    const contentHash = input.assetHashes.get(resolved)
    if (contentHash)
        return { kind: "asset", url: `/_assets/${contentHash}${suffix}` }
    if (isAssetShapedReference(value))
        return { kind: "missing", path: resolved }
    return { kind: "other" }
}

export type AssetUploader = (
    pathname: string,
    bytes: Uint8Array,
    options: {
        access: "public"
        addRandomSuffix: boolean
        allowOverwrite: boolean
        cacheControlMaxAge: number
        contentType: string
    },
) => Promise<{ url: string }>

/**
 * Move assets that are too large to keep inline into a blob store, returning
 * every asset with either inline `bytes` or a `blobUrl`.
 *
 * Without a blob store — no `uploader` and no `BLOB_READ_WRITE_TOKEN` — every
 * asset stays inline in Postgres up to MAX_ASSET_BYTES each (prepareAssets
 * already skipped anything larger), so an install with only a database
 * serves every asset. With one, assets over INLINE_ASSET_BYTES (and all
 * non-small assets once a version passes INLINE_VERSION_BYTES) go to
 * content-hash-addressed public blobs under the database's `namespace`
 * (resolveBlobNamespace).
 */
export async function uploadLargeAssets(
    assets: PreparedAsset[],
    opts: {
        namespace: string
        uploader?: AssetUploader
        dedupeExisting?: boolean
    },
): Promise<PreparedAsset[]> {
    if (!opts.uploader && !process.env.BLOB_READ_WRITE_TOKEN) return assets
    // Sum per ROW, not per unique hash: rows are per source path since
    // pipeline v7, and inline bytes are stored per row — byte-identical
    // sibling paths would otherwise let stored inline bytes exceed the
    // budget arbitrarily while the unique-hash sum stayed under it
    // (review finding). Uploads themselves stay hash-deduped below.
    // Small assets stay inline unconditionally up to their own aggregate
    // allowance (SMALL_ASSET_INLINE_BYTES, summed in source order so the
    // hot-path logos and icons near the top of a repo keep the exemption);
    // once it is spent they rejoin the ordinary budget below.
    let smallInlineBytes = 0
    const smallExempt = new Set<PreparedAsset>()
    for (const asset of assets) {
        if (asset.byteSize > SMALL_ASSET_BYTES) continue
        if (smallInlineBytes + asset.byteSize > SMALL_ASSET_INLINE_BYTES)
            continue
        smallInlineBytes += asset.byteSize
        smallExempt.add(asset)
    }
    const uploadAll =
        assets.reduce(
            (total, asset) =>
                smallExempt.has(asset) ? total : total + asset.byteSize,
            0,
        ) > INLINE_VERSION_BYTES
    const inline = (asset: PreparedAsset) =>
        smallExempt.has(asset) ||
        (!uploadAll && asset.byteSize <= INLINE_ASSET_BYTES)
    // Uploads are content-hash deduped: byte-identical sibling paths share
    // one blob, so each unique hash is put at most once.
    const pending = new Map<
        string,
        { pathname: string; bytes: Uint8Array; contentType: string }
    >()
    for (const asset of assets) {
        if (inline(asset) || pending.has(asset.contentHash)) continue
        if (!asset.bytes)
            throw new Error(`asset ${asset.path} has no bytes to upload`)
        pending.set(asset.contentHash, {
            pathname: `${DOCS_ASSET_PREFIX}${opts.namespace}/${asset.contentHash}${extname(asset.path).toLowerCase()}`,
            bytes: asset.bytes,
            contentType: asset.mimeType,
        })
    }
    const uploadedByHash = new Map<string, string>()
    // Blobs are content-hash addressed, so a pathname that already exists IS
    // the payload we were about to send. Probing exactly the upload set lets
    // repeat ingests skip hundreds of MB of redundant puts without listing
    // the whole namespace.
    // Best-effort: a failed probe falls through to the put, which still
    // settles via allowOverwrite.
    if (
        opts.dedupeExisting &&
        pending.size > 0 &&
        process.env.BLOB_READ_WRITE_TOKEN
    ) {
        const { BlobNotFoundError, head } = await import("@vercel/blob")
        const probes = [...pending]
        for (let i = 0; i < probes.length; i += 20) {
            const batch = probes.slice(i, i + 20)
            const results = await Promise.allSettled(
                batch.map(([, upload]) => head(upload.pathname)),
            )
            for (const [index, result] of results.entries()) {
                const hash = batch[index]?.[0]
                if (hash === undefined) continue
                if (result.status === "fulfilled") {
                    uploadedByHash.set(hash, result.value.url)
                    pending.delete(hash)
                } else if (!(result.reason instanceof BlobNotFoundError)) {
                    console.warn(
                        `[uploadLargeAssets] blob probe failed (uploading): ${
                            result.reason instanceof Error
                                ? result.reason.message
                                : String(result.reason)
                        }`,
                    )
                }
            }
        }
    }
    const uploader =
        opts.uploader ??
        (async (pathname, bytes, options) => {
            const { put } = await import("@vercel/blob")
            return put(pathname, Buffer.from(bytes), options)
        })
    // Bounded waves: upload wall time tracks the slowest put in each wave
    // instead of the sum of every put. allSettled lets a wave finish before
    // a failure rejects the step (Workflow retries it), so no put is left
    // running unobserved behind the rejection.
    const uploads = [...pending]
    for (let i = 0; i < uploads.length; i += 8) {
        const wave = uploads.slice(i, i + 8)
        const results = await Promise.allSettled(
            wave.map(([, upload]) =>
                uploader(upload.pathname, upload.bytes, {
                    access: "public",
                    addRandomSuffix: false,
                    allowOverwrite: true,
                    cacheControlMaxAge: 31_536_000,
                    contentType: upload.contentType,
                }),
            ),
        )
        for (const [index, result] of results.entries()) {
            const hash = wave[index]?.[0]
            if (hash !== undefined && result.status === "fulfilled")
                uploadedByHash.set(hash, result.value.url)
        }
        const rejected = results.find((result) => result.status === "rejected")
        if (rejected) throw rejected.reason
    }
    return assets.map((asset) => {
        if (inline(asset)) return asset
        const blobUrl = uploadedByHash.get(asset.contentHash)
        if (!blobUrl) throw new Error(`asset ${asset.path} was not uploaded`)
        return { ...asset, bytes: null, blobUrl }
    })
}

/**
 * Structural supertype of fumadocs' StructuredData: compile output declares
 * contents[].heading as required-but-undefinable while the rebuild script's
 * zod parse of docs_page rows makes it optional — both assign here.
 */
export interface SearchCorpusEntry {
    path: string
    structuredData: {
        headings: readonly { id: string; content: string }[]
        contents: readonly {
            heading?: string | undefined
            content: string
        }[]
    }
}

export const SEARCH_CORPUS_FORMAT_VERSION = 1
export const SEARCH_CORPUS_PREFIX = "docs-search/"

/** Deterministic, rebuildable search corpus for the framework. Fixed field
 * order and path sorting let ingest and row-based rebuild produce identical
 * bytes without making the blob authoritative. */
export function buildSearchCorpus(entries: readonly SearchCorpusEntry[]): {
    json: string
    contentHash: string
    gzipped: Buffer
} {
    const canonical = entries
        .map((entry) => ({
            path: entry.path,
            structuredData: {
                headings: entry.structuredData.headings.map((heading) => ({
                    id: heading.id,
                    content: heading.content,
                })),
                contents: entry.structuredData.contents.map((content) =>
                    content.heading === undefined
                        ? { content: content.content }
                        : {
                              heading: content.heading,
                              content: content.content,
                          },
                ),
            },
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const json = JSON.stringify({
        formatVersion: SEARCH_CORPUS_FORMAT_VERSION,
        entries: canonical,
    })
    return {
        json,
        contentHash: createHash("sha256").update(json, "utf8").digest("hex"),
        gzipped: gzipSync(Buffer.from(json, "utf8")),
    }
}

/**
 * Upload a version's search corpus to the public docs blob store (installs
 * without one store the corpus inline — PersistSearchCorpus). The
 * content hash in the pathname is debuggability only — addRandomSuffix
 * makes every upload's URL unique per build, so corpus blobs are never
 * shared across version rows and every stored URL can be deleted
 * unconditionally with its row (no refcounting, and no race against a
 * concurrent build's not-yet-committed row referencing the same bytes).
 * It is written under the database's `namespace`: a branched copy of the
 * database carries rows pointing at its parent's corpora, and collects only
 * its own.
 */
export async function uploadSearchCorpus(
    entries: readonly SearchCorpusEntry[],
    opts: { namespace: string; uploader?: AssetUploader },
): Promise<string> {
    const corpus = buildSearchCorpus(entries)
    if (!opts.uploader && !process.env.BLOB_READ_WRITE_TOKEN)
        throw new Error(
            "uploadSearchCorpus needs BLOB_READ_WRITE_TOKEN or an uploader; store the corpus inline instead",
        )
    const uploader =
        opts.uploader ??
        (async (pathname, bytes, options) => {
            const { put } = await import("@vercel/blob")
            return put(pathname, Buffer.from(bytes), options)
        })
    const uploaded = await uploader(
        `${SEARCH_CORPUS_PREFIX}${opts.namespace}/${corpus.contentHash}.json.gz`,
        corpus.gzipped,
        {
            access: "public",
            addRandomSuffix: true,
            allowOverwrite: false,
            cacheControlMaxAge: 31_536_000,
            contentType: "application/gzip",
        },
    )
    return uploaded.url
}

/**
 * Delete the blobs of the versions garbage collection is about to drop and
 * return the ids whose rows may go: a doomed version's blobs go before its
 * rows, and its rows only once its blobs are gone, because the rows are the
 * only record of what to delete. Without a token the blobs cannot be
 * deleted, so such versions stay. Asset blobs are content-hash addressed and
 * shared, so only those no surviving version references are deleted. Only
 * blobs under this database's `namespace` are deleted, or hold a version
 * back: a branched or restored copy's rows can point at its parent's blobs,
 * which the parent may still serve. The caller holds DOCS_BLOB_LOCK_KEY.
 */
export async function deleteDoomedVersionBlobs(
    versionIds: string[],
    namespace: string,
): Promise<string[]> {
    if (versionIds.length === 0) return versionIds
    const [doomedCorpora, doomedAssets] = await Promise.all([
        db
            .select({
                versionId: schema.docsContentVersion.id,
                url: schema.docsContentVersion.searchCorpusUrl,
            })
            .from(schema.docsContentVersion)
            .where(
                and(
                    inArray(schema.docsContentVersion.id, versionIds),
                    isNotNull(schema.docsContentVersion.searchCorpusUrl),
                ),
            ),
        db
            .select({
                versionId: schema.docsAsset.versionId,
                url: schema.docsAsset.blobUrl,
            })
            .from(schema.docsAsset)
            .where(
                and(
                    inArray(schema.docsAsset.versionId, versionIds),
                    isNotNull(schema.docsAsset.blobUrl),
                ),
            ),
    ])
    const ownedPrefixes = [
        `/${DOCS_ASSET_PREFIX}${namespace}/`,
        `/${SEARCH_CORPUS_PREFIX}${namespace}/`,
    ]
    const owned = [...doomedCorpora, ...doomedAssets].flatMap(
        ({ versionId, url }) =>
            url &&
            URL.canParse(url) &&
            ownedPrefixes.some((prefix) =>
                new URL(url).pathname.startsWith(prefix),
            )
                ? [{ versionId, url }]
                : [],
    )
    const blobBacked = new Set(owned.map((row) => row.versionId))
    if (blobBacked.size === 0) return versionIds
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        console.warn(
            `[ingest] kept ${blobBacked.size} old version(s) whose blobs cannot be deleted without BLOB_READ_WRITE_TOKEN`,
        )
        return versionIds.filter((id) => !blobBacked.has(id))
    }
    const urls = new Set(owned.map((row) => row.url))
    const stillReferenced = await db
        .select({ url: schema.docsAsset.blobUrl })
        .from(schema.docsAsset)
        .where(
            and(
                inArray(schema.docsAsset.blobUrl, [...urls]),
                notInArray(schema.docsAsset.versionId, versionIds),
            ),
        )
    for (const row of stillReferenced) if (row.url) urls.delete(row.url)
    try {
        if (urls.size > 0) {
            const { del } = await import("@vercel/blob")
            await del([...urls])
        }
    } catch (error) {
        console.warn(
            `[ingest] kept ${blobBacked.size} old version(s): deleting their blobs failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return versionIds.filter((id) => !blobBacked.has(id))
    }
    return versionIds
}

/**
 * Delete blobs an ingest left behind (a corpus uploaded for a commit that was
 * already ingested, or the blobs of a version --force replaced) that no row
 * references, under this database's `namespace` (a version --force replaced
 * in a branched copy can point at its parent's blobs). A failed delete only
 * leaks, so it warns. The caller holds DOCS_BLOB_LOCK_KEY.
 */
export async function deleteUnreferencedBlobs(
    candidates: ReadonlySet<string>,
    namespace: string,
): Promise<void> {
    if (candidates.size === 0 || !process.env.BLOB_READ_WRITE_TOKEN) return
    const ownedPrefixes = [
        `/${DOCS_ASSET_PREFIX}${namespace}/`,
        `/${SEARCH_CORPUS_PREFIX}${namespace}/`,
    ]
    const leftovers = new Set(
        [...candidates].filter(
            (url) =>
                URL.canParse(url) &&
                ownedPrefixes.some((prefix) =>
                    new URL(url).pathname.startsWith(prefix),
                ),
        ),
    )
    if (leftovers.size === 0) return
    const referenced = await db
        .select({ url: schema.docsAsset.blobUrl })
        .from(schema.docsAsset)
        .where(inArray(schema.docsAsset.blobUrl, [...leftovers]))
    for (const row of referenced) if (row.url) leftovers.delete(row.url)
    if (leftovers.size === 0) return
    const { del } = await import("@vercel/blob")
    try {
        await del([...leftovers])
    } catch (error) {
        console.warn(
            `[ingest] could not delete ${leftovers.size} unreferenced blob(s); they stay in the store: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}
