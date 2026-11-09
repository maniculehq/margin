import { createHash } from "node:crypto"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { and, eq, inArray } from "drizzle-orm"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import { normalizeDocUrl, suggestClosestPages } from "@/lib/agent-content"
import { siteUrlFromRequest, withBase } from "@/lib/base-path"
import {
    redirectedTwin,
    resolveDocsContext,
    resolvePage,
    sourceForActiveVersion,
} from "@/lib/source"
import { formatDocsPath } from "@/types/docs"

/** Human-facing PDF route using the same page resolution as `.md`. It renders
 * the stored human rendition (snippets and variables resolved at ingest,
 * agent-only blocks removed), not `processedMarkdown`, and
 * uses a version/path ETag plus the cache tag so content flips invalidate it. */
export async function getDocsPdf(input: {
    request: Request
    params: { _splat?: string }
}): Promise<Response> {
    const { request, params } = input
    const slugs = normalizeDocUrl(params._splat ?? "")
    const ctx = await resolveDocsContext(request, slugs)
    const source = await sourceForActiveVersion(ctx, slugs)
    const page = await resolvePage(ctx, source, slugs)

    if (!page) {
        const moved = redirectedTwin(
            ctx,
            slugs,
            ".pdf",
            new URL(request.url).search,
        )
        if (moved)
            throw redirect({
                href: withBase(moved.href),
                statusCode: moved.statusCode,
            })
    }
    // Recovery-oriented 404, like the .md route (plain text — no PDF body).
    if (!page) {
        const candidates = suggestClosestPages(ctx, slugs)
        const body =
            `No documentation page matches "${params._splat ?? ""}".\n\n` +
            `Closest matches:\n` +
            candidates
                .map((c) => `- ${c.title} (${withBase(c.url)})`)
                .join("\n") +
            "\n"
        return new Response(body, {
            status: 404,
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": agentConfig.cache.header,
            },
        })
    }

    // Loaded on demand: @react-pdf, fontkit and pdfkit are ~4 MB of module
    // source that no other route touches, and a static import made every
    // cold start of the function parse them.
    const {
        PDF_RENDERER_VERSION,
        parsePageMarkdown,
        renderPagePdf,
        splitImageReferences,
        stripAgentBlocks,
    } = await import("@/lib/page-pdf")

    // Stable identity ETag: the (content version, page path) pair pins the
    // exact immutable artifact, so no body render is needed to answer a
    // 304. PDF_RENDERER_VERSION joins the hash so a deployment that changes
    // the renderer (fonts, layout, filtering) invalidates prior downloads —
    // cache-tag purges only fire on content flips. The site's URL joins it
    // too: the document prints the page's address, which changes without a
    // new version when a domain is attached.
    const siteUrl = siteUrlFromRequest(request)
    const etag = `"${createHash("sha256")
        .update(
            `${ctx.versionId}:${page.data.sourcePath}:r${PDF_RENDERER_VERSION}:${siteUrl}`,
        )
        .digest("hex")
        .slice(0, 32)}"`
    // RFC 5987/6266 filename: header values must stay Latin-1 (undici throws
    // on anything else — a unicode slug would 500). ASCII fallback in
    // `filename`, the real name percent-encoded in `filename*`.
    const slug = page.slugs[page.slugs.length - 1] ?? "index"
    const asciiSlug =
        slug.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "page"
    const encodedSlug = encodeURIComponent(slug).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    const headers: Record<string, string> = {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${asciiSlug}.pdf"; filename*=UTF-8''${encodedSlug}.pdf`,
        ETag: etag,
        "Cache-Control":
            "public, s-maxage=86400, stale-while-revalidate=604800",
        // The human page is the canonical spelling; keep the .pdf duplicate
        // out of the index, like the .md route. encodeURI keeps a unicode
        // slug out of the header (values must stay Latin-1).
        Link: `<${encodeURI(withBase(formatDocsPath(page.url, ctx.seo.trailingSlash)))}>; rel="canonical"`,
        "X-Robots-Tag": "noindex",
    }
    if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers })
    }

    // The stored human rendition, filtered to the human audience — see the module
    // doc above for why processedMarkdown (the agent rendition) is wrong.
    const markdown = stripAgentBlocks(await page.data.getText("raw"))
    const root = parsePageMarkdown(markdown, page.data.sourcePath)

    // Embed only version-scoped docs_asset rows, resolved by rewritten hash
    // or authored repo path. Never fetch author-supplied URLs; unsupported image types
    // remain alt text.
    const { hashByUrl, pathByUrl } = splitImageReferences(
        root,
        page.data.sourcePath,
    )
    // One version-scoped query for every authored path — a page with dozens
    // of local images must not issue that many sequential round trips.
    if (pathByUrl.size > 0 && ctx.versionId) {
        const rows = await db
            .select({
                path: schema.docsAsset.path,
                contentHash: schema.docsAsset.contentHash,
            })
            .from(schema.docsAsset)
            .where(
                and(
                    eq(schema.docsAsset.siteId, ctx.site.id),
                    eq(schema.docsAsset.versionId, ctx.versionId),
                    inArray(schema.docsAsset.path, [
                        ...new Set(pathByUrl.values()),
                    ]),
                ),
            )
        const hashByPath = new Map(
            rows.map((row) => [row.path, row.contentHash]),
        )
        for (const [url, path] of pathByUrl) {
            const pathHash = hashByPath.get(path)
            if (pathHash) hashByUrl.set(url, pathHash.toLowerCase())
        }
    }
    const images = new Map<string, string>()
    if (hashByUrl.size > 0 && ctx.versionId) {
        const rows = await db
            .select({
                contentHash: schema.docsAsset.contentHash,
                bytes: schema.docsAsset.bytes,
                blobUrl: schema.docsAsset.blobUrl,
                mimeType: schema.docsAsset.mimeType,
            })
            .from(schema.docsAsset)
            .where(
                and(
                    eq(schema.docsAsset.siteId, ctx.site.id),
                    eq(schema.docsAsset.versionId, ctx.versionId),
                    inArray(schema.docsAsset.contentHash, [
                        ...new Set(hashByUrl.values()),
                    ]),
                    // Only rasters pdfkit can embed: an SVG or GIF row's
                    // bytea never leaves Postgres (it stays alt text).
                    inArray(schema.docsAsset.mimeType, [
                        "image/png",
                        "image/jpeg",
                        "image/jpg",
                    ]),
                ),
            )
        const rowByHash = new Map(rows.map((row) => [row.contentHash, row]))
        for (const [url, hash] of hashByUrl) {
            const row = rowByHash.get(hash)
            if (!row) continue
            if (row.bytes) {
                images.set(
                    url,
                    `data:${row.mimeType};base64,${Buffer.from(row.bytes).toString("base64")}`,
                )
            } else if (row.blobUrl) {
                images.set(url, row.blobUrl)
            }
        }
    }

    const pageUrl = siteUrl + formatDocsPath(page.url, ctx.seo.trailingSlash)
    const bytes = await renderPagePdf({
        title: page.data.pageTitle,
        url: pageUrl,
        root,
        images,
    })
    return new Response(bytes, { headers })
}

export const Route = createFileRoute("/{$}.pdf")({
    server: {
        handlers: {
            GET: getDocsPdf,
        },
    },
})
