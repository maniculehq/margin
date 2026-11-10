import { createFileRoute, redirect } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import { normalizeDocUrl } from "@/lib/agent-content"
import { siteUrlFromRequest, siteUrlOf, withBase } from "@/lib/base-path"
import {
    redirectedTwin,
    resolveDocsContext,
    resolvePage,
    sourceForActiveVersion,
} from "@/lib/source"
import { docsPageUpdatesSchema } from "@/types/docs"

const escapeXml = (value: string) =>
    // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization -- complete escape for RSS element text (& first; < > " covered); every interpolation goes through it
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")

/**
 * RSS feed for Update pages (changelogs): one per changelog, linked from an
 * "Open RSS feed" button beside "Copy page" for discoverability. One item
 * per <Update>, newest-first as authored; pages without updates 404. Reads only
 * the ingest-extracted `updates` column, never the page body.
 */
export async function getUpdatesRss(input: {
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
            ".rss.xml",
            new URL(request.url).search,
        )
        if (moved)
            throw redirect({
                href: withBase(moved.href),
                statusCode: moved.statusCode,
            })
    }
    // A plain 404 Response: the router's notFound() is for loaders, and a
    // server handler that throws it answers 500.
    if (!page || !ctx.versionId)
        return new Response("Not Found", { status: 404 })
    const [row] = await db
        .select({ updates: schema.docsPage.updates })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, ctx.versionId),
                eq(schema.docsPage.siteId, ctx.site.id),
                eq(schema.docsPage.path, page.data.sourcePath),
            ),
        )
        .limit(1)
    const updates = docsPageUpdatesSchema.nullable().parse(row?.updates ?? null)
    if (!updates) return new Response("Not Found", { status: 404 })

    const pageUrl = siteUrlOf(siteUrlFromRequest(request), page.url)
    const siteName = ctx.identity.name
    const seenAnchors = new Map<string, number>()
    const items = updates
        .map((update) => {
            // Authored rss={{title, description}} (custom per-entry feed
            // metadata) overrides the visual copy.
            const title =
                update.rss?.title ??
                update.description ??
                update.label ??
                "Update"
            const anchor = (update.label ?? "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "")
            const link = anchor ? `${pageUrl}#${anchor}` : pageUrl
            // Entries sharing a label (or lacking one) must still get
            // DISTINCT GUIDs or feed readers collapse them.
            // The link keeps the label anchor — duplicated section ids are
            // inherent to label-derived anchors.
            const occurrence = seenAnchors.get(link) ?? 0
            seenAnchors.set(link, occurrence + 1)
            const guid = occurrence === 0 ? link : `${link}::${occurrence}`
            // V8 invents years for labels like "1.4.0" (2000) or "Release 7"
            // (2001), so a parse counts only when its year is in the label.
            // ISO date-only labels parse as UTC and others in local time, so
            // either year may be the written one.
            const date = update.label ? new Date(update.label) : null
            const pubDate =
                date &&
                !Number.isNaN(date.getTime()) &&
                [date.getFullYear(), date.getUTCFullYear()].some((year) =>
                    update.label?.includes(String(year)),
                )
                    ? `<pubDate>${date.toUTCString()}</pubDate>`
                    : ""
            const categories = update.tags
                .map((tag) => `<category>${escapeXml(tag)}</category>`)
                .join("")
            const description = update.rss?.description
                ? `<description>${escapeXml(update.rss.description)}</description>`
                : ""
            return `<item><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="false">${escapeXml(guid)}</guid>${pubDate}${description}${categories}</item>`
        })
        .join("")
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(`${siteName} — ${page.data.pageTitle}`)}</title><link>${escapeXml(pageUrl)}</link><description>${escapeXml(`${page.data.pageTitle} updates`)}</description>${items}</channel></rss>`
    return new Response(xml, {
        headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": agentConfig.cache.header,
            "X-Robots-Tag": "noindex",
        },
    })
}

export const Route = createFileRoute("/{$}.rss.xml")({
    server: {
        handlers: {
            GET: getUpdatesRss,
        },
    },
})
