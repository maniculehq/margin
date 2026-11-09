import {
    ClientOnly,
    createFileRoute,
    getRouteApi,
    notFound,
    redirect,
} from "@tanstack/react-router"
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { getCache, waitUntil } from "@vercel/functions"
import { deserializePageTree } from "fumadocs-core/source/client"
import type { TOCItemType } from "fumadocs-core/toc"
import { fetchRepositoryInfo } from "fumadocs-ui/components/github-info"
import { buttonVariants } from "fumadocs-ui/components/ui/button"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import {
    DocsBody,
    DocsDescription,
    DocsPage,
    DocsTitle,
    useDocsPage,
} from "fumadocs-ui/layouts/docs/page"
import {
    Sidebar,
    SidebarProvider,
    SidebarTrigger,
    useSidebar,
} from "fumadocs-ui/layouts/docs/slots/sidebar"
import {
    FullSearchTrigger,
    SearchTrigger,
} from "fumadocs-ui/layouts/shared/slots/search-trigger"
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch"
import {
    Component,
    type ComponentProps,
    lazy,
    type ReactNode,
    Suspense,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
} from "react"
import {
    array,
    type infer as Infer,
    json,
    looseObject,
    nullable,
    number,
    object,
    optional,
    record,
    regex,
    string,
    unknown,
    catch as zodCatch,
    enum as zodEnum,
} from "zod/mini"
import { AssistantDock } from "@/components/ai/assistant-dock"
import {
    AISearchPanelSlot,
    AISearchTrigger,
    useAssistantHotkeyLabel,
} from "@/components/ai/search-context"
import {
    ApiPlaygroundProvider,
    useApiPlayground,
} from "@/components/api-playground-state"
import { ChangelogFilters } from "@/components/changelog-filters"
import {
    chromeIcon,
    ExternalLinkIcon,
    MessageCircleIcon,
    SparklesIcon,
} from "@/components/chrome-icons"
import { ChromeLink } from "@/components/chrome-link"
import { DocsFooter } from "@/components/docs-footer"
import {
    bandTabs,
    DocsHeader,
    iconSpan,
    SidebarChrome,
} from "@/components/docs-header"
import { GithubWidget } from "@/components/github-widget"
import { HastBody } from "@/components/hast-body"
import { ArticleImages, CodeIssueContext } from "@/components/mdx"
import { FooterSocials, PageFeedback } from "@/components/page-feedback"
import { PageRail } from "@/components/page-rail"
import { VariationsProvider } from "@/components/view-group"
import { PageActions } from "@/components/view-options"
import { DocsWebmcpTools } from "@/components/webmcp-tools"
import { env } from "@/env"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import {
    htmlPageEtag,
    searchServerFor,
    suggestClosestPages,
} from "@/lib/agent-content"
import {
    basePath,
    siteUrlFromRequest,
    siteUrlOf,
    withBase,
} from "@/lib/base-path"
import {
    activeLocaleOf,
    chromeStringsFor,
    localeLabel,
    useActiveLocale,
    useChromeStrings,
} from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import {
    baseOptions,
    chromeMode,
    navbarChromeLinks,
    searchModeOf,
    versionSwitcherModel,
} from "@/lib/layout.shared"
import { webmcpEnabled } from "@/lib/observability"
import {
    renderDeclinedFallback,
    renderMdxInSandbox,
} from "@/lib/sandbox-render"
import {
    buildPageSeo,
    localeCounterparts,
    type PageSeoProvenance,
} from "@/lib/seo"
import { appName, docsImageRoute, slugsToMarkdownPath } from "@/lib/shared"
import {
    assetHashByPath,
    type DocsContext,
    type DocsPageBody,
    isPageIndexable,
    type LayoutConfig,
    openapiDocument,
    pageBodyFor,
    resolveDocsContext,
    resolvePage,
    resolvePageCaseInsensitive,
    type SiteSource,
    servedUrlsPresent,
    serveLayoutConfig,
    treeDerivations,
} from "@/lib/source"
import { SsrSnapshot } from "@/lib/ssr-snapshot"
import type { ResolvedTabGroup } from "@/types/docs"
import {
    formatDocsPath,
    isAllowedUrl,
    matchRedirect,
    resolveDocsApiConfig,
} from "@/types/docs-shared"

// Pagination and drawer glyphs, rendered from the build-time chrome icon set.
const ChevronLeftIcon = chromeIcon("chevron-left")
const ChevronRightIcon = chromeIcon("chevron-right")
const MenuIcon = chromeIcon("menu")
const rootApi = getRouteApi("__root__")

/**
 * Lazy so the (heavy) fumadocs-openapi UI chunk only downloads when a
 * kind="openapi" page actually renders — MDX-only sites never pay for it.
 */
const OpenApiBody = lazy(() => import("@/components/api-page"))
type ApiConsoleConfig = import("@/components/api-page").ApiConsoleConfig

/**
 * Resolves OpenAPI servers using operation → path-item → document precedence;
 * the first present list overrides earlier levels, including an empty list.
 * Full URLs expand only from absolute servers. Relative references use the
 * API path as their base because the docs origin is not the API origin; dot
 * segments and unresolved templates remain unresolved.
 */
