import { formatDocsPath } from "@/types/docs"
import { KNOWN_AGENTS } from "./agent.config"
import {
    type DocPage,
    externalPointer,
    orderedPages,
    pageSection,
    slugsToMarkdownPath,
} from "./agent-content"
import { siteUrlOf } from "./base-path"
import { localeCounterparts } from "./seo"
import {
    type AlternateTree,
    type DocsContext,
    isPageIndexable,
    resolveActiveLocale,
} from "./source"

function lastmodOf(page: DocPage): string {
    return page.data.lastModified.toISOString()
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
}

/**
 * XML sitemap for crawlers — absolute HTML URLs, in navigation order, git
 * lastmod when known. Other product versions and locales are listed too
 * (their pages are indexable and self-canonical); external pointers are not
 * (they answer 307). With two or more visible locales every URL also lists
 * its served locale counterparts as `xhtml:link rel="alternate" hreflang`
 * entries (plus x-default on the default locale's page), the same mapping
 * the page's own hreflang links use.
 */
export function buildSitemapXml(
    siteUrl: string,
    ctx: DocsContext,
    /** Trees beyond the ctx's own: other versions and locales. */
    trees: AlternateTree[] = [],
): string {
    const seen = new Set<string>()
    const pages = [
        ...orderedPages(ctx),
        ...trees.flatMap((tree) => tree.pages),
    ].filter((page) => {
        if (
            seen.has(page.url) ||
            !isPageIndexable(ctx, page) ||
            externalPointer(page) !== null
        )
            return false
        seen.add(page.url)
        return true
    })
    const visibleLocales = ctx.localesManifest.filter(
        (entry) => entry.hidden !== true,
    )
    const served = new Set(pages.map((page) => page.data.servedUrl))
    const urls = pages.map((page) => {
        const mod = lastmodOf(page)
        const alternates =
            visibleLocales.length < 2
                ? []
                : localeCounterparts(
                      page.data.servedUrl,
                      resolveActiveLocale(page.slugs, ctx.localesManifest)
                          .locale,
                      visibleLocales,
                  ).filter((counterpart) => served.has(counterpart.url))
        const alternateLinks = alternates.flatMap((counterpart) => {
            const href = escapeXml(
                siteUrlOf(
                    siteUrl,
                    formatDocsPath(counterpart.url, ctx.seo.trailingSlash),
                ),
            )
            return [
                `\n    <xhtml:link rel="alternate" hreflang="${escapeXml(counterpart.locale)}" href="${href}"/>`,
                ...(counterpart.default
                    ? [
                          `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${href}"/>`,
                      ]
                    : []),
            ]
        })
        return (
            `  <url>\n    <loc>${escapeXml(
                siteUrlOf(
                    siteUrl,
                    formatDocsPath(page.url, ctx.seo.trailingSlash),
                ),
            )}</loc>` +
            `\n    <lastmod>${mod}</lastmod>` +
            alternateLinks.join("") +
            `\n  </url>`
        )
    })
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`
}

/** Agent-friendly Markdown sitemap: grouped by navigation section, then
 * one section per other version and language (the same pages as
 * sitemap.xml), with titles, descriptions, .md links, freshness. */
export function buildSitemapMarkdown(
    siteUrl: string,
    ctx: DocsContext,
    trees: AlternateTree[] = [],
): string {
    const groups = new Map<string, DocPage[]>()
    for (const page of orderedPages(ctx)) {
        const section = pageSection(ctx, page)
        const list = groups.get(section) ?? []
        list.push(page)
        groups.set(section, list)
    }
    const out: string[] = [`# ${ctx.identity.name} — documentation map\n`]
    // Other versions and languages follow as sections of their own, never
    // merged into an authored section that happens to share the heading.
    for (const [section, pages] of [
        ...groups,
        ...trees.map((tree): [string, DocPage[]] => [
            `${tree.kind === "version" ? "Version" : "Language"}: ${tree.label}${tree.tag ? ` (${tree.tag})` : ""}`,
            tree.pages,
        ]),
    ]) {
        out.push(`## ${section}\n`)
        for (const page of pages) {
            // External pointers link their destination (as in llms.txt).
            const mdUrl =
                externalPointer(page) ??
                siteUrl + slugsToMarkdownPath(page.slugs).url
            const mod = lastmodOf(page)
            const desc = page.data.description
                ? ` — ${page.data.description}`
                : ""
            const updated = mod ? ` (updated ${mod.slice(0, 10)})` : ""
            out.push(`- [${page.data.pageTitle}](${mdUrl})${desc}${updated}`)
        }
        out.push("")
    }
    return out.join("\n")
}

/**
 * robots.txt allowing all (incl. named AI crawlers) and advertising the sitemap.
 * The named entries derive from the canonical KNOWN_AGENTS registry (they are
 * already allowed by the wildcard; naming them documents intent and survives
 * stricter default-deny tooling). Every group carries the site's
 * Content-Signal (https://contentsignals.org): a crawler obeys only the most
 * specific group naming it, so a signal on the wildcard alone would never
 * reach the named crawlers.
 */
export function buildRobots(siteUrl: string, contentSignal: string): string {
    // `siteUrl` is the site's URL: under a base path, the site is that path.
    const scope = new URL(siteUrl).pathname
    const group = (agent: string) => [
        `User-agent: ${agent}`,
        `Content-Signal: ${contentSignal}`,
        `Allow: ${scope}`,
        "",
    ]
    const lines = group("*")
    for (const agent of KNOWN_AGENTS) {
        if (agent.robotsToken) lines.push(...group(agent.robotsToken))
    }
    lines.push(`Sitemap: ${siteUrl}/sitemap.xml`, "")
    return lines.join("\n")
}
