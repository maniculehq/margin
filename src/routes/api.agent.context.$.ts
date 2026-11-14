import { createFileRoute } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db, schema } from "@/db"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import {
    externalPointer,
    getLLMText,
    normalizeDocUrl,
    pageBreadcrumbs,
    pageEtag,
    relatedPages,
    slugsToMarkdownPath,
    suggestClosestPages,
} from "@/lib/agent-content"
import { siteUrlFromRequest } from "@/lib/base-path"
import {
    agentBody,
    resolveDocsContext,
    resolvePage,
    sourceForActiveVersion,
    structuredDataSchema,
} from "@/lib/source"
import { docsCodeExamplesSchema } from "@/types/docs"

/** The full view's one markdown cap; `truncated` reports when it bit. */
const MARKDOWN_CAP = 60_000

/** One low-cardinality variant, so each view is one CDN entry per page; an
 * unknown value serves the full bundle. */
const viewSchema = z.enum(["full", "summary"]).catch("full")

/**
 * One-round-trip context bundle: everything an agent needs to act on a page in a
 * single fetch — canonical markdown, headings, related pages, breadcrumbs, etag.
 * `?view=summary` drops the markdown and code examples (a heading lookup needs
 * neither) and reads only `structured_data`.
 * A missing page returns a structured JSON 404 with closest-match candidates.
 */
export async function getAgentContext(input: {
    request: Request
    params: { _splat?: string }
}): Promise<Response> {
    const { request, params } = input
    if (!isSurfaceEnabled("contextBundle")) {
        return new Response("Not Found", { status: 404 })
    }

    const slugs = normalizeDocUrl(params._splat ?? "")
    const ctx = await resolveDocsContext(request, slugs)
    const source = await sourceForActiveVersion(ctx, slugs)
    const page = await resolvePage(ctx, source, slugs)
    // No content version serves no pages (resolvePage is null).
    if (!page || !ctx.versionId) {
        return new Response(
            JSON.stringify({
                error: "not_found",
                requested: params._splat ?? "",
                candidates: suggestClosestPages(ctx, slugs),
            }),
            {
                status: 404,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": agentConfig.cache.header,
                },
            },
        )
    }

    const view = viewSchema.parse(
        new URL(request.url).searchParams.get("view") ?? undefined,
    )
    const identity = pageEtag(ctx, page, siteUrlFromRequest(request))
    const etag =
        view === "summary" ? `${identity.slice(0, -1)}:summary2"` : identity
    if (request.headers.get("if-none-match") === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                ETag: etag,
                "Cache-Control": agentConfig.cache.header,
            },
        })
    }

    const pageRow = and(
        eq(schema.docsPage.versionId, ctx.versionId),
        eq(schema.docsPage.siteId, ctx.site.id),
        eq(schema.docsPage.path, page.data.sourcePath),
    )
    const identityFields = {
        url: page.url,
        markdownUrl: slugsToMarkdownPath(page.slugs).url,
        title: page.data.pageTitle,
        description: page.data.description ?? null,
        breadcrumbs: pageBreadcrumbs(ctx, page),
    }
    const headers = {
        "Content-Type": "application/json; charset=utf-8",
        ETag: etag,
        "Cache-Control": agentConfig.cache.header,
    }
    if (view === "summary") {
        const [row] = await db
            .select({ structuredData: schema.docsPage.structuredData })
            .from(schema.docsPage)
            .where(pageRow)
            .limit(1)
        if (!row)
            throw new Error(`no docs_page row for ${page.data.sourcePath}`)
        // Frontmatter `url` makes the page an external pointer: its
        // HTML route redirects off-site ($.tsx), so open_documentation must
        // refuse it rather than navigate the user's browser away.
        const summary = {
            ...identityFields,
            external: externalPointer(page) !== null,
            headings: structuredDataSchema.parse(row.structuredData).headings,
            related: relatedPages(ctx, page),
        }
        return new Response(JSON.stringify(summary, null, 2), { headers })
    }

    // One projection of the page row for every per-page field the bundle
    // carries, the body handed to getLLMText instead of re-read
    // (codeExamplesFor stays for the MCP tool that needs only that field).
    const [row] = await db
        .select({
            markdown: agentBody,
            structuredData: schema.docsPage.structuredData,
            codeExamples: schema.docsPage.codeExamples,
        })
        .from(schema.docsPage)
        .where(pageRow)
        .limit(1)
    if (!row) throw new Error(`no docs_page row for ${page.data.sourcePath}`)
    const markdown = await getLLMText(ctx, page, row.markdown)
    const bundle = {
        ...identityFields,
        headings: structuredDataSchema.parse(row.structuredData).headings,
        related: relatedPages(ctx, page),
        codeExamples: docsCodeExamplesSchema.parse(row.codeExamples),
        markdown: markdown.slice(0, MARKDOWN_CAP),
        truncated: markdown.length > MARKDOWN_CAP,
    }

    return new Response(JSON.stringify(bundle, null, 2), { headers })
}

export const Route = createFileRoute("/api/agent/context/$")({
    server: {
        handlers: {
            GET: getAgentContext,
        },
    },
})