export function endpointBarPath(input: {
    operationPath: string
    /** [operation.servers, pathItem.servers, root.servers] — most specific first. */
    serverLists: unknown[]
    full: boolean
}): string {
    if (!input.full) return input.operationPath
    const serverSchema = looseObject({
        url: string(),
        variables: optional(record(string(), unknown())),
    })
    for (const list of input.serverLists) {
        const parsed = array(unknown()).safeParse(list)
        if (!parsed.success) continue
        // A PRESENT empty array is an override: OpenAPI defaults it to the
        // relative "/" server, so no enclosing server may leak through.
        const first = parsed.data[0]
        if (first === undefined) return input.operationPath
        const server = serverSchema.safeParse(first)
        if (!server.success) return input.operationPath
        const substituted = server.data.url.replace(
            /\{([^{}]+)\}/g,
            (match, name: string) => {
                const variable = object({ default: string() }).safeParse(
                    server.data.variables?.[name],
                )
                return variable.success ? variable.data.default : match
            },
        )
        if (substituted.includes("{")) return input.operationPath
        // Server URLs are URI references and may carry query/fragment
        // components — the operation path extends the PATH, so it inserts
        // before them (".../v1?key=k" + "/users" → ".../v1/users?key=k").
        const suffixIndex = substituted.search(/[?#]/)
        const url = (
            suffixIndex === -1 ? substituted : substituted.slice(0, suffixIndex)
        ).replace(/\/+$/, "")
        const suffix = suffixIndex === -1 ? "" : substituted.slice(suffixIndex)
        // A query/fragment-only reference ("?key={key}") is the relative "/"
        // server carrying a suffix — the operation path takes it directly.
        if (url.length === 0 && suffix.length > 0)
            return `${input.operationPath}${suffix}`
        if (/^https?:\/\//i.test(url) || url.startsWith("/"))
            return `${url}${input.operationPath}${suffix}`
        if (
            url.length > 0 &&
            // Only a real parent-directory SEGMENT is ambiguous — ordinary
            // segments containing dots ("v1..beta") are fine.
            !url.split("/").some((segment) => segment === "..") &&
            // Any other scheme (wss:, ftp:) is not an HTTP request URL.
            !/^[a-z][a-z0-9+.-]*:/i.test(url)
        )
            return `/${url.replace(/^(\.\/)+/, "")}${input.operationPath}${suffix}`
        return input.operationPath
    }
    return input.operationPath
}

/**
 * Chrome (layout config, versions manifest, sidebar tree) per chrome key,
 * browser-side only: every page of one (locale, version, tab) shares it, so
 * a client navigation fetches it once per tab session instead of inside
 * every page payload. The server never writes here — SSR gets the chrome
 * inline from serverLoader — and the Page component seeds it from the
 * hydrated document.
 */
const browserChrome = new Map<string, Promise<ChromeData>>()

export const Route = createFileRoute("/$")({
    component: Page,
    // Page payloads are pure functions of the immutable content version:
    // back/forward and a re-hover within ten minutes reuse the router cache
    // instead of re-running the loader (the default staleTime is 0 and
    // hover preloads go stale after 30 s).
    staleTime: 10 * 60_000,
    gcTime: 10 * 60_000,
    preloadStaleTime: 10 * 60_000,
    server: {
        handlers: {
            // A conditional document GET is answered before any loader work:
            // the validator is an identity (build, version, locale, URL,
            // stars), so it needs the request head, the in-memory page and
            // the memoized layout config — never the body read or the
            // isolate render. Every redirect or 404 the loader could answer
            // instead is a function of the same version and URL, and the
            // loader never stamps a validator on those, so a matching tag
            // proves the loader would render this same 200. Anything else
            // falls through to the router (etagMiddleware still answers a
            // match that the render itself produces).
            GET: async ({ request, params, next }) => {
                const ifNoneMatch = request.headers.get("if-none-match")
                if (!ifNoneMatch) return next()
                const slugs = (params._splat ?? "")
                    .split("/")
                    .filter((v) => v.length > 0)
                const ctx = await resolveDocsContext(request, slugs)
                const page = await resolvePage(
                    ctx,
                    ctx.versionSources.get(ctx.activeVersion(slugs) ?? "") ??
                        ctx.source,
                    slugs,
                )
                if (!page) return next()
                // Read the loader's star memo without starting a fetch: a
                // miss renders without the widget, exactly as the loader would.
                const repo = (await serveLayoutConfig(ctx))?.githubRepo
                const hit = repo
                    ? githubStarsCache.get(`${repo.owner}/${repo.repo}`)
                    : undefined
                const etag = htmlPageEtag(
                    ctx,
                    page,
                    hit && hit.expires > Date.now() ? hit.stars : null,
                    siteUrlFromRequest(request),
                )
                if (ifNoneMatch !== etag) return next()
                return new Response(null, {
                    status: 304,
                    headers: {
                        ETag: etag,
                        "Cache-Control": agentConfig.cache.header,
                        Vary: "Accept",
                    },
                })
            },
        },
    },
    loader: async ({ params }) => {
        // Filter empties so the index page ("/", _splat "") resolves to []
        // rather than [""], which source.getPage would miss.
        const slugs = (params._splat ?? "")
            .split("/")
            .filter((v) => v.length > 0)
        const { chrome, layout, ...page } = await serverLoader({ data: slugs })
        const served =
            chrome ??
            (await (() => {
                const key = JSON.stringify(page.chromeKey)
                const cached = browserChrome.get(key)
                if (cached) return cached
                const pending = chromeLoader({ data: page.chromeKey })
                pending.catch(() => {
                    if (browserChrome.get(key) === pending)
                        browserChrome.delete(key)
                })
                browserChrome.set(key, pending)
                return pending
            })())
        return {
            ...page,
            pageTree: served.pageTree,
            layout: {
                ...layout,
                config: served.config,
                versionsManifest: served.versionsManifest,
            },
        }
    },
    head: ({ loaderData, match, matches }) => {
        const seo = loaderData?.seo
        if (match.status === "notFound" || !seo) {
            // The not-found body and its 404 status already server-render;
            // without this the document kept the root's bare <title> and
            // stayed indexable. Site name + locale list come from the root
            // match (validated — the match array is typed by its own route);
            // the locale itself is derived from this match's pathname, like
            // the body's useActiveLocale — the root loader's `language` is
            // SSR-time state cached across client navigations.
            const root = object({
                siteName: string(),
                defaultLanguage: string(),
                pathLocales: array(string()),
            }).safeParse(matches[0]?.loaderData)
            const site = root.success ? root.data.siteName : appName
            const strings = chromeStringsFor(
                root.success
                    ? activeLocaleOf(match.pathname, root.data)
                    : undefined,
            )
            return {
                meta: [
                    { title: `${strings.pageNotFound} – ${site}` },
                    { name: "robots", content: "noindex" },
                ],
            }
        }
        const meta: Array<{
            title?: string
            name?: string
            property?: string
            content?: string
        }> = [
            // Site-level metatags first: TanStack keeps the LAST tag per
            // name/property, so page facts below override, never the reverse.
            ...seo.siteMeta,
            { title: seo.title },
            { property: "og:title", content: seo.title },
            { property: "og:type", content: seo.ogType },
            { property: "og:site_name", content: seo.siteName },
            { property: "og:url", content: seo.canonical },
            {
                // Open Graph wants language_TERRITORY; a bare BCP-47 "en"
                // maximizes to en_US.
                property: "og:locale",
                content: (() => {
                    try {
                        const locale = new Intl.Locale(seo.language).maximize()
                        return locale.region
                            ? `${locale.language}_${locale.region}`
                            : locale.language
                    } catch {
                        return seo.language.replaceAll("-", "_")
                    }
                })(),
            },
            { property: "article:modified_time", content: seo.lastModified },
            { name: "twitter:card", content: "summary_large_image" },
            { name: "twitter:title", content: seo.title },
            { property: "og:image:alt", content: seo.imageAlt },
            { name: "twitter:image:alt", content: seo.imageAlt },
        ]
        if (seo.twitterSite)
            meta.push({ name: "twitter:site", content: seo.twitterSite })
        if (seo.description) {
            meta.push({ name: "description", content: seo.description })
            meta.push({ property: "og:description", content: seo.description })
            meta.push({ name: "twitter:description", content: seo.description })
        }
        meta.push(...seo.meta)
        return {
            meta,
            links: [
                { rel: "canonical", href: seo.canonical },
                {
                    rel: "alternate",
                    type: "text/markdown",
                    href: seo.markdownUrl,
                },
                {
                    rel: "sitemap",
                    type: "application/xml",
                    href: `${seo.siteUrl}/sitemap.xml`,
                },
                ...seo.alternates.map((alternate) => ({
                    rel: "alternate",
                    hrefLang: alternate.language,
                    href: alternate.url,
                })),
                ...seo.alternates
                    .filter((alternate) => alternate.default)
                    .map((alternate) => ({
                        rel: "alternate",
                        hrefLang: "x-default",
                        href: alternate.url,
                    })),
                // Changelog (Update) pages publish an RSS feed at
                // <page>.rss.xml; advertise it for feed readers.
                ...(loaderData?.updates
                    ? [
                          {
                              rel: "alternate",
                              type: "application/rss+xml",
                              title: seo.pageTitle,
                              href: seo.markdownUrl.replace(
                                  /\.md$/,
                                  ".rss.xml",
                              ),
                          },
                      ]
                    : []),
                ...(seo.provenance?.license
                    ? [
                          {
                              rel: "license",
                              href: seo.provenance.license.url,
                          },
                      ]
                    : []),
            ],
            // Server-rendered Schema.org JSON-LD (NOT client-injected).
            scripts: [
                {
                    type: "application/ld+json",
                    children: seo.jsonLd,
                },
            ],
        }
    },
})

/** GitHub star counts per owner/repo, including negative results (a
 * rate-limited or private repo must not be re-fetched on every render). */
const githubStarsCache = new Map<
    string,
    { stars: number | null; expires: number }
>()
/** One GitHub request per repo at a time; renders never await it. */
const githubStarsInflight = new Map<string, Promise<void>>()
/** A star count as the Runtime Cache L2 holds it (see the loader). */
const sharedGithubStarsSchema = object({ stars: nullable(number()) })
const GITHUB_STARS_TTL_S = 3600

/**
 * Which chrome a page renders: its locale and version tree plus the sidebar
 * tree key — `tabs:<i>` / `global:<i>` (the tab's list position; labels are
 * not unique), suffixed `:menu:<j>` when a mega-menu item scopes the tree,
 * or null for the version's merged tree. `content` is a short token of the
 * content version, so a publish mid-session keys fresh chrome.
 */
const treeKeyPattern = /^(tabs|global):(\d+)(?::menu:(\d+))?$/
const chromeKeySchema = object({
    locale: nullable(string()),
    version: nullable(string()),
    tab: nullable(string().check(regex(treeKeyPattern))),
    content: string(),
})
type ChromeKey = Infer<typeof chromeKeySchema>

/** The sidebar tree a chrome key names; unscoped tabs fall back to `source`. */
function treeSourceFor(
    ctx: DocsContext,
    source: SiteSource,
    key: string | null,
): SiteSource {
    const match = key ? treeKeyPattern.exec(key) : null
    if (!key || !match) return source
    const nav = ctx.config?.__resolvedNav
    const tab = (match[1] === "tabs" ? nav?.tabs : nav?.global?.tabs)?.[
        Number(match[2])
    ]
    if (!tab) return source
    const menuGroups =
        match[3] === undefined
            ? undefined
            : tab.menu?.[Number(match[3])]?.resolvedGroups
    return (
        ctx.tabSource(
            menuGroups?.length ? { ...tab, resolvedGroups: menuGroups } : tab,
            key,
        ) ?? source
    )
}

/**
 * Per-version constants every page of one chrome key shares. Each part is
 * memoized server-side (serveLayoutConfig per version and locale, the
 * serialized tree per loader in treeDerivations).
 *
 * Server-only: only server-fn handlers call it, but a plain top-level
 * function survives the dev client transform, and its `@/lib/source` import
 * would drag the DB client (and @sentry/node, which throws on load in the
 * browser) into the client graph and stop the page from hydrating.
 */
const chromeFor = createServerOnlyFn(
    async (ctx: DocsContext, key: ChromeKey) => {
        const source = ctx.versionSources.get(key.version ?? "") ?? ctx.source
        const [config, pageTree] = await Promise.all([
            serveLayoutConfig(ctx),
            treeDerivations(treeSourceFor(ctx, source, key.tab)).serialized(),
        ])
        return { config, versionsManifest: ctx.versionsManifest, pageTree }
    },
)
type ChromeData = Awaited<ReturnType<typeof chromeFor>>

/**
 * Client navigations read chrome here, once per chrome key per tab (see
 * browserChrome), with the shared CDN policy: the URL carries the whole key,
 * so every visitor of a tree shares one entry and the publish purge clears it.
 */
const chromeLoader = createServerFn({ method: "GET" })
    .validator((key: ChromeKey) => chromeKeySchema.parse(key))
    .handler(async ({ data: key }) => {
        const request = getRequest()
        const scope = [key.locale, key.version].filter(
            (segment): segment is string => segment !== null,
        )
        const ctx = await resolveDocsContext(request, scope)
        // A key whose scope this version no longer names (or never did) is a
        // miss, not the default tree under a junk URL.
        if (
            ctx.activeLocale !== key.locale ||
            ctx.activeVersion(scope) !== key.version
        )
            throw notFound()
        const chrome = await chromeFor(ctx, key)
        if (request.headers.get("x-tsr-serverFn") === "true")
            setResponseHeader("Cache-Control", agentConfig.cache.header)
        return chrome
    })

const serverLoader = createServerFn({
    method: "GET",
})
    .validator((slugs: string[]) => slugs)
    .handler(async ({ data: slugs }) => {
        // Server-only: the request host picks the site (works for SSR and
        // client-navigation RPC calls alike — both carry the site domain).
        // Slugs must ride along explicitly: on client-navigation RPC calls
        // request.url is the server-fn endpoint, not the page path, so
        // locale resolution from the URL alone lands on the default locale
        // (review finding — the warm below then built the wrong index).
        const request = getRequest()
        const ctx = await resolveDocsContext(request, slugs)
        // Sites that advertise `/path/` (seo.trailingSlash) get the
        // slash-less spelling redirected onto it — the counterpart of
        // start.ts's strip for everyone else. Document requests only: on
        // client-navigation RPC calls request.url is the server-fn endpoint.
        {
            const { pathname, search } = new URL(request.url)
            if (
                ctx.seo.trailingSlash &&
                !pathname.startsWith("/_serverFn") &&
                pathname !== "/" &&
                !pathname.endsWith("/") &&
                !/\.[a-z0-9]{2,5}$/i.test(pathname)
            ) {
                throw redirect({
                    href: withBase(`${pathname}/${search}`),
                    reloadDocument: true,
                    statusCode: 308,
                })
            }
        }
        // Build the search index during page views so the first search
        // avoids the cold build. `waitUntil` lets it finish after the
        // response; the server resolves only once its index exists and is
        // memoized by site, version, locale and product version, so a warm
        // page view costs one cache hit.
        waitUntil(searchServerFor(ctx, slugs).catch(() => undefined))
        const pathname = `/${slugs.join("/")}`
        // Internal redirects carry the request query through; root redirects
        // must preserve shareable ?search= URLs and downstream parameters.
        const requestSearch = (() => {
            const search = new URL(request.url).search
            return search === "" ? "" : search
        })()
        const matchedRedirect = matchRedirect(pathname, ctx.redirects)
        if (matchedRedirect) {
            // Destinations may carry `#fragment` (docs.json allows it); the
            // inherited query must land before the fragment, not inside it.
            const { destination } = matchedRedirect
            const hashAt = destination.indexOf("#")
            const beforeHash =
                hashAt === -1 ? destination : destination.slice(0, hashAt)
            const hash = hashAt === -1 ? "" : destination.slice(hashAt)
            // An authored destination is an internal path (or an external
            // URL, which withBase leaves alone).
            throw redirect({
                href: withBase(
                    beforeHash.includes("?")
                        ? destination
                        : `${beforeHash}${requestSearch}${hash}`,
                ),
                reloadDocument: true,
                statusCode: matchedRedirect.permanent ? 308 : 307,
            })
        }

        const activeVersion = ctx.activeVersion(slugs)
        const source = ctx.versionSources.get(activeVersion ?? "") ?? ctx.source
        const page = await resolvePage(ctx, source, slugs)
        if (!page) {
            // Source-path fallback for assets referenced inside snippet JS
            // objects, which the ingest rewriter cannot rewrite.
            // Extension-shaped misses check the docs_asset rows by
            // original path and 307 to the immutable hash route.
            const last = slugs.at(-1) ?? ""
            if (
                /\.[a-z0-9]{2,5}$/i.test(last) &&
                !/\.(mdx?|html?)$/i.test(last)
            ) {
                const hash = await assetHashByPath(ctx, slugs.join("/"))
                if (hash) {
                    throw redirect({
                        href: withBase(`/_assets/${hash}`),
                        reloadDocument: true,
                        statusCode: 307,
                    })
                }
            }
            // Both /x and /x/index address x/index.mdx; our
            // servedUrl strips the terminal segment, so the /x/index
            // spelling redirects to the parent. Miss-gated: a real page
            // whose URL literally ends in /index still resolves above
            // Root/index aliases resolve consistently. The .md agent
            // twin already normalizes this in normalizeDocUrl.
            if (slugs.at(-1) === "index") {
                throw redirect({
                    href: withBase(
                        `/${slugs.slice(0, -1).join("/")}${requestSearch}`,
                    ),
                    reloadDocument: true,
                    statusCode: 308,
                })
            }
            // /QUICKSTART resolves to /quickstart. Case is a miss-
            // only retry against served_url; the canonical spelling is a
            // permanent redirect so caches and crawlers converge on one URL.
            const canonical = await resolvePageCaseInsensitive(ctx, slugs)
            if (canonical && canonical !== pathname) {
                throw redirect({
                    href: withBase(`${canonical}${requestSearch}`),
                    reloadDocument: true,
                    statusCode: 308,
                })
            }
            // docs.json errors.404.redirect: unknown paths go home instead of
            // 404ing — and a miss inside a locale/version tree stays there
            // (/fr/missing → /fr/, /v1/missing → /v1/, /fr/v2/missing →
            // /fr/v2/). If the computed tree home IS the requesting URL
            // (a homeless tree), fall to "/", which always resolves
            // (synthesized root redirect/landing) — never a loop.
            if (
                ctx.config?.errors?.["404"]?.redirect === true &&
                pathname !== "/"
            ) {
                const prefix: string[] = []
                const first = slugs[0]
                if (
                    first !== undefined &&
                    ctx.localesManifest.some(
                        (entry) => !entry.default && entry.locale === first,
                    )
                )
                    prefix.push(first)
                const next = slugs[prefix.length]
                if (
                    next !== undefined &&
                    ctx.versionsManifest.some(
                        (entry) =>
                            entry.directory.length > 0 && entry.label === next,
                    )
                )
                    prefix.push(next)
                const treeHome =
                    prefix.length > 0 && prefix.join("/") !== slugs.join("/")
                        ? `/${prefix.join("/")}/`
                        : "/"
                // Prove the tree home actually serves a page before sending
                // the visitor there — a homeless /fr/v2/ tree would turn the
                // redirect into a second 404. "/" needs no proof (synthesized
                // root redirect/landing, per above). Resolution mirrors the
                // ordinary page path: the prefix's own version source, then
                // resolvePage.
                const treeHomeServes =
                    treeHome === "/" ||
                    // A configured redirect IS a valid home (/fr → /fr/guide
                    // is an intentional landing, not a homeless tree).
                    matchRedirect(`/${prefix.join("/")}`, ctx.redirects) !==
                        null ||
                    (await resolvePage(
                        ctx,
                        ctx.versionSources.get(
                            ctx.activeVersion(prefix) ?? "",
                        ) ?? ctx.source,
                        prefix,
                    )) !== null
                if (treeHomeServes) {
                    throw redirect({
                        href: withBase(`${treeHome}${requestSearch}`),
                        reloadDocument: true,
                        statusCode: 302,
                    })
                }
            }
            setResponseHeader("X-Robots-Tag", "noindex")
            // Closest pages by slug/title similarity — the 404 page renders
            // them as "did you mean" links (components/not-found.tsx).
            throw notFound({
                data: {
                    suggestions: suggestClosestPages(ctx, slugs, 3).map(
                        (page) => ({
                            title: page.title,
                            url: page.url,
                            description: page.description ?? null,
                        }),
                    ),
                },
            })
        }
        // Frontmatter `url`: the page is an external pointer —
        // visiting the internal route goes to the target.
        const externalUrl = page.data.frontmatter.url
        if (
            typeof externalUrl === "string" &&
            /^https?:\/\//i.test(externalUrl) &&
            isAllowedUrl(externalUrl)
        ) {
            throw redirect({ href: externalUrl, statusCode: 307 })
        }

        // Memoized per (version, locale); started before the body read so a
        // cold build overlaps it, and so the sandbox snapshot sees the same
        // variations config the page's VariationsProvider renders with.
        const layoutConfig = serveLayoutConfig(ctx)
        layoutConfig.catch(() => undefined)

        // Body + toc + openapi props in ONE lazy row read — none of these
        // ride the eager version source. openapiProps stands alone on
        // generated pages (kind="openapi": no compiled MDX) or rides
        // ALONGSIDE an authored body (frontmatter operation references) —
        // either way the console fetches the bundled spec from /api/spec
        // (one CDN entry per doc) — it never rides the loader payload. The
        // loader reads it server-side only for the endpoint bar.
        const artifacts = await pageBodyFor(ctx, page.data.sourcePath)
        if (!artifacts) {
            setResponseHeader("X-Robots-Tag", "noindex")
            throw notFound()
        }
        let openapi: {
            props: Extract<DocsPageBody, { kind: "openapi" }>["openapiProps"]
            specUrl: string
            console: ApiConsoleConfig
            proxyUrl: string | undefined
        } | null = null
        // Independent reads start before the isolate render so a 250 ms
        // sandbox turn overlaps them instead of preceding them.
        // Started ahead of the sandbox await (the pre-started-read pattern),
        // so a rejection surfaces where each is awaited below, never as an
        // unhandled rejection while the isolate turn is still running.
        const openapiDoc = artifacts.body.openapiProps
            ? openapiDocument(ctx, artifacts.body.openapiProps.document)
            : null
        openapiDoc?.catch(() => undefined)
        // The endpoint bar resolves against the bundled spec below; the
        // spec itself stays server-side.
        let bundled: unknown = null
        // Language selector (Phase A): the current page's counterpart URL in
        // every visible locale — one indexed servedUrl query; a missing
        // counterpart falls back to the locale home.
        const visibleLocales = ctx.localesManifest.filter(
            (entry) => entry.hidden !== true,
        )
        // Declared BEFORE the IIFE below: it starts immediately and reads
        // `siteUrl` after its first await, racing the rest of this loader — a
        // `const` further down is still in its temporal dead zone when the
        // await wins (ReferenceError → 500 on every multi-locale home page).
        // The site's URL: its public origin plus base path.
        const siteUrl = siteUrlFromRequest(request)
        const localeNavigationPending = (async () => {
            if (visibleLocales.length < 2) return { header: null, seo: [] }
            const activeTag =
                ctx.activeLocale ??
                visibleLocales.find((entry) => entry.default)?.locale ??
                null
            const candidates = localeCounterparts(
                page.data.servedUrl,
                ctx.activeLocale,
                visibleLocales,
            ).map(({ entry, url }) => ({
                entry,
                url,
                home: entry.default ? "/" : `/${entry.locale}`,
            }))
            const present = await servedUrlsPresent(ctx, [
                ...candidates.map((candidate) => candidate.url),
                ...candidates.map((candidate) => candidate.home),
            ])
            const header = candidates.map(({ entry, url, home }) => {
                // Endonym with an initial capital ("Français").
                const label = localeLabel(entry.locale)
                // Counterpart page → authored locale home → the locale nav's
                // first landing href (a locale with no authored /<locale>
                // index has no synthesized root redirect — linking there
                // 404s, review finding). "/" always serves: the compiler
                // synthesizes the root redirect.
                const firstNavHref = entry.nav.tabs.find(
                    (tab) => tab.resolvedHref,
                )?.resolvedHref
                return {
                    locale: entry.locale,
                    label,
                    href: present.has(url)
                        ? url
                        : entry.default || present.has(home)
                          ? home
                          : (firstNavHref ?? home),
                    active: entry.locale === activeTag,
                }
            })
            return {
                header,
                seo: candidates.flatMap(({ entry, url }) =>
                    present.has(url)
                        ? [
                              {
                                  language: entry.locale,
                                  url: siteUrlOf(
                                      siteUrl,
                                      formatDocsPath(
                                          url,
                                          ctx.seo.trailingSlash,
                                      ),
                                  ),
                                  default: entry.default,
                              },
                          ]
                        : [],
                ),
            }
        })()
        localeNavigationPending.catch(() => undefined)
        // Compiled-JS bodies get a server snapshot from the V8 isolate
        // (lib/sandbox-render.ts) — memoized per immutable (version, page).
        const sandbox =
            artifacts.body.kind === "js"
                ? await renderMdxInSandbox({
                      compiledJs: artifacts.body.compiledJs,
                      pageUrl: pathname,
                      basePath: basePath(),
                      cacheKey: `${ctx.versionId ?? ""}:${page.data.sourcePath}:${basePath()}`,
                      variations:
                          (await layoutConfig)?.variations?.options ?? null,
                      // The root loader's `language` rule.
                      locale:
                          ctx.activeLocale ??
                          ctx.localesManifest.find((entry) => entry.default)
                              ?.locale ??
                          ctx.seo.language ??
                          "en",
                      request,
                  })
                : null
        // A declined render must not leave crawlers and no-JS agents an
        // empty article: the snapshot slot gets the stored rendition as
        // sanitized static HTML (lib/sandbox-render.ts), replaced by the live
        // MdxBody after hydration exactly like an isolate snapshot.
        const declinedHtml =
            sandbox && !sandbox.ok
                ? await renderDeclinedFallback({
                      cacheKey: `${ctx.versionId ?? ""}:${page.data.sourcePath}:${basePath()}`,
                      basePath: basePath(),
                      description: page.data.description ?? null,
                      markdown: () => page.data.getText("processed"),
                  })
                : null
        // Client navigations (and hover preloads) read this payload through
        // the GET RPC instead of a document render.
        const rpc = new URL(request.url).pathname.startsWith("/_serverFn")
        // A document render already carries the snapshot in its HTML, so it
        // rides as an SsrSnapshot, which dehydrates as null
        // (lib/ssr-snapshot.ts); an RPC payload is the only copy the browser
        // gets, so it stays a string.
        const body: Exclude<DocsPageBody, { kind: "openapi" }> | null =
            artifacts.body.kind === "openapi"
                ? null
                : artifacts.body.kind === "js"
                  ? {
                        ...artifacts.body,
                        ssrHtml: rpc
                            ? sandbox?.ok
                                ? sandbox.html
                                : declinedHtml
                            : sandbox?.ok
                              ? new SsrSnapshot(sandbox.html)
                              : declinedHtml === null
                                ? null
                                : new SsrSnapshot(declinedHtml),
                    }
                  : artifacts.body
        if (artifacts.body.openapiProps && openapiDoc) {
            const doc = await openapiDoc
            if (!doc) {
                // A generated page without its document is unservable; a
                // composed page still has its authored prose — drop only
                // the console.
                if (artifacts.body.kind === "openapi") throw notFound()
            } else {
                // docs.json api.* resolved with defaults — the whole console
                // behavior crosses the loader as one serialized block.
                const apiConfig = resolveDocsApiConfig(ctx.config?.api)
                bundled = doc
                openapi = {
                    props: artifacts.body.openapiProps,
                    specUrl: withBase(
                        `/api/spec?doc=${encodeURIComponent(artifacts.body.openapiProps.document)}`,
                    ),
                    console: {
                        display: apiConfig.playground.display,
                        credentials: apiConfig.playground.credentials,
                        examples: apiConfig.examples,
                        paramsExpanded: apiConfig.params.expanded ?? "closed",
                    },
                    proxyUrl:
                        apiConfig.playground.display === "interactive" &&
                        apiConfig.playground.proxy
                            ? withBase("/api/proxy")
                            : undefined,
                }
            }
        }

        // Global OG override precedence: frontmatter ogImage → the standard
        // seo.metatags["og:image"] (twitter:image as its fallback spelling)
        // → thumbnails.image (stored as ogDefaults.image, the read-only
        // alias) → the generated per-page card. The consumed metatags are
        // filtered from the site-level meta emission below so the page never
        // carries two og:image tags.
        const explicitOgImage =
            typeof page.data.frontmatter.ogImage === "string"
                ? page.data.frontmatter.ogImage
                : (ctx.seo.metatags["og:image"] ??
                  ctx.seo.metatags["twitter:image"] ??
                  (typeof ctx.seo.ogDefaults.image === "string"
                      ? ctx.seo.ogDefaults.image
                      : null))
        const generatedOgImage = `${siteUrl}${docsImageRoute}/${slugs.map(encodeURIComponent).join("/")}`
        let ogImage = generatedOgImage
        if (explicitOgImage) {
            try {
                // Root-relative paths are the site's own: under its base path.
                const resolved = new URL(
                    explicitOgImage.startsWith("/") &&
                        !explicitOgImage.startsWith("//")
                        ? `${siteUrl}${explicitOgImage}`
                        : explicitOgImage,
                    `${siteUrl}/`,
                )
                if (
                    (resolved.protocol === "http:" ||
                        resolved.protocol === "https:") &&
                    resolved.username.length === 0 &&
                    resolved.password.length === 0
                )
                    ogImage = resolved.href
            } catch {
                ogImage = generatedOgImage
            }
        }

        // Tab-scoped sidebar: the active tab is the one whose
        // ingest-resolved membership contains this page's source path — a
        // root tab or a navigation.global tab (the band renders both); its
        // scoped loader replaces the merged tree. Pages in no tab fall back
        // to the FIRST root tab with membership — a page always renders
        // some tab's sidebar (unlisted/synthesized pages showed the lossy
        // merged tree); global tabs never claim unlisted pages. Configs
        // without tab membership keep the merged tree.
        // Tabs are identified by list position (`tabs:<i>` / `global:<i>`,
        // the same key bandTabs stamps on every header tab): labels are not
        // unique, so a title-keyed handoff would light up the wrong pill.
        const resolvedNav = ctx.config?.__resolvedNav
        const scopedTabs = [
            ...(resolvedNav?.tabs ?? []).map((tab, index) => ({
                tab,
                global: false,
                key: `tabs:${index}`,
            })),
            ...(resolvedNav?.global?.tabs ?? []).map((tab, index) => ({
                tab,
                global: true,
                key: `global:${index}`,
            })),
        ]
        const active =
            scopedTabs.find(({ tab }) =>
                tab.resolvedPages?.includes(page.data.sourcePath),
            ) ??
            scopedTabs.find(
                ({ tab, global }) =>
                    !global &&
                    !tab.hidden &&
                    (tab.resolvedPages?.length ?? 0) > 0,
            ) ??
            null
        const activeTab = active?.tab ?? null
        // Mega-menu tabs: each menu item is its own sidebar section
        // (it shows the item's groups, not the whole tab), so scope
        // the tree to the item holding this page when there is one.
        const activeMenuIndex =
            activeTab?.menu?.findIndex((item) =>
                item.resolvedPages?.includes(page.data.sourcePath),
            ) ?? -1
        const activeMenuItem =
            activeMenuIndex >= 0 ? activeTab?.menu?.[activeMenuIndex] : null
        const activeGroups = activeMenuItem?.resolvedGroups?.length
            ? activeMenuItem.resolvedGroups
            : (activeTab?.resolvedGroups ?? null)
        const chromeKey: ChromeKey = {
            locale: ctx.activeLocale,
            version: activeVersion,
            tab: active
                ? activeMenuItem?.resolvedGroups?.length
                    ? `${active.key}:menu:${activeMenuIndex}`
                    : active.key
                : null,
            content: ctx.versionId?.slice(-8) ?? "",
        }
        const treeSource = treeSourceFor(ctx, source, chromeKey.tab)

        // Pink group eyebrow above the H1: the nearest authored
        // group containing this page, from the tab's resolved structure —
        // e.g. "Core Commands", not a path-derived "Pm › Cli".
        // styling.eyebrows "breadcrumbs" swaps in the full group trail.
        const eyebrow = (() => {
            const findTrail = (
                groups: ResolvedTabGroup[],
                prefix: string[],
            ): string[] | null => {
                for (const group of groups) {
                    const trail = group.title
                        ? [...prefix, group.title]
                        : prefix
                    for (const entry of group.entries) {
                        if (
                            "page" in entry &&
                            entry.page === page.data.sourcePath
                        )
                            return trail
                        if ("group" in entry) {
                            const nested = findTrail([entry.group], trail)
                            if (nested) return nested
                        }
                    }
                }
                return null
            }
            const trail = activeGroups ? findTrail(activeGroups, []) : null
            if (!trail || trail.length === 0) return null
            if (ctx.config?.styling?.eyebrows === "breadcrumbs")
                return [...trail, page.data.pageTitle].join(" › ")
            return trail.at(-1) ?? null
        })()

        const localeNavigation = await localeNavigationPending
        const headerLocales = localeNavigation.header
        const config = await layoutConfig
        // Per-page chrome inputs only; the per-version constants (config,
        // versions manifest, sidebar tree) ride chromeFor.
        const layoutInput = {
            siteName: ctx.identity.name,
            activeLocale: ctx.activeLocale,
            repoOwner: ctx.site.repo?.owner ?? null,
            repoName: ctx.site.repo?.name ?? null,
            locales: headerLocales,
            // Server policy → browser: the WebMCP leaf mounts when the
            // surface is on AND either the workspace opted in on its Deploy
            // page (the site row, immediate) or the extension's rollout says
            // so (observability.ts webmcpEnabled — answered from cache,
            // never a per-request round trip once warm).
            webmcp: isSurfaceEnabled("webmcp") && webmcpEnabled(ctx.site),
        }
        // Star count for the header widget (server-rendered; the browser
        // used to call api.github.com itself — a layout shift on mount, a
        // third-party request per page view, GitHub's 60/h unauthenticated
        // limit per visitor IP). Decoration never delays the document on
        // GitHub: the in-memory memo (an hour per repo, negative results
        // included) is L1, and an L1 miss reads the regional Runtime Cache
        // once (low-ms) so every instance renders — and stamps into the
        // ETag — the same count. Only an L2 miss starts the GitHub fetch and
        // renders without the widget.
        const githubStars = await (async () => {
            const repo = config?.githubRepo
            if (!repo) return null
            const key = `${repo.owner}/${repo.repo}`
            const hit = githubStarsCache.get(key)
            if (hit && hit.expires > Date.now()) return hit.stars
            const shared = sharedGithubStarsSchema.safeParse(
                await getCache({ namespace: "github-stars" })
                    .get(key)
                    .catch(() => null),
            )
            if (shared.success) {
                githubStarsCache.set(key, {
                    stars: shared.data.stars,
                    expires: Date.now() + GITHUB_STARS_TTL_S * 1000,
                })
                return shared.data.stars
            }
            if (!githubStarsInflight.has(key)) {
                const inflight = fetchRepositoryInfo({
                    ...repo,
                    token: env.GITHUB_TOKEN,
                    fetchOptions: { signal: AbortSignal.timeout(1500) },
                })
                    .then((info) => info.stars)
                    .catch(() => null)
                    .then(async (stars) => {
                        githubStarsCache.set(key, {
                            stars,
                            expires: Date.now() + GITHUB_STARS_TTL_S * 1000,
                        })
                        githubStarsInflight.delete(key)
                        await getCache({ namespace: "github-stars" })
                            .set(key, { stars }, { ttl: GITHUB_STARS_TTL_S })
                            .catch(() => undefined)
                    })
                githubStarsInflight.set(key, inflight)
                // Keep the instance alive until the memo is written — a
                // freeze right after the response would otherwise leave the
                // inflight marker set and the widget suppressed for good.
                waitUntil(inflight)
            }
            return null
        })()
        // start.ts etagMiddleware answers a matching If-None-Match with 304
        // after this render; the route's GET handler answers it before one.
        setResponseHeader("ETag", htmlPageEtag(ctx, page, githubStars, siteUrl))
        // The page RPC, like the document, depends only on the host and the
        // slugs in its URL, so the CDN may share it. Set after the last
        // throw — a notFound or redirect frame must never be cached — and
        // only for real RPC calls: without the header Start answers the same
        // URL with a raw, unframed body.
        if (rpc && request.headers.get("x-tsr-serverFn") === "true")
            setResponseHeader("Cache-Control", agentConfig.cache.header)

        return {
            // kind="hast" bodies are pure data, rendered on the server by
            // HastBody. kind="js" carries the compiled MDX function-body
            // STRING across the loader boundary for the browser
            // (executeMdxSync below) plus the isolate's HTML snapshot — this
            // DB-credentialed process never evaluates site code itself;
            // the only server execution is inside the host-less V8 isolate
            // of lib/sandbox-render.ts.
            body,
            openapi,
            toc: artifacts.toc,
            title: page.data.pageTitle,
            // Only AUTHORED descriptions render as the subtitle — derived
            // first-paragraph excerpts stay meta/search-only, since the same
            // paragraph renders as the body's opening line (it duplicated on
            // every guide page). page.data.description keeps feeding head
            // meta via buildPageSeo either way.
            description:
                typeof page.data.frontmatter.description === "string"
                    ? page.data.frontmatter.description
                    : undefined,
            // Public: fetched and linked raw (page actions, RSS), never
            // through the router.
            markdownUrl: withBase(slugsToMarkdownPath(page.slugs).url),
            chromeKey,
            // The document render gets its chrome inline (one context
            // resolution per request); an RPC payload leaves it to the
            // browser's per-key chromeLoader memo.
            chrome: rpc ? null : await chromeFor(ctx, chromeKey),
            // Prev/next in tree order for the pagination cards. Computed
            // here (not via fumadocs' Footer) so the cards can render
            // a caption-over-title layout — fumadocs' FooterItem
            // markup (chevron beside title + description line) has no slot.
            // Decorated names fall back to the page title (treeDerivations),
            // so generated API pages keep their prev/next.
            pagination: (() => {
                const flat = treeDerivations(treeSource).flat.flatMap(
                    ({ name, url }) => (name === null ? [] : [{ name, url }]),
                )
                const index = flat.findIndex((entry) => entry.url === page.url)
                return {
                    previous: index > 0 ? (flat[index - 1] ?? null) : null,
                    next: index !== -1 ? (flat[index + 1] ?? null) : null,
                }
            })(),
            activeTab: active?.key ?? null,
            eyebrow,
            // docs.json metadata.timestamp — the per-page lastModified is
            // already persisted; frontmatter `timestamp` opts one page in or
            // out of the site-wide switch.
            timestamp:
                page.data.frontmatter.timestamp === true ||
                (ctx.config?.metadata?.timestamp === true &&
                    page.data.frontmatter.timestamp !== false)
                    ? page.data.lastModified.toISOString()
                    : null,
            // Page-level contextual override: frontmatter REPLACES
            // the global config for this page (`options: []` disables the
            // menu); invalid shapes already fell to undefined at the
            // frontmatter parse, which falls back to the global config here.
            // json(): the value crosses the loader boundary, so it must
            // type as serializable (same idiom as layoutConfigSchema).
            contextual: zodCatch(
                nullable(
                    object({
                        options: optional(array(json())),
                        display: optional(zodEnum(["header", "toc"])),
                    }),
                ),
                null,
            ).parse(
                page.data.frontmatter.contextual ??
                    ctx.config?.contextual ??
                    null,
            ),
            // Update pages (changelogs) swap the TOC for a tag
            // Filters rail and expose an RSS feed (routes/{$}.rss.xml).
            updates: artifacts.updates
                ? {
                      tags: [
                          ...new Set(
                              artifacts.updates.flatMap(
                                  (update) => update.tags,
                              ),
                          ),
                      ],
                  }
                : null,
            // Endpoint bar: operation pages surface the
            // method + path + deprecated flag beside the H1. Generated pages
            // carry exactly one operation (ingest per: "operation");
            // composed frontmatter-reference pages show their first.
            endpoint: (() => {
                const operation = openapi?.props.operations?.[0]
                if (!operation || !openapi) return null
                const readRecord = (
                    value: unknown,
                ): Record<string, unknown> | null => {
                    const parsed = record(string(), unknown()).safeParse(value)
                    return parsed.success ? parsed.data : null
                }
                // Resolve local path-item $refs so fields like `deprecated`
                // come from the referenced item. Preserve $ref siblings as
                // overrides, such as a path-specific `servers` value.
                const paths = readRecord(readRecord(bundled)?.paths)
                let pathItem = readRecord(paths?.[operation.path])
                if (
                    typeof pathItem?.$ref === "string" &&
                    pathItem.$ref.startsWith("#/")
                ) {
                    let current: unknown = bundled
                    for (const segment of pathItem.$ref.slice(2).split("/")) {
                        current =
                            readRecord(current)?.[
                                segment
                                    .replaceAll("~1", "/")
                                    .replaceAll("~0", "~")
                            ]
                    }
                    const resolved = readRecord(current)
                    if (resolved) {
                        pathItem = {
                            ...resolved,
                            ...Object.fromEntries(
                                Object.entries(pathItem).filter(
                                    ([key]) => key !== "$ref",
                                ),
                            ),
                        }
                    }
                }
                const spec = readRecord(
                    pathItem?.[operation.method.toLowerCase()],
                )
                // docs.json api.url: "full" shows the whole request URL in
                // the endpoint bar — resolved with OpenAPI server precedence
                // and variable defaults (endpointBarPath above).
                return {
                    method: operation.method.toUpperCase(),
                    path: endpointBarPath({
                        operationPath: operation.path,
                        serverLists: [
                            spec?.servers,
                            pathItem?.servers,
                            readRecord(bundled)?.servers,
                        ],
                        full: ctx.config?.api?.url === "full",
                    }),
                    deprecated: spec?.deprecated === true,
                }
            })(),
            // docs.json feedback flags — all default OFF.
            feedback: {
                thumbsRating: ctx.config?.feedback?.thumbsRating === true,
                suggestEdit: ctx.config?.feedback?.suggestEdit === true,
                raiseIssue: ctx.config?.feedback?.raiseIssue === true,
            },
            // Repo-bound sites get "Suggest edits" / "Raise issue" links on
            // the feedback row — when feedback.* enables them.
            editUrl:
                ctx.config?.feedback?.suggestEdit === true &&
                ctx.site.repo?.owner &&
                ctx.site.repo.name
                    ? `https://github.com/${ctx.site.repo.owner}/${ctx.site.repo.name}/edit/${ctx.site.repo.branch}/${ctx.site.repo.subdir ? `${ctx.site.repo.subdir}/` : ""}${page.data.sourcePath}`
                    : null,
            issueUrl:
                ctx.config?.feedback?.raiseIssue === true &&
                ctx.site.repo?.owner &&
                ctx.site.repo.name
                    ? `https://github.com/${ctx.site.repo.owner}/${ctx.site.repo.name}/issues/new?${new URLSearchParams(
                          {
                              title: `Docs feedback: ${page.data.pageTitle}`,
                              body: `Page: ${siteUrl}${pathname}`,
                          },
                      )}`
                    : null,
            seo: {
                ...buildPageSeo({
                    siteUrl,
                    ctx,
                    source: treeSource,
                    page,
                    imageUrl: ogImage,
                    apiReference: openapi !== null,
                    alternates: localeNavigation.seo,
                }),
                // Site-level tags render BEFORE the page-derived ones in
                // head(): TanStack keeps the LAST tag per name/property, so
                // a site metatag must never shadow a page fact. Pages always
                // self-canonicalize — ingest drops any site-level
                // seo.metatags.canonical (one URL stamped on every page told
                // crawlers the whole site duplicates it); the filter here
                // guards versions stored before that change.
                siteMeta: [
                    ...Object.entries(ctx.seo.metatags)
                        .filter(
                            ([name]) =>
                                ![
                                    "canonical",
                                    // Consumed into the per-page og:image
                                    // precedence above — emitting the site-
                                    // level copy would double the tags.
                                    "og:image",
                                    "twitter:image",
                                    // A site og:locale describes the default
                                    // locale; a translated page's own tag
                                    // (from seo.language) must win.
                                    ...(ctx.activeLocale ? ["og:locale"] : []),
                                ].includes(name.toLowerCase()),
                        )
                        .map(([name, content]) => ({
                            ...(name.startsWith("og:")
                                ? { property: name }
                                : { name }),
                            content,
                        })),
                    ...ctx.seo.headMeta,
                ],
                meta: [
                    ...(!isPageIndexable(ctx, page)
                        ? [{ name: "robots", content: "noindex,follow" }]
                        : []),
                    { property: "og:image", content: ogImage },
                    { name: "twitter:image", content: ogImage },
                    // The generated card is always 1200×630; explicit
                    // frontmatter/site overrides have unknown dimensions.
                    ...(ogImage === generatedOgImage
                        ? [
                              { property: "og:image:width", content: "1200" },
                              { property: "og:image:height", content: "630" },
                              { name: "twitter:image:width", content: "1200" },
                              {
                                  name: "twitter:image:height",
                                  content: "630",
                              },
                          ]
                        : []),
                ],
            },
            siteName: ctx.identity.name,
            // Frontmatter supplies only authored overrides. Derive `wide`
            // here for API console pages, whose two-column layout cannot fit
            // the default article width. Require an OpenAPI document so a
            // missing-spec fallback stays at the default width.
            pageMode:
                page.data.frontmatter.mode ?? (openapi ? "wide" : "default"),
            // The editorial preset hides the TOC rail — rail placements
            // need to know.
            layoutPreset: ctx.layoutPreset,
            layout: {
                ...layoutInput,
                // Star count fetched HERE (memoized an hour per repo) and
                // server-rendered: the widget used to call api.github.com
                // from every visitor's browser — a layout shift on mount, a
                // third-party request per page view, and GitHub's 60/h
                // unauthenticated limit per visitor IP.
                githubStars,
            },
        }
    })

type OpenapiLoaderData = Awaited<ReturnType<typeof serverLoader>>["openapi"]

/**
 * Compiled MDX executes site code, so this component only ever renders in
 * the browser: on the server the same compiled JS runs inside the host-less
 * V8 isolate (lib/sandbox-render.ts) and arrives as `ssrHtml`, which
 * SandboxedBody shows until this mounts. Data-only pages use `HastBody`; this
 * path handles MDX expressions and JS/JSX snippets.
 */
const MdxBody = lazy(() =>
    import("@/components/mdx-body").then((module) => ({
        default: module.MdxBody,
    })),
)

/**
 * Server snapshot → live body swap. The snapshot node renders first, at a
 * fixed position, and is never re-created: after a document load its
 * hydrated value is an empty SsrSnapshot (the HTML is not dehydrated, see
 * lib/ssr-snapshot.ts), and React keeps the server markup because the
 * `__html` it hydrated with never changes (suppressHydrationWarning silences
 * the dev-only mismatch). Crawlers and no-JS readers get the full article.
 * After hydration MdxBody mounts beside it; its layout-phase onReady removes
 * the snapshot in the same pre-paint commit — one paint, no skeleton, no
 * doubled article, no duplicate heading ids for anchors and the TOC — and
 * the TOC re-observation still fires from there. The null slot keeps
 * MdxBody's position, so the swap never remounts it.
 */
function SandboxedBody(props: {
    ssrHtml: SsrSnapshot | string
    compiledJs: string
    onReady?: () => void
}) {
    const [live, setLive] = useState(false)
    const [ready, setReady] = useState(false)
    useLayoutEffect(() => {
        setLive(true)
    }, [])
    const { onReady } = props
    const onLiveReady = useCallback(() => {
        setReady(true)
        onReady?.()
    }, [onReady])
    return (
        <>
            {ready ? null : (
                <div
                    data-ssr-body=""
                    suppressHydrationWarning
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: isolate output the host sanitized to the §4.6 rules (lib/sandbox-render.ts), or the sanitized declined-render fallback
                    dangerouslySetInnerHTML={{
                        __html:
                            // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- SSR snapshot is the isolate's renderToString output, sanitized on the host to the §4.6 element/attribute/URL rules before it is memoized
                            typeof props.ssrHtml === "string"
                                ? props.ssrHtml
                                : props.ssrHtml.html,
                    }}
                />
            )}
            {live ? (
                // The executor chunk loads lazily; the snapshot stays on
                // screen until it resolves so the article never blanks.
                <Suspense fallback={null}>
                    <MdxBody
                        compiledJs={props.compiledJs}
                        onReady={onLiveReady}
                    />
                </Suspense>
            ) : null}
        </>
    )
}

/**
 * "Try it" in the endpoint bar: opens the playground modal the API console's
 * TryIt renders (api-playground-state context). Null outside the provider —
 * bar-only pages (playground disabled) show no button.
 */
function EndpointTryIt() {
    const playground = useApiPlayground()
    const strings = useChromeStrings()
    if (!playground) return null
    return (
        <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={playground.open}
            data-endpoint-try-it=""
            onClick={() => playground.setOpen(true)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-fd-primary/10 px-3 font-medium text-fd-primary text-sm transition-colors hover:bg-fd-primary/20"
        >
            {strings.tryIt}
            <span aria-hidden className="text-[0.65rem]">
                ▶
            </span>
        </button>
    )
}

/** Fumadocs' container slot is the framework boundary for page semantics. */
function SemanticPageContainer({
    children,
    className,
    ...containerProps
}: ComponentProps<"main">) {
    const { full } = useDocsPage()
    return (
        <main
            {...containerProps}
            id="nd-page"
            data-full={full}
            className={cn(
                "flex w-full max-w-[900px] flex-col [grid-area:main] mx-auto gap-4 px-4 py-6 md:px-6 md:pt-8 xl:px-8 xl:pt-14",
                full && "max-w-[1168px]",
                className,
            )}
        >
            <article className="contents">{children}</article>
        </main>
    )
}

function DocContent(props: {
    body: Exclude<DocsPageBody, { kind: "openapi" }> | null
    openapi: OpenapiLoaderData
    toc: TOCItemType[]
    title: string
    description?: string
    markdownUrl: string
    eyebrow: string | null
    /** Operation pages: endpoint bar under the H1. */
    endpoint: { method: string; path: string; deprecated: boolean } | null
    /** Update pages: tag union for the Filters rail + the RSS button. */
    updates: { tags: string[] } | null
    pageUrl: string
    /** ISO lastModified when metadata.timestamp/frontmatter enables it. */
    timestamp: string | null
    /** contextual.display: "toc" moves the page actions into the TOC rail. */
    contextualDisplay?: "header" | "toc"
    /** Page layout mode — non-default modes hide the TOC rail. */
    pageMode: string
    /** Layout preset — editorial hides the TOC rail entirely. */
    layoutPreset: string
    provenance?: PageSeoProvenance
    editUrl: string | null
    issueUrl: string | null
    /** docs.json feedback.* — the thumbs row renders only when enabled. */
    feedback: {
        thumbsRating: boolean
        suggestEdit: boolean
        raiseIssue: boolean
    }
    pagination: {
        previous: { name: string; url: string } | null
        next: { name: string; url: string } | null
    }
    /** Desktop chrome structure — sidenav (maple) renders the
     * plain-Previous + prominent-Next pagination instead of twin cards. */
    chrome: "band" | "sidenav"
    socials: NonNullable<LayoutConfig["footer"]>["socials"]
    /** docs.json footer.links columns (multi-column page footer). */
    footerLinks?: unknown
    contextualOptions?: readonly unknown[]
    /** luma (contrast preset) chrome: the docked assistant bar at the foot
     * of the article column and the main-area footer with the logo column
     * and theme bar, in place of the in-column footer. */
    luma?: {
        logo: ReactNode
        logoHref: string
        themeSwitchEnabled: boolean
        assistant: boolean
    }
}) {
    const locale = useActiveLocale()
    const strings = chromeStringsFor(locale)
    // Compiled-JS bodies swap the server snapshot for live React after
    // hydration, replacing the heading nodes AnchorProvider observed. Swap
    // the TOC identity once the live body lands to re-run the lookup; hast
    // bodies keep their headings across hydration.
    const [observed, setObserved] = useState<{
        source: TOCItemType[]
        clone: TOCItemType[]
    } | null>(null)
    const sourceToc = props.toc
    const toc = observed?.source === sourceToc ? observed.clone : sourceToc
    const onBodyReady = useCallback(() => {
        setObserved((previous) =>
            previous?.source === sourceToc
                ? previous
                : { source: sourceToc, clone: [...sourceToc] },
        )
    }, [sourceToc])
    // Server-rendered loading state for client-only bodies: shown
    // pre-hydration by ClientOnly AND during the lazy OpenAPI chunk load.
    const bodySkeleton = (
        <div
            role="status"
            aria-busy="true"
            aria-label="Loading page content"
            className="flex flex-col gap-3 py-2"
        >
            <div className="h-4 w-4/5 animate-pulse rounded bg-fd-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-fd-muted" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-fd-muted" />
            <div className="mt-2 h-32 w-full animate-pulse rounded-lg bg-fd-muted" />
        </div>
    )
    // contextual.display "toc" is honored only where the rail actually
    // renders: default page mode (wide/center/custom/frame collapse the TOC
    // column — API pages are wide by default) and no ChangelogFilters rail.
    // Everywhere else the actions stay in the title row, and when railed a
    // mobile copy stays in the title row (the rail is xl-only).
    const actionsInRail =
        props.contextualDisplay === "toc" &&
        props.pageMode === "default" &&
        props.layoutPreset !== "editorial" &&
        !(props.updates && props.updates.tags.length > 0)
    const pageActions = (
        <PageActions
            markdownUrl={props.markdownUrl}
            options={props.contextualOptions}
            // The contextual "github" option opens this page's
            // source (the edit link's /blob/ spelling).
            githubUrl={props.editUrl?.replace("/edit/", "/blob/") ?? null}
            // download-spec is API-reference-pages-only — the doc id pins the download to the spec backing
            // THIS page (multi-spec sites). Same URL the console fetches,
            // so both share one CDN entry.
            specUrl={props.openapi?.specUrl ?? null}
            // download-pdf: the per-page PDF route shares the markdown URL's
            // exact shape (locale/version-prefixed docs path + suffix), so
            // it derives from it instead of re-walking the slugs.
            pdfUrl={props.markdownUrl.replace(/\.md$/, ".pdf")}
        />
    )
    const page = (
        // The default breadcrumb derives "Pm › Cli" from raw path segments;
        // the eyebrow renders the authored group title instead.
        <DocsPage
            toc={toc}
            slots={{ container: SemanticPageContainer }}
            breadcrumb={{ enabled: false }}
            // Always render the mobile title bar: fumadocs auto-disables it
            // when toc is empty, which left guides pages (no h2s) with no
            // secondary chrome at all below md. The group name rides the
            // trigger's title attribute — app.css renders it as a
            // "Group › Page" breadcrumb prefix via attr() (the trigger's
            // children are fixed upstream, and React's DOM prop types
            // reject data-* keys in object literals).
            tableOfContentPopover={{
                enabled: true,
                trigger: {
                    ...(props.eyebrow ? { title: props.eyebrow } : {}),
                },
            }}
            // Update pages replace the "On this page" rail with
            // a tag Filters panel (the component supplies its own grid-area
            // wrapper).
            // luma marks ONE TOC item (the nearest heading); other presets
            // keep fumadocs' every-visible-heading highlight with the bar.
            tableOfContent={{
                single: props.layoutPreset === "contrast",
                ...(props.updates && props.updates.tags.length > 0
                    ? {
                          enabled: true,
                          component: (
                              // Keyed by page identity: two changelogs with
                              // identical tag unions must still remount the
                              // rail on navigation so selection resets and
                              // the new sections get queried.
                              <ChangelogFilters
                                  key={props.pageUrl}
                                  tags={props.updates.tags}
                              />
                          ),
                      }
                    : props.pageMode === "default" &&
                        props.layoutPreset !== "editorial" &&
                        props.body?.kind === "hast" &&
                        props.body.railHastJson
                      ? {
                            enabled: true,
                            component: (
                                // Remount the rail per page. Only default,
                                // non-editorial pages have a TOC column; other
                                // modes show pinned content inline.
                                <PageRail
                                    key={props.pageUrl}
                                    hastJson={props.body.railHastJson}
                                    header={
                                        actionsInRail ? (
                                            <div className="mb-2">
                                                {pageActions}
                                            </div>
                                        ) : null
                                    }
                                />
                            ),
                        }
                      : actionsInRail
                        ? {
                              // docs.json contextual.display "toc": the page
                              // actions live at the top of the rail.
                              header: <div className="mb-2">{pageActions}</div>,
                          }
                        : {}),
            }}
            // fumadocs' pagination cards are replaced wholesale (see the
            // pagination render below) — its FooterItem markup can't show
            // a caption-over-title layout.
            footer={{ enabled: false }}
        >
            {/* `mode: frame`/`custom` pages (docs.json) own their whole
                header: the eyebrow, title row and description are not
                rendered. */}
            {props.pageMode === "frame" ||
            props.pageMode === "custom" ? null : (
                <>
                    {props.eyebrow ? (
                        // Eyebrow: semibold with a ~10px gap to the title
                        // (the page container's gap-4 minus this margin).
                        <span
                            data-eyebrow=""
                            className="-mb-1.5 font-semibold text-fd-primary text-sm"
                        >
                            {props.eyebrow}
                        </span>
                    ) : null}
                    {/* The "Copy page ▾" split button sits at the title's
                right, menu driven by contextual.options;
                contextual.display "toc" relocates it into the rail header. */}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        {/* text-4xl: 36px titles; fumadocs'
                    text-[1.75em] default is 28px. This matches the 2.25rem
                    baseline app.css sets on article h1s. */}
                        <DocsTitle className="text-4xl">
                            {props.title}
                        </DocsTitle>
                        {/* Visible on mobile too — flex-wrap drops the
                    button below the title when the row is tight. */}
                        <div className="mt-1 flex items-center gap-2">
                            {actionsInRail ? (
                                <div className="xl:hidden">{pageActions}</div>
                            ) : (
                                pageActions
                            )}
                            {props.updates ? (
                                // RSS button beside "Copy page" on
                                // Update pages; the feed route mirrors the .md
                                // agent rendition's URL shape.
                                <a
                                    href={props.markdownUrl.replace(
                                        /\.md$/,
                                        ".rss.xml",
                                    )}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    aria-label={strings.openRss}
                                    data-testid="rss-feed-button"
                                    className="inline-flex size-8 items-center justify-center rounded-lg border text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground"
                                >
                                    <span className="sr-only">
                                        {strings.openRss}
                                    </span>
                                    {/* aria-hidden decorative glyph — no role="img"
                                (an img role on a hidden node is an a11y
                                lint conflict; the link carries the name). */}
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        aria-hidden
                                        className="size-4"
                                    >
                                        <title>RSS</title>
                                        <path d="M4 11a9 9 0 0 1 9 9" />
                                        <path d="M4 4a16 16 0 0 1 16 16" />
                                        <circle cx="5" cy="19" r="1" />
                                    </svg>
                                </a>
                            ) : null}
                        </div>
                    </div>
                    {props.endpoint ? (
                        // Endpoint bar: method pill + route, with the
                        // playground toggle when Try-it is enabled. The console's
                        // own header slot is suppressed (api-page.tsx).
                        <div className="api-endpoint-bar not-prose flex flex-wrap items-center gap-3 rounded-xl border bg-fd-card px-4 py-2.5">
                            <span
                                className="api-method-badge"
                                data-api-method={props.endpoint.method.toLowerCase()}
                            >
                                {props.endpoint.method}
                            </span>
                            <code className="min-w-0 flex-1 truncate font-mono text-fd-foreground/90 text-sm">
                                {/* Each {param} in the route renders as a
                                    chip so the placeholders read as inputs, not
                                    literal path text. */}
                                {props.endpoint.path
                                    .split(/(\{[^}]+\})/)
                                    .map((part, index) =>
                                        /^\{[^}]+\}$/.test(part) ? (
                                            <span
                                                // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional path segments
                                                key={index}
                                                data-path-param=""
                                                className="rounded-md bg-fd-primary/10 px-1.5 py-0.5 text-fd-primary"
                                            >
                                                {part}
                                            </span>
                                        ) : (
                                            part
                                        ),
                                    )}
                            </code>
                            {props.endpoint.deprecated ? (
                                <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 text-xs dark:text-amber-400">
                                    {strings.deprecated}
                                </span>
                            ) : null}
                            {props.openapi?.console.display ===
                            "interactive" ? (
                                <EndpointTryIt />
                            ) : null}
                        </div>
                    ) : null}
                    {props.description ? (
                        <DocsDescription className="mb-0">
                            {/* Descriptions render as markdown; backtick spans
                        are the only inline construct the corpus uses. */}
                            {props.description
                                .split(/(`[^`]+`)/)
                                .map((part, index) =>
                                    part.startsWith("`") &&
                                    part.endsWith("`") ? (
                                        <code
                                            // biome-ignore lint/suspicious/noArrayIndexKey: static split, never reorders
                                            key={index}
                                            className="rounded-md border bg-fd-muted px-1 py-0.5 font-mono text-[0.85em]"
                                        >
                                            {part.slice(1, -1)}
                                        </code>
                                    ) : (
                                        part
                                    ),
                                )}
                        </DocsDescription>
                    ) : null}
                </>
            )}
            {/* Code block "Report issue" actions extend this page's
                prefilled GitHub issue URL (null → action hidden). */}
            <CodeIssueContext value={props.issueUrl}>
                <DocsBody>
                    <ArticleImages>
                        {props.body?.kind === "hast" ? (
                            // SSR renders pure-data bodies without site code. Key
                            // by page so stateful components like ViewGroup reset on
                            // navigation instead of carrying stale selections.
                            <HastBody
                                key={props.pageUrl}
                                hastJson={props.body.hastJson}
                            />
                        ) : props.body?.kind === "js" ? (
                            // Site JS renders in the browser after hydration. The
                            // isolate's snapshot (or, when the isolate declined, the
                            // stored rendition) fills the article until then.
                            // Contain component errors so one bad site
                            // component cannot blank the route. Keyed per page:
                            // boundary state never resets on client navigation, so
                            // one crashing body would otherwise show the notice on
                            // every later page (review finding).
                            <BodyErrorBoundary key={props.pageUrl}>
                                {props.body.ssrHtml !== null ? (
                                    <SandboxedBody
                                        ssrHtml={props.body.ssrHtml}
                                        compiledJs={props.body.compiledJs}
                                        onReady={onBodyReady}
                                    />
                                ) : (
                                    <ClientOnly fallback={bodySkeleton}>
                                        {/* The executor chunk loads lazily: keep the
                                        skeleton local so the suspension never
                                        reaches the route boundary. */}
                                        <Suspense fallback={bodySkeleton}>
                                            <MdxBody
                                                compiledJs={
                                                    props.body.compiledJs
                                                }
                                                onReady={onBodyReady}
                                            />
                                        </Suspense>
                                    </ClientOnly>
                                )}
                            </BodyErrorBoundary>
                        ) : null}
                        {props.openapi ? (
                            // Keep the interactive, lazy API console client-only.
                            // Reuse the skeleton while its chunk loads to avoid a
                            // blank article on first render.
                            <ClientOnly fallback={bodySkeleton}>
                                <BodyErrorBoundary key={props.pageUrl}>
                                    <Suspense fallback={bodySkeleton}>
                                        <OpenApiBody
                                            {...props.openapi.props}
                                            specUrl={props.openapi.specUrl}
                                            proxyUrl={props.openapi.proxyUrl}
                                            console={props.openapi.console}
                                        />
                                    </Suspense>
                                </BodyErrorBoundary>
                            </ClientOnly>
                        ) : null}
                    </ArticleImages>
                </DocsBody>
            </CodeIssueContext>
            {props.provenance ? (
                <aside
                    aria-label="Source attribution"
                    className="not-prose flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-fd-muted/40 px-3 py-2 text-fd-muted-foreground text-sm"
                >
                    <span>Source:</span>
                    <a
                        href={props.provenance.sourceUrl}
                        rel="noreferrer noopener"
                        className="font-medium text-fd-foreground underline decoration-fd-border underline-offset-4 hover:decoration-fd-foreground"
                    >
                        {props.provenance.name}
                    </a>
                    {props.provenance.license ? (
                        <>
                            <span aria-hidden>·</span>
                            <a
                                href={props.provenance.license.url}
                                rel="license noreferrer noopener"
                                className="underline decoration-fd-border underline-offset-4 hover:decoration-fd-foreground"
                            >
                                {props.provenance.license.name}
                            </a>
                        </>
                    ) : null}
                </aside>
            ) : null}
            {props.timestamp ? (
                // docs.json metadata.timestamp — deterministic SSR-safe
                // formatting (the page's locale + UTC: both sides of
                // hydration derive the same tag, so no drift).
                <time
                    dateTime={props.timestamp}
                    className="text-fd-muted-foreground text-sm"
                >
                    {strings.lastUpdatedOn}{" "}
                    {new Intl.DateTimeFormat(locale, {
                        dateStyle: "long",
                        timeZone: "UTC",
                    }).format(new Date(props.timestamp))}
                </time>
            ) : null}
            {props.pageMode !== "frame" &&
            props.pageMode !== "custom" &&
            (props.feedback.thumbsRating || props.editUrl || props.issueUrl) ? (
                <PageFeedback
                    pageUrl={props.pageUrl}
                    thumbsRating={props.feedback.thumbsRating}
                    editUrl={props.editUrl}
                    issueUrl={props.issueUrl}
                />
            ) : null}
            {(props.pagination.previous || props.pagination.next) &&
            props.pageMode !== "frame" &&
            props.pageMode !== "custom" &&
            props.chrome === "sidenav" ? (
                // maple pagination: a plain muted "Previous" text
                // link beside ONE prominent Next card, right-aligned.
                <div className="mt-10 flex items-center justify-end gap-5 text-sm">
                    {props.pagination.previous ? (
                        <ChromeLink
                            href={props.pagination.previous.url}
                            className="inline-flex items-center gap-1 text-fd-muted-foreground transition-colors hover:text-fd-accent-foreground"
                        >
                            <ChevronLeftIcon className="-ms-1 size-3.5" />
                            {strings.previous}
                        </ChromeLink>
                    ) : null}
                    {props.pagination.next ? (
                        <ChromeLink
                            href={props.pagination.next.url}
                            className="flex w-1/2 flex-col items-end gap-1.5 rounded-xl border p-4 text-end transition-colors hover:bg-fd-accent/50"
                        >
                            <span className="inline-flex items-center gap-1 text-fd-muted-foreground text-xs">
                                {strings.next}
                                <ChevronRightIcon className="-me-1 size-3.5" />
                            </span>
                            <span className="font-medium">
                                {props.pagination.next.name}
                            </span>
                        </ChromeLink>
                    ) : null}
                </div>
            ) : (props.pagination.previous || props.pagination.next) &&
              props.pageMode !== "frame" &&
              props.pageMode !== "custom" ? (
                // Pagination (pagination-prev/-next): the page
                // title first, then the muted "Previous"/"Next" caption with
                // its chevron — no description line. 12/16 padding, 12px
                // radius.
                <div className="mt-10 grid grid-cols-2 gap-4 text-sm">
                    {props.pagination.previous ? (
                        <ChromeLink
                            href={props.pagination.previous.url}
                            rel="prev"
                            className="flex flex-col gap-1 rounded-xl border px-4 py-3 transition-colors hover:bg-fd-accent/50"
                        >
                            <span className="truncate font-medium">
                                {props.pagination.previous.name}
                            </span>
                            <span className="inline-flex items-center gap-1 text-fd-muted-foreground text-sm">
                                <ChevronLeftIcon className="-ms-1 size-3.5" />
                                {strings.previous}
                            </span>
                        </ChromeLink>
                    ) : (
                        <div />
                    )}
                    {props.pagination.next ? (
                        <ChromeLink
                            href={props.pagination.next.url}
                            rel="next"
                            className="flex flex-col items-end gap-1 rounded-xl border px-4 py-3 text-end transition-colors hover:bg-fd-accent/50"
                        >
                            <span className="truncate font-medium">
                                {props.pagination.next.name}
                            </span>
                            <span className="inline-flex items-center gap-1 text-fd-muted-foreground text-sm">
                                {strings.next}
                                <ChevronRightIcon className="-me-1 size-3.5" />
                            </span>
                        </ChromeLink>
                    ) : null}
                </div>
            ) : null}
            {props.luma ? null : (
                <>
                    {/* Socials sit at the very bottom of the page column,
                        left-aligned. */}
                    <FooterSocials socials={props.socials} />
                    {/* Multi-column footer from docs.json footer.links —
                        official page ends, not sidebar menus. */}
                    <DocsFooter links={props.footerLinks} />
                </>
            )}
            {props.luma?.assistant ? <AssistantDock /> : null}
        </DocsPage>
    )
    const content = props.luma ? (
        <>
            {page}
            {/* luma footer spans the main + TOC tracks of #nd-docs-layout
                in the row below main, not the article column. */}
            <DocsFooter
                variant="luma"
                links={props.footerLinks}
                socials={props.socials}
                logo={props.luma.logo}
                logoHref={props.luma.logoHref}
                themeSwitchEnabled={props.luma.themeSwitchEnabled}
            />
        </>
    ) : (
        page
    )
    // The endpoint bar's Try-it button and the console's playground modal
    // share one open-state; non-API pages skip the provider. The bar's
    // operation is keyed by its RAW OpenAPI path — props.endpoint.path is
    // the display string, server-expanded under api.url "full".
    return props.openapi ? (
        <ApiPlaygroundProvider
            endpoint={
                props.endpoint
                    ? (props.openapi.props.operations?.[0] ?? null)
                    : null
            }
        >
            {content}
        </ApiPlaygroundProvider>
    ) : (
        content
    )
}

function Page() {
    const data = Route.useLoaderData()
    // The hydrated document carried its chrome inline: seed the browser memo
    // so the first client navigation within this tree fetches none.
    useEffect(() => {
        const key = JSON.stringify(data.chromeKey)
        if (!browserChrome.has(key))
            browserChrome.set(
                key,
                Promise.resolve({
                    config: data.layout.config,
                    versionsManifest: data.layout.versionsManifest,
                    pageTree: data.pageTree,
                }),
            )
    }, [data])
    const strings = useChromeStrings()
    const hotkey = useAssistantHotkeyLabel()
    const { body, openapi, toc, title, description, markdownUrl } = data
    // deserializePageTree rewrites its argument in place, and the serialized
    // tree is shared — the server memo (treeDerivations) during SSR, the
    // browser chrome memo and the router cache after it — so deserialize a
    // copy and leave the shared tree serializable.
    const pageTree = useMemo(
        () => deserializePageTree(structuredClone(data.pageTree)),
        [data.pageTree],
    )
    // Assistant "Suggestions": the page's first three headings.
    const suggestions = toc.flatMap((item: TOCItemType) =>
        typeof item.title === "string" ? [item.title] : [],
    )
    const { githubRepo, ...layoutOptions } = baseOptions(data.layout)
    // maple pins the navbar destinations (e.g. a Dashboard link, the CTA)
    // at the sidebar bottom; band sites show the same set in the header
    // only (real band sites pin nothing there) and the drawer carries
    // md:hidden copies, so the footer set is sidenav desktop-only.
    const footerLinks = navbarChromeLinks(data.layout.config)
    // nav.title is always a plain node here (baseOptions never sets the
    // function form); the typeof check narrows without a cast.
    const navTitle = layoutOptions.nav?.title
    const logo =
        typeof navTitle === "function" ? data.layout.siteName : navTitle
    // Object-form docs.json logo.href points the wordmark at the site's
    // marketing site; string/absent forms keep "/".
    const configLogo = data.layout.config?.logo
    const logoHref =
        configLogo &&
        typeof configLogo === "object" &&
        configLogo.href &&
        isAllowedUrl(configLogo.href)
            ? configLogo.href
            : "/"
    const versions = versionSwitcherModel(
        data.layout.versionsManifest,
        data.layout.activeLocale,
    )
    // Desktop chrome structure: maple relocates the band's contents into the
    // sidebar (SidebarChrome below); everything else keeps the band.
    const chrome = chromeMode(data.layout.config)
    const themeSwitchEnabled = data.layout.config?.appearance?.strict !== true
    // Per-version config; assistant availability is deployment-wide and
    // rides the root loader.
    const searchMode = searchModeOf(
        data.layout.config,
        rootApi.useLoaderData({ select: (root) => root.assistantAvailable }),
    )
    // luma (contrast preset): upstream's header assistant control is a 36px
    // round sparkle icon button (aria-label "Toggle assistant panel"); other
    // themes keep the labelled "Assistant ⌘I" pill.
    const luma = data.layoutPreset === "contrast"
    const aiTrigger =
        searchMode === "ai" ? (
            luma ? (
                <AISearchTrigger
                    aria-label={strings.assistant}
                    title={`${strings.assistant} (${hotkey})`}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-fd-foreground/[0.03] text-fd-foreground transition-colors hover:bg-fd-foreground/[0.07]"
                >
                    <SparklesIcon className="size-4" />
                </AISearchTrigger>
            ) : (
                <AISearchTrigger
                    className={cn(
                        buttonVariants({
                            variant: "secondary",
                            className:
                                "h-9 gap-1.5 rounded-xl px-3 text-fd-muted-foreground",
                        }),
                    )}
                >
                    <MessageCircleIcon className="size-4" />
                    {strings.assistant}
                    <kbd className="ms-0.5 rounded border px-1 font-sans text-[0.65rem] text-fd-muted-foreground">
                        {hotkey}
                    </kbd>
                </AISearchTrigger>
            )
        ) : undefined

    const chromeAndContent = (
        <>
            {/* Desktop header band + tab row. The sticky
                offset handshake with #nd-docs-layout lives in styles/app.css
                (--docs-band-height). Sidenav sites render no band: its
                absence self-corrects the sticky offsets (`:root:has(
                #docs-band)`) and the chrome moves into sidebar.banner. */}
            {chrome === "band" ? (
                <DocsHeader
                    logo={logo}
                    logoHref={logoHref}
                    config={data.layout.config}
                    activeTabKey={data.activeTab}
                    themeSwitchEnabled={themeSwitchEnabled}
                    locales={data.layout.locales ?? undefined}
                    versions={versions}
                    githubRepo={
                        githubRepo
                            ? { ...githubRepo, stars: data.layout.githubStars }
                            : undefined
                    }
                    aiTrigger={aiTrigger}
                    layoutPreset={data.layoutPreset}
                />
            ) : null}
            <DocsLayout
                {...layoutOptions}
                tree={pageTree}
                // Content tabs as explicit LayoutTab[]: the tab-scoped page
                // tree hides sibling tabs from fumadocs' auto-derivation, so
                // without this the mobile drawer has NO way to reach other
                // sections. Exact `urls` membership drives the active state
                // (docs.json tabs span mixed directories; prefix-matching
                // cannot). Desktop keeps the band as the tab surface.
                tabs={bandTabs(data.layout.config)
                    .filter(
                        (tab) =>
                            tab.urls !== null &&
                            (!tab.hidden || tab.key === data.activeTab),
                    )
                    .map((tab) => ({
                        title: tab.title,
                        url: tab.href,
                        // Membership lists no longer ship to the client; the
                        // loader already resolved the active tab.
                        urls:
                            tab.key === data.activeTab
                                ? new Set([
                                      // The router's (unprefixed) path.
                                      data.seo.canonical.slice(
                                          data.seo.siteUrl.length,
                                      ) || "/",
                                  ])
                                : undefined,
                        icon: iconSpan(tab.icon),
                    }))}
                sidebar={{
                    // Sidenav chrome has no collapse control (maple); band
                    // keeps fumadocs' default. The trigger renders inside
                    // the sidebar header block that app.css already
                    // manages per chrome mode.
                    ...(chrome === "sidenav" ? { collapsible: false } : {}),
                    // Only sidenav sites pin navbar links at the sidebar
                    // bottom; band sites keep them in the header. The widget
                    // boundary contains GitHub API failures to the widget.
                    footer:
                        chrome === "sidenav" &&
                        (githubRepo || footerLinks.length > 0) ? (
                            <div className="flex w-full flex-col">
                                {footerLinks.length > 0 ? (
                                    <ul className="flex flex-col gap-0.5 max-md:hidden">
                                        {footerLinks.map((link) => (
                                            <li
                                                key={link.href}
                                                className="navbar-link"
                                            >
                                                <ChromeLink
                                                    href={link.href}
                                                    {...(link.external
                                                        ? {
                                                              rel: "noreferrer noopener",
                                                          }
                                                        : {})}
                                                    className={
                                                        // Keep CTA styling consistent with the band and drawer.
                                                        link.primary
                                                            ? buttonVariants({
                                                                  variant:
                                                                      "primary",
                                                                  className:
                                                                      "w-full gap-1.5 rounded-lg",
                                                              })
                                                            : "flex items-center gap-2 rounded-lg p-2 text-fd-muted-foreground text-sm transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground [&_svg]:size-3.5"
                                                    }
                                                >
                                                    {iconSpan(link.icon)}
                                                    {link.label}
                                                    {link.external &&
                                                    !link.icon &&
                                                    !link.primary ? (
                                                        <ExternalLinkIcon />
                                                    ) : null}
                                                </ChromeLink>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                                {githubRepo ? (
                                    <GithubWidget
                                        owner={githubRepo.owner}
                                        repo={githubRepo.repo}
                                        stars={data.layout.githubStars}
                                    />
                                ) : null}
                            </div>
                        ) : undefined,
                    // Place the site logo before the drawer controls;
                    // link-only anchors render separately above the page tree.
                    banner: (
                        <>
                            <ChromeLink
                                href={logoHref}
                                className="-order-1 inline-flex items-center md:hidden"
                            >
                                {logo}
                            </ChromeLink>
                            {chrome === "sidenav" ? (
                                // Sidenav mode: tabs render as a vertical
                                // icon nav under the sidebar's
                                // logo/search/theme chrome. The compact
                                // assistant button rides beside the
                                // search pill like upstream maple's
                                // 36px square trigger.
                                <SidebarChrome
                                    logo={logo}
                                    logoHref={logoHref}
                                    config={data.layout.config}
                                    activeTabKey={data.activeTab}
                                    themeSwitchEnabled={themeSwitchEnabled}
                                    locales={data.layout.locales ?? undefined}
                                    versions={versions}
                                    aiTrigger={
                                        searchMode === "ai" ? (
                                            <AISearchTrigger
                                                aria-label={strings.assistant}
                                                className={cn(
                                                    buttonVariants({
                                                        variant: "secondary",
                                                        className:
                                                            "size-9 shrink-0 rounded-full p-0 text-fd-muted-foreground",
                                                    }),
                                                )}
                                            >
                                                <MessageCircleIcon className="size-4" />
                                            </AISearchTrigger>
                                        ) : undefined
                                    }
                                />
                            ) : null}
                        </>
                    ),
                }}
                slots={{
                    // The band owns logo, search and theme toggle on desktop;
                    // md:hidden keeps them for the mobile header + drawer.
                    // The mobile header logo caps at h-6 (a compact
                    // 24px wordmark vs the band's 28px).
                    navTitle: (props) => (
                        <ChromeLink
                            href={logoHref}
                            {...props}
                            className={cn(
                                props.className,
                                "md:hidden [&_img]:h-6",
                            )}
                        >
                            {logo}
                        </ChromeLink>
                    ),
                    // Hamburger drawer trigger — the explicit
                    // children replace the SidebarIcon the subnav passes.
                    // root/useSidebar keep fumadocs' defaults; the slot is
                    // all-or-nothing. The provider wrapper adds dialog-like
                    // Escape dismissal to the drawer.
                    sidebar: {
                        provider: SidebarProviderWithEscape,
                        root: Sidebar,
                        useSidebar,
                        trigger: (props) => (
                            <SidebarTrigger {...props}>
                                <MenuIcon className="size-4.5" />
                            </SidebarTrigger>
                        ),
                    },
                    themeSwitch: (props) => (
                        // The mobile header/drawer control row carries
                        // the ONLY sub-md Search (the drawer's z-40
                        // overlay covers the z-30 header — ),
                        // Assistant trigger — the desktop band (their other
                        // home) is max-md:hidden (review findings). The
                        // locale switcher is fumadocs' own drawer select
                        // (RootProvider i18n), so it is NOT repeated here.
                        <>
                            <SearchTrigger className="text-fd-muted-foreground md:hidden" />
                            {searchMode === "ai" ? (
                                <DrawerAssistantTrigger />
                            ) : null}
                            <ThemeSwitch
                                {...props}
                                // The slot bypasses fumadocs' default wiring
                                // that spreads layout themeSwitch options in
                                // — restate the 3-state mode or the drawer
                                // falls back to the 2-state toggle.
                                mode="light-dark"
                                className={cn(props.className, "md:hidden")}
                            />
                        </>
                    ),
                    searchTrigger: {
                        sm: SearchTrigger,
                        full: (props) => (
                            <FullSearchTrigger
                                {...props}
                                className={cn(props.className, "md:hidden")}
                            />
                        ),
                    },
                }}
            >
                {searchMode === "ai" ? (
                    <>
                        <AISearchPanelSlot suggestions={suggestions} />
                        {/* Bottom-centred "Ask a question…"
                            bar (desktop only; hides while the panel is
                            open — AISearchTrigger position="float"). luma
                            docks a full input bar at the foot of the
                            article column instead (AssistantDock, in
                            DocContent). */}
                        {luma ? null : (
                            <AISearchTrigger
                                position="float"
                                data-assistant-float=""
                                className={cn(
                                    buttonVariants({
                                        variant: "secondary",
                                        className:
                                            "h-10 rounded-full border bg-fd-background px-4 text-fd-muted-foreground shadow-lg hover:text-fd-accent-foreground",
                                    }),
                                )}
                            >
                                <MessageCircleIcon className="size-4" />
                                {strings.askQuestion}…
                                <kbd className="rounded border px-1.5 font-sans text-[0.65rem]">
                                    {hotkey}
                                </kbd>
                            </AISearchTrigger>
                        )}
                    </>
                ) : null}
                {data.layout.config?.interaction?.drilldown ? (
                    <DrilldownNavigate />
                ) : null}
                {data.layout.webmcp ? (
                    <DocsWebmcpTools
                        tree={pageTree}
                        title={title}
                        pageUrl={data.seo.canonical}
                    />
                ) : null}

                <DocContent
                    body={body}
                    openapi={openapi}
                    toc={toc}
                    title={title}
                    description={description}
                    markdownUrl={markdownUrl}
                    eyebrow={data.eyebrow}
                    endpoint={data.endpoint}
                    updates={data.updates}
                    chrome={chrome}
                    timestamp={data.timestamp}
                    contextualDisplay={data.contextual?.display ?? "header"}
                    pageMode={data.pageMode}
                    layoutPreset={data.layoutPreset}
                    pageUrl={data.seo.canonical}
                    provenance={data.seo.provenance}
                    feedback={data.feedback}
                    editUrl={data.editUrl}
                    issueUrl={data.issueUrl}
                    pagination={data.pagination}
                    socials={data.layout.config?.footer?.socials}
                    contextualOptions={data.contextual?.options}
                    footerLinks={data.layout.config?.footer?.links}
                    luma={
                        luma
                            ? {
                                  logo,
                                  logoHref,
                                  themeSwitchEnabled,
                                  assistant: searchMode === "ai",
                              }
                            : undefined
                    }
                />
            </DocsLayout>
        </>
    )

    return (
        // `display: contents` wrapper: carries the page-mode and chrome data
        // attributes for the CSS in styles/presets/modes.css and
        // styles/app.css without adding a layout box. It sits above
        // #nd-docs-layout in the DOM, so mode rules target the layout and
        // its chrome as descendants.
        <div
            data-page-mode={data.pageMode}
            data-chrome={chrome}
            className="contents"
        >
            {/* Site-wide View selection (docs.json variations): the provider
                spans the whole page so every ViewGroup in the article — on
                either body path — shares one selection. Inert without
                configured options. */}
            <VariationsProvider
                options={data.layout.config?.variations?.options ?? null}
            >
                {/* The AISearch context lives in routes/__root.tsx (above
                    RootProvider, so the search dialog can hand a query to
                    the Assistant); the header trigger, the panel and the
                    floating bar all read it from there. */}
                {chromeAndContent}
            </VariationsProvider>
        </div>
    )
}

/**
 * fumadocs' mobile drawer is a plain Presence-managed div/aside pair — no
 * dialog semantics and no Escape handling, so Escape left it open and its
 * full-screen z-40 overlay kept blocking the z-30 mobile header.
 * The provider slot wraps fumadocs' SidebarProvider with a window Escape
 * listener that closes the open drawer and returns focus to the trigger.
 */
function SidebarProviderWithEscape({
    children,
    ...rest
}: ComponentProps<typeof SidebarProvider>) {
    return (
        <SidebarProvider {...rest}>
            <DrawerEscapeClose />
            {children}
        </SidebarProvider>
    )
}

/**
 * Assistant trigger for the drawer control row. The panel and its backdrop
 * are z-30 while the drawer is z-40 — opening the assistant UNDER the still-
 * open drawer left it unreachable (review finding), so the trigger closes
 * the drawer first. onClickCapture rides the trigger's props spread without
 * replacing its internal open-toggle onClick.
 */
function DrawerAssistantTrigger() {
    const { setOpen } = useSidebar()
    const strings = useChromeStrings()
    return (
        <AISearchTrigger
            aria-label={strings.assistant}
            onClickCapture={() => setOpen(false)}
            className={cn(
                buttonVariants({
                    variant: "ghost",
                    size: "icon",
                }),
                "text-fd-muted-foreground md:hidden",
            )}
        >
            <MessageCircleIcon className="size-4.5" />
        </AISearchTrigger>
    )
}

function DrawerEscapeClose() {
    const { open, setOpen, mode } = useSidebar()
    useEffect(() => {
        if (!open || mode !== "drawer") return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            // A modal above the drawer (search dialog, assistant) owns
            // Escape while it is open. The consumed-event check is the
            // reliable one: React can unmount the dialog before this
            // bubble-phase listener runs, so the DOM query alone double-
            // dismissed.
            if (event.defaultPrevented) return
            // data-state="open" = Radix dialogs (search); the :not clause =
            // the assistant panel, whose role="dialog" carries no data-state
            // (review finding: it was invisible to the open-state query).
            if (
                document.querySelector(
                    '[role="dialog"][data-state="open"], [role="dialog"]:not([data-state])',
                )
            )
                return
            event.preventDefault()
            setOpen(false)
            // Dialog-like focus return: the (now "Open Sidebar"-labeled)
            // trigger is the button that opened the drawer.
            requestAnimationFrame(() => {
                document
                    .querySelector<HTMLElement>(
                        'button[aria-label="Open Sidebar"]',
                    )
                    ?.focus()
            })
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [open, mode, setOpen])
    return null
}

/**
 * docs.json interaction.drilldown: opening a sidebar folder navigates to its
 * first page. fumadocs exposes no folder-toggle hook, so ONE delegated
 * click listener watches the sidebar surfaces; when a collapsible trigger
 * lands in the open state, the folder's first link is clicked (the anchor
 * carries the framework Link handler, so navigation stays client-side).
 */
function DrilldownNavigate() {
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (!(event.target instanceof Element)) return
            const trigger = event.target.closest(
                "#nd-sidebar button[aria-expanded], #nd-sidebar-mobile button[aria-expanded]",
            )
            if (!(trigger instanceof HTMLElement)) return
            // Radix flushes the toggle synchronously; the timeout reads the
            // post-toggle state and the freshly-mounted folder content.
            window.setTimeout(() => {
                if (trigger.getAttribute("aria-expanded") !== "true") return
                const link =
                    trigger.parentElement?.querySelector<HTMLAnchorElement>(
                        "a[href]",
                    )
                if (!link) return
                if (
                    link.getAttribute("aria-current") ||
                    link.dataset.active === "true"
                )
                    return
                link.click()
            }, 0)
        }
        document.addEventListener("click", onClick)
        return () => document.removeEventListener("click", onClick)
    }, [])
    return null
}

/**
 * Isolates site article errors so one failing component cannot remove the
 * route chrome. Keep the console error for the browser harness tripwire.
 */
class BodyErrorBoundary extends Component<
    { children: ReactNode },
    { failed: boolean }
> {
    override state = { failed: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    override render() {
        if (this.state.failed)
            return (
                <div
                    role="alert"
                    className="rounded-lg border bg-fd-muted/50 p-4 text-fd-muted-foreground text-sm"
                >
                    This section of the page failed to render.
                </div>
            )
        return this.props.children
    }
}
