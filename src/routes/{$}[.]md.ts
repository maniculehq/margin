import { createFileRoute, notFound, redirect } from "@tanstack/react-router"
import {
    agentConfig,
    isSurfaceEnabled,
    siteAgentSettings,
} from "@/lib/agent.config"
import {
    type DocPage,
    getLLMText,
    normalizeDocUrl,
    pageEtag,
    suggestClosestPages,
} from "@/lib/agent-content"
import { siteUrlFromRequest, siteUrlOf, withBase } from "@/lib/base-path"
import {
    type DocsContext,
    redirectedTwin,
    resolveDocsContext,
    resolvePage,
    resolvePageCaseInsensitive,
    sourceForActiveVersion,
} from "@/lib/source"
import { formatDocsPath } from "@/types/docs"

/**
 * The pointer every standalone markdown page opens with: an agent that
 * landed on one page learns where the whole map is. It names the index for
 * the page's own locale/version scope (llmstxt.org path scoping), the full
 * corpus, the MCP server and the manifest of every surface. Off with
 * `agents.indexPreamble: false` under the docs.json extension key.
 */
function indexPreamble(
    ctx: DocsContext,
    siteUrl: string,
    page: DocPage | null,
    slugs: string[],
): string {
    if (!isSurfaceEnabled("llms")) return ""
    const segments = page ? page.url.split("/").filter(Boolean) : slugs
    const scope: string[] = []
    if (ctx.activeLocale && segments[0] === ctx.activeLocale)
        scope.push(segments[0])
    const version = ctx.activeVersion(slugs)
    if (version && segments[scope.length] === version) scope.push(version)
    const base = `${siteUrl}${scope.map((s) => `/${s}`).join("")}`
    const lines = [
        "> ## Documentation Index",
        `> Fetch the complete documentation index at: ${base}/llms.txt`,
        "> Use this file to discover all available pages before exploring further.",
        ...(isSurfaceEnabled("llmsFull")
            ? [
                  `> For every page in one file, fetch ${base}/llms-full.txt (large).`,
              ]
            : []),
        ...(isSurfaceEnabled("mcp")
            ? [
                  `> To search and read these docs as tools, connect the MCP server at ${siteUrl}/api/mcp.`,
              ]
            : []),
        `> Every agent surface: ${siteUrl}${agentConfig.discovery.manifestPath}`,
    ]
    return `${lines.join("\n")}\n\n`
}

/** Optional YAML frontmatter (`agents.markdownFrontmatter` under the docs.json extension key):
 * JSON string literals are valid YAML double-quoted scalars. */
function frontmatter(ctx: DocsContext, siteUrl: string, page: DocPage): string {
    return [
        "---",
        `title: ${JSON.stringify(page.data.pageTitle)}`,
        ...(page.data.description
            ? [`description: ${JSON.stringify(page.data.description)}`]
            : []),
        `url: ${JSON.stringify(siteUrlOf(siteUrl, formatDocsPath(page.url, ctx.seo.trailingSlash)))}`,
        `updated: ${page.data.lastModified.toISOString().slice(0, 10)}`,
        "---",
        "",
        "",
    ].join("\n")
}

export async function getDocsMarkdown(input: {
    request: Request
    params: { _splat?: string }
}): Promise<Response> {
    const { request, params } = input
    if (!isSurfaceEnabled("markdown")) throw notFound()

    const slugs = normalizeDocUrl(params._splat ?? "")
    const ctx = await resolveDocsContext(request, slugs)
    // A configured redirect wins over a page still at its source, as on
    // the HTML route ($.tsx matches redirects before resolving the page).
    const moved = redirectedTwin(ctx, slugs, ".md", new URL(request.url).search)
    if (moved)
        throw redirect({
            href: withBase(moved.href),
            statusCode: moved.statusCode,
        })
    const source = await sourceForActiveVersion(ctx, slugs)
    const page = await resolvePage(ctx, source, slugs)

    if (!page) {
        // The HTML route's case fallback (spec §5.3): a miss retried
        // case-insensitively answers 308 to the canonical spelling's twin.
        const canonical = await resolvePageCaseInsensitive(ctx, slugs)
        if (canonical)
            throw redirect({
                href: withBase(
                    `${canonical === "/" ? "/index" : canonical}.md${new URL(request.url).search}`,
                ),
                statusCode: 308,
            })
    }
    // Recovery-oriented 404: clean markdown listing the closest pages, each
    // with its description (clipped at a word boundary) so an agent can pick
    // one without fetching them all, plus the full index when it's served.
    const settings = siteAgentSettings(ctx.config)
    const siteUrl = siteUrlFromRequest(request)
    if (!page) {
        const candidates = suggestClosestPages(ctx, slugs)
        const body =
            (settings.indexPreamble
                ? indexPreamble(ctx, siteUrl, null, slugs)
                : "") +
            `# Page not found\n\n` +
            `\`/${params._splat ?? ""}\` does not exist. Similar pages:\n\n` +
            candidates
                .map((c) => {
                    const text = c.description?.replace(/\s+/g, " ").trim()
                    const cut = text ? text.lastIndexOf(" ", 160) : -1
                    const clipped =
                        text && text.length > 160
                            ? `${text.slice(0, cut > 0 ? cut : 160)}…`
                            : text
                    return `- [${c.title}](${withBase(c.markdownUrl)})${clipped ? `: ${clipped}` : ""}`
                })
                .join("\n") +
            "\n" +
            (isSurfaceEnabled("llms")
                ? `\nAll pages: [${withBase("/llms.txt")}](${withBase("/llms.txt")})\n`
                : "")
        // Shared policy like the 200: content is immutable per version and
        // the publish purge clears the cache tag when the page appears.
        // Vary keeps the negotiated copy at an HTML URL apart from the HTML
        // 404 cached there.
        return new Response(body, {
            status: 404,
            headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                Vary: "Accept",
                "Cache-Control": agentConfig.cache.header,
                "X-Robots-Tag": "noindex",
            },
        })
    }

    const etag = pageEtag(ctx, page, siteUrl)
    const headers: Record<string, string> = {
        "Content-Type": "text/markdown; charset=utf-8",
        ETag: etag,
        // CDN-safe negotiation: vary on Accept, never User-Agent.
        Vary: "Accept",
        "Cache-Control": agentConfig.cache.header,
        // Point crawlers at the human page — in its CANONICAL spelling
        // (seo.trailingSlash), matching the HTML page and the sitemap —
        // and keep the .md duplicate out of the index.
        Link: `<${withBase(formatDocsPath(page.url, ctx.seo.trailingSlash))}>; rel="canonical"`,
        "X-Robots-Tag": "noindex",
    }

    if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers })
    }

    return new Response(
        (settings.markdownFrontmatter ? frontmatter(ctx, siteUrl, page) : "") +
            (settings.indexPreamble
                ? indexPreamble(ctx, siteUrl, page, slugs)
                : "") +
            (await getLLMText(ctx, page)),
        { headers },
    )
}

export const Route = createFileRoute("/{$}.md")({
    server: {
        handlers: {
            GET: getDocsMarkdown,
        },
    },
})
