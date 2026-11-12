import {
    createRootRoute,
    HeadContent,
    Outlet,
    Scripts,
    useLocation,
    useRouter,
} from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { Banner } from "fumadocs-ui/components/banner"
import { useSearchContext } from "fumadocs-ui/contexts/search"
import { RootProvider } from "fumadocs-ui/provider/tanstack"
import { type ComponentProps, lazy, useEffect, useRef } from "react"
import {
    boolean,
    catch as fallback,
    number,
    object,
    optional,
    pipe,
    string,
    transform,
    union,
} from "zod/mini"
import { extensions } from "#docs-extensions"
import geistMonoLatin from "@/assets/GeistMonoVariable-latin.woff2?url"
import interLatin from "@/assets/InterVariable-latin.woff2?url"
import { AISearch } from "@/components/ai/search-context"
import { DecorationWindows } from "@/components/decoration-windows"
import { HastBody } from "@/components/hast-body"
import { Toaster } from "@/components/ui/toast"
import { assistantAvailable } from "@/env"
import { agentConfig } from "@/lib/agent.config"
import { basePath, withBase } from "@/lib/base-path"
import {
    ChromeLocaleContext,
    chromeStringsFor,
    FUMADOCS_TRANSLATIONS,
    localeLabel,
    resolveChromeLocale,
    useActiveLocale,
} from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import { faviconLinks } from "@/lib/favicon"
import { resolveThemeOptions, searchModeOf } from "@/lib/layout.shared"
import { posthogClient } from "@/lib/observability"
import { appName, GENERATOR_NAME } from "@/lib/shared"
import {
    resolveDocsContext,
    servedUrlsPresent,
    serveLayoutConfig,
} from "@/lib/source"
import { renderThemeStyle } from "@/lib/theme-render"
import type { BrowserEvent } from "@/routes/api/agent.event"
import appCss from "@/styles/app.css?url"
import { matchRedirect } from "@/types/docs-shared"

declare global {
    interface Window {
        /** Segment analytics.js — method-stubbed by the bootstrap snippet. */
        analytics?: { page?: () => void }
        /** Intercom messenger — command-queue stub from the bootstrap snippet. */
        Intercom?: (
            command: "update",
            settings?: { last_request_at?: number },
        ) => void
    }
}

/**
 * Site branding for everything without its own loader (default <title>,
 * the 404 page's nav). Runs in-process during SSR; client navigations reuse
 * the cached data — the site can't change mid-session, the host is fixed.
 */
const rootLoader = createServerFn({ method: "GET" }).handler(async () => {
    const ctx = await resolveDocsContext(getRequest())
    // Started ahead of the servedUrlsPresent await so the two overlap.
    const layoutConfigPending = serveLayoutConfig(ctx)
    layoutConfigPending.catch(() => undefined)
    const siteName = ctx.identity.name
    const visibleLocales = ctx.localesManifest.filter(
        (entry) => entry.hidden !== true,
    )
    const defaultLanguage =
        ctx.localesManifest.find((entry) => entry.default)?.locale ??
        ctx.seo.language ??
        "en"
    // Version trees a URL prefix may name (/v1/…, /es/v1/…): the 404's
    // "Back to home" stays inside the active version when its index serves
    // (or a configured redirect lands it), like routes/$.tsx's tree-home
    // redirect, and search scopes its index by the same prefix. Hidden
    // locales are included — they are still navigable. Single-locale
    // sites have no locales manifest — their versions hang off the
    // site root.
    const versionHomeCandidates = (
        ctx.localesManifest.length > 0
            ? ctx.localesManifest.map((entry) => ({
                  locale: entry.locale,
                  base: entry.default ? "" : `/${entry.locale}`,
                  versionsManifest: entry.versionsManifest,
              }))
            : [
                  {
                      locale: defaultLanguage,
                      base: "",
                      versionsManifest: ctx.versionsManifest,
                  },
              ]
    ).flatMap((tree) =>
        tree.versionsManifest
            .filter((version) => version.directory.length > 0)
            .map((version) => ({
                locale: tree.locale,
                label: version.label,
                homeUrl: `${tree.base}/${version.label}`,
            })),
    )
    // Authored locale homes ("/" always serves: the compiler synthesizes the
    // root redirect) — a locale without a /<locale> index falls back to its
    // nav's first landing href below, the same rule as routes/$.tsx's
    // language selector, so the 404 page's "Back to home" never 404s again.
    const presentHomes = await servedUrlsPresent(ctx, [
        ...visibleLocales
            .filter((entry) => !entry.default)
            .map((entry) => `/${entry.locale}`),
        ...versionHomeCandidates.map((candidate) => candidate.homeUrl),
    ])
    const layoutConfig = await layoutConfigPending
    // The check only labels a page view, so a host's failing answer must
    // never cost the reader the page: it reads as off.
    let pageViewCheck = false
    if (agentConfig.observability.enabled && extensions.pageViewCheck)
        try {
            pageViewCheck = extensions.pageViewCheck.enabled(
                ctx.site,
                await extensions.resolveSite(getRequest()),
                posthogClient(),
            )
        } catch {
            pageViewCheck = false
        }
    return {
        siteName,
        language:
            ctx.activeLocale ??
            ctx.localesManifest.find((entry) => entry.default)?.locale ??
            ctx.seo.language ??
            "en",
        // Site default locale + the non-default tags a leading path segment
        // may name (source.ts resolveActiveLocale — hidden locales included,
        // they are still navigable). useActiveLocale re-derives the on-screen
        // locale from these on every client navigation; `language` above is
        // only the SSR document's <html lang>.
        defaultLanguage,
        // Every version tree a path prefix may name, served home or not:
        // the search clients key /api/search by locale + version prefix
        // instead of the page path, so one query shares one CDN entry
        // across every page of a tree.
        pathVersions: versionHomeCandidates.map(({ locale, label }) => ({
            locale,
            label,
        })),
        versionHomes: versionHomeCandidates.filter(
            (candidate) =>
                presentHomes.has(candidate.homeUrl) ||
                matchRedirect(candidate.homeUrl, ctx.redirects) !== null,
        ),
        pathLocales: ctx.localesManifest
            .filter((entry) => !entry.default)
            .map((entry) => entry.locale),
        // fumadocs' I18nProvider locale list — feeds its built-in strings'
        // language switcher metadata; the framework's own LocaleSwitch
        // renders from the page loader's per-page counterpart URLs.
        locales: visibleLocales.map((entry) => {
            const home = entry.default ? "/" : `/${entry.locale}`
            return {
                locale: entry.locale,
                name: localeLabel(entry.locale),
                homeUrl:
                    entry.default || presentHomes.has(home)
                        ? home
                        : (entry.nav.tabs.find((tab) => tab.resolvedHref)
                              ?.resolvedHref ?? home),
            }
        }),
        // Chrome-only layout config for pages without their own loader (the
        // 404 page, the landing page) so they keep the site's real header
        // instead of a text-only shell.
        layoutConfig,
        // docs.json appearance.default/strict → next-themes (spec §appearance).
        theme: resolveThemeOptions(layoutConfig),
        // The `?url` asset imports are root-relative on the server, while
        // the browser resolves its own copies against the importing chunk's
        // URL (vite.config.ts renderBuiltUrl): the server's prefixed hrefs
        // ride the loader data so both renders agree.
        assetHrefs: {
            appCss: withBase(appCss),
            interLatin: withBase(interLatin),
            geistMonoLatin: withBase(geistMonoLatin),
        },
        faviconLinks: faviconLinks({
            favicon: ctx.config?.favicon,
            siteName,
            primary: ctx.themeTokens["--color-fd-primary"],
        }),
        // Browser-chrome tint from the site background token (absent
        // token → no meta).
        themeColor: (() => {
            const token = ctx.themeTokens["--color-fd-background"]
            if (!token) return null
            return typeof token === "string"
                ? { light: token, dark: token }
                : token
        })(),
        // The token block stays inline (a few hundred bytes); the bulky
        // font + site CSS is a content-addressed stylesheet
        // (routes/[_]theme), so it ships once per browser instead of twice
        // in every document (rendered <style> plus this dehydrated payload).
        tokenCss: renderThemeStyle(ctx.themeTokens),
        siteCssHref: ctx.siteCssHash
            ? withBase(`/_theme/${ctx.siteCssHash}.css`)
            : null,
        // Deployment-level literal metas from the extensions module (a host's
        // origin-trial tokens); rendered ahead of HeadContent.
        headMeta: extensions.headMeta ?? [],
        // Whether pages report their views (SiteDocument), and whether
        // through the extension's page-view check, which must answer from
        // cache. First-party like the server's events: the observability
        // switch governs it, the site's analytics switch below does not.
        pageViews: {
            report: agentConfig.observability.enabled,
            check: pageViewCheck,
        },
        // Sites that mirror third-party docs keep their GA4/PostHog keys from
        // firing on our hostnames: analyticsEnabled = false drops every
        // configured integration (server-side telemetry is unaffected).
        integrations: ctx.site.analyticsEnabled ? ctx.integrations.enabled : {},
        // Layout preset + background decoration select framework CSS purely by
        // data (INV-2). data-preset lives on <html> so it reaches the Radix
        // chrome fumadocs portals to <body> (mobile sidebar, TOC popover).
        layoutPreset: ctx.layoutPreset,
        // The docs.json theme within its preset (maple vs almond, palm vs
        // willow, mint vs linden): presets restyle per theme on it.
        themeName: ctx.config?.theme ?? null,
        decoration: ctx.config?.background?.decoration ?? null,
        // docs.json background.image — a fixed page-wide layer; single values
        // apply to both schemes.
        backgroundImage: (() => {
            const image = ctx.config?.background?.image
            if (!image) return null
            return typeof image === "string"
                ? { light: withBase(image), dark: withBase(image) }
                : { light: withBase(image.light), dark: withBase(image.dark) }
        })(),
        banner: ctx.config?.banner
            ? {
                  content: ctx.config.banner.content,
                  type: ctx.config.banner.type,
                  dismissible: ctx.config.banner.dismissible,
                  // Ingest-compiled inline markdown; serialized like page
                  // hast bodies (source.ts/DocsPageBody) so the loader value
                  // stays plain JSON.
                  contentHastJson: ctx.config.banner.contentHast
                      ? JSON.stringify(ctx.config.banner.contentHast)
                      : null,
              }
            : null,
        // Deployment-level: without an AI Gateway credential the chrome
        // renders static search (layout.shared.ts searchModeOf).
        assistantAvailable: assistantAvailable(),
        // docs.json search.prompt — placeholder copy for the search dialog.
        searchPrompt: ctx.config?.search?.prompt ?? null,
        // Preload the default webfonts' latin subsets (fonts.css) only for
        // roles the site did not override — a site --font-sans/--font-mono
        // token means Inter/Geist Mono never render, so the preload would be
        // wasted bytes on the critical path.
        preloadDefaultFonts: {
            sans: ctx.themeTokens["--font-sans"] === undefined,
            mono: ctx.themeTokens["--font-mono"] === undefined,
        },
        // docs.json errors.404 — authored not-found page + redirect switch.
        errors404: ctx.config?.errors?.["404"]
            ? {
                  title: ctx.config.errors["404"].title ?? null,
                  // Raw text stays as the fallback for descriptions whose
                  // markdown compilation failed at ingest.
                  description: ctx.config.errors["404"].description ?? null,
                  descriptionHastJson: ctx.config.errors["404"].descriptionHast
                      ? JSON.stringify(ctx.config.errors["404"].descriptionHast)
                      : null,
              }
            : null,
    }
})

export const Route = createRootRoute({
    // ?search= is the search dialog's shareable query. The router parses
    // values as JSON, so a hand-built ?search=404 arrives as a number: keep
    // it as the query rather than dropping it (the router then redirects to
    // its own spelling). Anything else falls back to absent instead of
    // failing the root match.
    validateSearch: object({
        search: fallback(
            optional(
                pipe(union([string(), number(), boolean()]), transform(String)),
            ),
            undefined,
        ),
    }),
    loader: () => rootLoader(),
    head: ({ loaderData }) => ({
        meta: [
            {
                charSet: "utf-8",
            },
            {
                name: "viewport",
                content: "width=device-width, initial-scale=1",
            },
            {
                title: loaderData?.siteName ?? appName,
            },
            {
                name: "application-name",
                content: loaderData?.siteName ?? appName,
            },
            {
                name: "generator",
                content: GENERATOR_NAME,
            },
        ],
        links: [
            // Font preloads ahead of the stylesheet so the fetch starts before
            // CSS parsing discovers the @font-face url(); the `?url` import and
            // fonts.css's url() resolve to the same content-hashed asset.
            ...(loaderData?.preloadDefaultFonts.sans
                ? [
                      {
                          rel: "preload",
                          as: "font",
                          type: "font/woff2",
                          href: loaderData.assetHrefs.interLatin,
                          crossOrigin: "anonymous",
                      } satisfies ComponentProps<"link">,
                  ]
                : []),
            ...(loaderData?.preloadDefaultFonts.mono
                ? [
                      {
                          rel: "preload",
                          as: "font",
                          type: "font/woff2",
                          href: loaderData.assetHrefs.geistMonoLatin,
                          crossOrigin: "anonymous",
                      } satisfies ComponentProps<"link">,
                  ]
                : []),
            {
                rel: "stylesheet",
                href: loaderData?.assetHrefs.appCss ?? withBase(appCss),
            },
            {
                rel: "sitemap",
                type: "application/xml",
                href: withBase("/sitemap.xml"),
            },
            { rel: "manifest", href: withBase("/manifest.webmanifest") },
            ...(loaderData?.faviconLinks ?? []),
        ],
    }),
    component: RootComponent,
})

const DocsSearchDialog = lazy(() =>
    import("@/components/search-dialog").then((module) => ({
        default: module.DocsSearchDialog,
    })),
)

/**
 * Search dialog bound to the site's search.prompt. Module-level (stable
 * identity across RootComponent renders) and reads the root loader data
 * itself — RootProvider's registration slot passes only SharedProps.
 */
function SiteSearchDialog(props: ComponentProps<typeof DocsSearchDialog>) {
    const data = Route.useLoaderData()
    return (
        <DocsSearchDialog {...props} prompt={data.searchPrompt ?? undefined} />
    )
}

/** Opens the lazy search dialog whenever the URL carries ?search= — on a
 * deep link and on Back/Forward (the router's location already follows
 * popstate). The dialog seeds its query from the same param. */
function SearchDeepLink() {
    const { setOpenSearch } = useSearchContext()
    const search = Route.useSearch({ select: (params) => params.search })
    useEffect(() => {
        if (search !== undefined) setOpenSearch(true)
    }, [search, setOpenSearch])
    return null
}

type RootLoaderData = Awaited<ReturnType<typeof rootLoader>>

/** The site document, or a bare 404 when the root loader threw notFound():
 * a host that names no site still renders the root route, with the
 * not-found boundary in its Outlet, but TanStack never sets its loaderData. */
function RootComponent() {
    // Widened: useLoaderData's type promises data the not-found case lacks.
    const data: RootLoaderData | undefined = Route.useLoaderData()
    if (data === undefined) {
        // Everything below reads site data (chrome strings, layout config,
        // NotFound), so this document is static: the router keeps the 404.
        return (
            <html lang="en" data-base-path={basePath() || undefined}>
                {/* biome-ignore lint/style/noHeadElement: TanStack Start expects HeadContent inside the document head. */}
                <head>
                    <HeadContent />
                </head>
                <body className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
                    <h1 className="font-medium text-2xl">Page not found</h1>
                    <p className="text-fd-muted-foreground text-sm">
                        No documentation is published at this address.
                    </p>
                    <Scripts />
                </body>
            </html>
        )
    }
    return <SiteDocument data={data} />
}

function SiteDocument({ data }: { data: RootLoaderData }) {
    // Location-derived (not data.language): the cached root loader data
    // survives client navigations across locales.
    const locale = useActiveLocale()
    // Current docs path for the assistant's /api/chat requests (locale/
    // version context + the feedback page).
    const pathname = useLocation({ select: (location) => location.pathname })
    const strings = chromeStringsFor(locale)
    const searchMode = searchModeOf(data.layoutConfig, data.assistantAvailable)
    const ga4 = data.integrations.ga4?.measurementId
    const posthog = data.integrations.posthog
    const posthogHost =
        posthog?.apiHost === "https://eu.i.posthog.com" ||
        posthog?.apiHost === "https://eu.posthog.com" ||
        posthog?.apiHost === "https://us.i.posthog.com" ||
        posthog?.apiHost === "https://us.posthog.com"
            ? posthog.apiHost
            : "https://us.i.posthog.com"
    const posthogAssets = posthogHost.includes("eu.")
        ? "https://eu-assets.i.posthog.com"
        : "https://us-assets.i.posthog.com"
    const posthogSnippet = posthog?.apiKey
        ? `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=${JSON.stringify(posthogAssets)}+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getSurveys getActiveMatchingSurveys captureException".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(posthog.apiKey).replaceAll("<", "\\u003c")},{api_host:${JSON.stringify(posthogHost)},defaults:"2026-06-25",capture_exceptions:false});`
        : null
    const plausible = data.integrations.plausible?.domain
    const fathom = data.integrations.fathom?.siteId
    const clarity = data.integrations.clarity?.projectId
    // Long-tail vendors. Every key is JSON-serialized with
    // "<" escaped so a hostile value can never break out of the script, and
    // every script src is a PINNED official origin.
    const escapeKey = (value: string) =>
        JSON.stringify(value).replaceAll("<", "\\u003c")
    const amplitude = data.integrations.amplitude?.apiKey
    const mixpanel = data.integrations.mixpanel?.projectToken
    // Data residency: the stored region key selects among PINNED official
    // Mixpanel ingestion origins (never a site-provided host — INV-2).
    const mixpanelApiHost =
        data.integrations.mixpanel?.region === "eu"
            ? "https://api-eu.mixpanel.com"
            : data.integrations.mixpanel?.region === "in"
              ? "https://api-in.mixpanel.com"
              : null
    const segment = data.integrations.segment?.key
    const hotjarId = data.integrations.hotjar?.hjid
    const hotjarVersion = data.integrations.hotjar?.hjsv ?? "6"
    const intercom = data.integrations.intercom?.appId
    const router = useRouter()
    useEffect(() => {
        if (!segment) return
        // The bootstrap snippet fires the initial page() — docs navigation
        // is client-side (no document reload), so later page views only
        // exist through this subscription. Mixpanel/Plausible/Fathom/GA4
        // handle history changes natively; Segment does not.
        return router.subscribe("onResolved", (event) => {
            if (event.pathChanged) window.analytics?.page?.()
        })
    }, [router, segment])
    useEffect(() => {
        if (!intercom) return
        // The bootstrap snippet boots Intercom once for the initial
        // document — docs navigation is client-side, so without this ping
        // the messenger never learns about later page views (no new-message
        // checks, stale last-seen). "update" with a fresh timestamp is
        // Intercom's documented SPA route-change hook.
        return router.subscribe("onResolved", (event) => {
            if (event.pathChanged)
                window.Intercom?.("update", {
                    last_request_at: Math.floor(Date.now() / 1000),
                })
        })
    }, [router, intercom])
    // A reader's page views, reported by the browser: a page served from
    // the CDN cache and a client-side navigation never reach the server,
    // and a script that only fetches pages never runs this. Once for the
    // first page and once per navigation to another page; never for a
    // 404 or an error page. The last path is kept in a ref, so a remount
    // under strict mode or a navigation that resolves twice reports once.
    const { report: reportViews, check: checkViews } = data.pageViews
    const lastViewedPath = useRef<string | null>(null)
    useEffect(() => {
        if (!reportViews) return
        const report = () => {
            const { location, matches } = router.state
            if (location.pathname === lastViewedPath.current) return
            const first = lastViewedPath.current === null
            lastViewedPath.current = location.pathname
            if (
                matches.some(
                    (match) =>
                        match.status === "notFound" || match.status === "error",
                )
            )
                return
            // Where the visit came from, on its first page only: the
            // referrer's host when it is another site, and the utm_source
            // some AI products add instead. Values the event schema would
            // refuse are dropped, never sent.
            const referrer =
                first && URL.canParse(document.referrer)
                    ? new URL(document.referrer)
                    : null
            const referrerHost =
                referrer && referrer.host !== window.location.host
                    ? referrer.hostname.toLowerCase()
                    : null
            const utmSource = first
                ? (new URLSearchParams(window.location.search)
                      .get("utm_source")
                      ?.toLowerCase() ?? null)
                : null
            // One id per view (a version 4 UUID), sent with every attempt
            // at it so the server records it once. getRandomValues, unlike
            // randomUUID, also runs on a plain-http site.
            const bytes = crypto.getRandomValues(new Uint8Array(16))
            bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
            bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
            const hex = Array.from(bytes, (byte) =>
                byte.toString(16).padStart(2, "0"),
            ).join("")
            const body = JSON.stringify({
                type: "docs_page_viewed",
                page_path: location.pathname,
                view_id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
                referrer_host:
                    referrerHost && /^[a-z0-9.-]{1,253}$/.test(referrerHost)
                        ? referrerHost
                        : null,
                utm_source:
                    utmSource && /^[a-z0-9._-]{1,64}$/.test(utmSource)
                        ? utmSource
                        : null,
            } satisfies BrowserEvent)
            const url = withBase("/api/agent/event")
            const beacon = () => {
                if (!navigator.sendBeacon(url, body))
                    void fetch(url, {
                        method: "POST",
                        body,
                        keepalive: true,
                    }).catch(() => {})
            }
            if (!checkViews) {
                beacon()
                return
            }
            // The host's browser half, loaded only on these sites and only
            // after the page is up. A sender that fails, or has not
            // answered when the deadline passes, falls back to the beacon;
            // if it delivers late as well, the shared view id makes the
            // server record the view once.
            let fellBack = false
            const fallBack = () => {
                if (fellBack) return
                fellBack = true
                beacon()
            }
            const deadline = setTimeout(fallBack, 8_000)
            void import("#docs-browser-extensions")
                .then(({ browserExtensions }) =>
                    browserExtensions.sendPageView
                        ? browserExtensions.sendPageView(url, body)
                        : fallBack(),
                )
                .catch(fallBack)
                .finally(() => clearTimeout(deadline))
        }
        report()
        return router.subscribe("onResolved", (event) => {
            if (event.pathChanged) report()
        })
    }, [router, reportViews, checkViews])
    const segmentSnippet = segment
        ? `!function(){var i="analytics",analytics=window[i]=window[i]||[];if(!analytics.initialize)if(analytics.invoked)window.console&&console.error&&console.error("Segment snippet included twice.");else{analytics.invoked=!0;analytics.methods=["trackSubmit","trackClick","trackLink","trackForm","pageview","identify","reset","group","track","ready","alias","debug","page","screen","once","off","on","addSourceMiddleware","addIntegrationMiddleware","setAnonymousId","addDestinationMiddleware","register"];analytics.factory=function(e){return function(){if(window[i].initialized)return window[i][e].apply(window[i],arguments);var n=Array.prototype.slice.call(arguments);if(["track","screen","alias","group","page","identify"].indexOf(e)>-1){var c=document.querySelector("link[rel='canonical']");n.push({__t:"bpc",c:c&&c.getAttribute("href")||void 0,p:location.pathname,u:location.href,s:location.search,t:document.title,r:document.referrer})}n.unshift(e);analytics.push(n);return analytics}};for(var n=0;n<analytics.methods.length;n++){var key=analytics.methods[n];analytics[key]=analytics.factory(key)}analytics.load=function(key,n){var t=document.createElement("script");t.type="text/javascript";t.async=!0;t.src="https://cdn.segment.com/analytics.js/v1/"+key+"/analytics.min.js";var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r);analytics._loadOptions=n};analytics._writeKey=${escapeKey(segment)};analytics.SNIPPET_VERSION="5.2.0";analytics.load(${escapeKey(segment)});analytics.page()}}();`
        : null
    const hotjarSnippet =
        hotjarId && /^\d+$/.test(hotjarId)
            ? `(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${hotjarId},hjsv:${/^\d+$/.test(hotjarVersion) ? hotjarVersion : "6"}};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`
            : null
    const intercomSnippet = intercom
        ? `window.intercomSettings={app_id:${escapeKey(intercom)}};(function(){var w=window;var ic=w.Intercom;if(typeof ic==="function"){ic('reattach_activator');ic('update',w.intercomSettings);}else{var d=document;var i=function(){i.c(arguments);};i.q=[];i.c=function(args){i.q.push(args);};w.Intercom=i;var l=function(){var s=d.createElement('script');s.type='text/javascript';s.async=true;s.src='https://widget.intercom.io/widget/'+encodeURIComponent(${escapeKey(intercom)});var x=d.getElementsByTagName('script')[0];x.parentNode.insertBefore(s,x);};if(document.readyState==='complete'){l();}else if(w.attachEvent){w.attachEvent('onload',l);}else{w.addEventListener('load',l,false);}}})();`
        : null
    // AISearch wraps RootProvider (not the reverse): the search dialog
    // is rendered by RootProvider's own SearchProvider, so the assistant
    // context must sit ABOVE it for the dialog's "Ask Assistant" row.
    const tree = (
        <RootProvider
            theme={data.theme}
            search={{
                SearchDialog: SiteSearchDialog,
                preload: false,
                // search mode "off" (searchModeOf) removes search
                // entirely — the header SearchPill and fumadocs'
                // triggers all self-hide via useSearchContext().
                enabled: searchMode !== "off",
            }}
            // Localised fumadocs chrome (TOC heading, search dialog,
            // pagination, theme switcher, copy buttons…). English
            // needs no translations — the keys ARE the copy.
            i18n={{
                locale,
                locales: data.locales,
                translations:
                    FUMADOCS_TRANSLATIONS[resolveChromeLocale(locale)],
            }}
        >
            <SearchDeepLink />
            {data.banner ? (
                <Banner
                    data-layout-item="banner"
                    id={
                        data.banner.dismissible === false
                            ? undefined
                            : "site-banner"
                    }
                    className={cn(
                        // Inline markdown renders from the ingest-
                        // compiled HAST — links keep an underline so
                        // they read as links on the tinted band.
                        "[&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-fd-background/20 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
                        data.banner.type === "critical"
                            ? "bg-fd-error text-fd-error-foreground"
                            : data.banner.type === "warning"
                              ? "bg-fd-warning text-fd-warning-foreground"
                              : "bg-fd-info text-fd-info-foreground",
                    )}
                >
                    {/* One inline box: as direct children of the banner's
                        flex row, each text node, <strong> and <a> became
                        its own flex item, collapsing the spaces between
                        them (and splitting into columns on mobile). The
                        inline padding keeps wrapped text clear of the
                        absolutely positioned close button. */}
                    <span
                        className={cn(
                            "line-clamp-2 min-w-0",
                            data.banner.dismissible === false ? null : "px-8",
                        )}
                    >
                        {data.banner.contentHastJson ? (
                            <HastBody hastJson={data.banner.contentHastJson} />
                        ) : (
                            data.banner.content
                        )}
                    </span>
                </Banner>
            ) : null}
            <Outlet />
            <Toaster />
        </RootProvider>
    )
    return (
        <html
            lang={data.language}
            suppressHydrationWarning
            data-preset={data.layoutPreset}
            data-theme-name={data.themeName ?? undefined}
            // The per-path stylesheet hook: sites scope rules to a section
            // with html[data-current-path^="/api"].
            data-current-path={pathname.replace(/\/+$/, "") || "/"}
            data-decoration={data.decoration ?? undefined}
            // Read by lib/base-path.ts in the browser.
            data-base-path={basePath() || undefined}
        >
            {/* biome-ignore lint/style/noHeadElement: TanStack Start expects HeadContent inside the document head. */}
            <head>
                {data.headMeta.map((meta) =>
                    "httpEquiv" in meta ? (
                        <meta
                            key={`http-equiv:${meta.httpEquiv}:${meta.content}`}
                            httpEquiv={meta.httpEquiv}
                            content={meta.content}
                        />
                    ) : (
                        <meta
                            key={`name:${meta.name}:${meta.content}`}
                            name={meta.name}
                            content={meta.content}
                        />
                    ),
                )}
                <HeadContent />
                {/* Literal metas: TanStack's head() dedupes by name, which
                    collapses the media-varied theme-color pair to one. */}
                {data.themeColor ? (
                    <>
                        <meta
                            name="theme-color"
                            media="(prefers-color-scheme: light)"
                            content={data.themeColor.light}
                        />
                        <meta
                            name="theme-color"
                            media="(prefers-color-scheme: dark)"
                            content={data.themeColor.dark}
                        />
                    </>
                ) : null}
                <style
                    data-site-css
                    /* biome-ignore lint/security/noDangerouslySetInnerHtml: token names and values are filtered by renderThemeStyle, and the deployment standard requires a server-rendered token block. */
                    dangerouslySetInnerHTML={{ __html: data.tokenCss }}
                />
                {/* After the token block, not in head().links (HeadContent
                    renders above it): site CSS keeps the final cascade
                    say over the tokens (deployment standard §4.1/§4.3). */}
                {data.siteCssHref ? (
                    <link rel="stylesheet" href={data.siteCssHref} />
                ) : null}
                {ga4 ? (
                    <>
                        <script
                            async
                            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4)}`}
                        />
                        <script
                            /* biome-ignore lint/security/noDangerouslySetInnerHtml: this is framework-owned GA4 code with the measurement ID JSON-serialized and script-breakout escaped. */
                            dangerouslySetInnerHTML={{
                                __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date);gtag("config",${JSON.stringify(ga4).replaceAll("<", "\\u003c")});`,
                            }}
                        />
                    </>
                ) : null}
                {posthogSnippet ? (
                    <script
                        /* biome-ignore lint/security/noDangerouslySetInnerHtml: this is the framework-owned PostHog bootstrap with an allow-listed origin and escaped data key. */
                        dangerouslySetInnerHTML={{ __html: posthogSnippet }}
                    />
                ) : null}
                {plausible ? (
                    <script
                        async
                        src="https://plausible.io/js/script.js"
                        data-domain={plausible}
                    />
                ) : null}
                {fathom ? (
                    <script
                        async
                        src="https://cdn.usefathom.com/script.js"
                        data-site={fathom}
                    />
                ) : null}
                {clarity ? (
                    <script
                        async
                        src={`https://www.clarity.ms/tag/${encodeURIComponent(clarity)}`}
                    />
                ) : null}
                {amplitude ? (
                    <>
                        <script
                            async
                            src={`https://cdn.amplitude.com/script/${encodeURIComponent(amplitude)}.js`}
                        />
                        <script
                            /* biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned Amplitude bootstrap; the key is JSON-escaped data. */
                            dangerouslySetInnerHTML={{
                                // Never pre-create window.amplitude: the
                                // official loader treats an existing object
                                // with `invoked` as a duplicate include and
                                // skips installation. Init once post-load.
                                __html: `window.addEventListener("load",function(){var a=window.amplitude;if(a&&a.init&&!a.__docsInit){a.__docsInit=1;a.init(${escapeKey(amplitude)},{autocapture:{elementInteractions:!1}})}});`,
                            }}
                        />
                    </>
                ) : null}
                {mixpanel ? (
                    <script
                        /* biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned Mixpanel loader stub pinned to cdn.mxpnl.com; the token is JSON-escaped data. */
                        dangerouslySetInnerHTML={{
                            __html: `(function(f,b){if(!b.__SV){var e,g,i,h;window.mixpanel=b;b._i=[];b.init=function(e,f,c){function g(a,d){var b=d.split(".");2==b.length&&(a=a[b[0]],d=b[1]);a[d]=function(){a.push([d].concat(Array.prototype.slice.call(arguments,0)))}}var a=b;"undefined"!==typeof c?a=b[c]=[]:c="mixpanel";a.people=a.people||[];a.toString=function(a){var d="mixpanel";"mixpanel"!==c&&(d+="."+c);a||(d+=" (stub)");return d};a.people.toString=function(){return a.toString(1)+".people (stub)"};i="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");for(h=0;h<i.length;h++)g(a,i[h]);var j="set set_once union unset remove delete".split(" ");a.get_group=function(){function b(c){d[c]=function(){call2_args=arguments;call2=[c].concat(Array.prototype.slice.call(call2_args,0));a.push([e,call2])}}for(var d={},e=["get_group"].concat(Array.prototype.slice.call(arguments,0)),c=0;c<j.length;c++)b(j[c]);return d};b._i.push([e,f,c])};b.__SV=1.2;e=f.createElement("script");e.type="text/javascript";e.async=!0;e.src="https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";g=f.getElementsByTagName("script")[0];g.parentNode.insertBefore(e,g)}})(document,window.mixpanel||[]);mixpanel.init(${escapeKey(mixpanel)},{track_pageview:"url-with-path"${mixpanelApiHost ? `,api_host:${JSON.stringify(mixpanelApiHost)}` : ""}});`,
                        }}
                    />
                ) : null}
                {segmentSnippet ? (
                    <script
                        /* biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned Segment analytics.js snippet pinned to cdn.segment.com; the write key is JSON-escaped data. */
                        dangerouslySetInnerHTML={{ __html: segmentSnippet }}
                    />
                ) : null}
                {hotjarSnippet ? (
                    <script
                        /* biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned Hotjar loader pinned to static.hotjar.com; hjid/hjsv are digit-validated. */
                        dangerouslySetInnerHTML={{ __html: hotjarSnippet }}
                    />
                ) : null}
                {intercomSnippet ? (
                    <script
                        /* biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned Intercom loader pinned to widget.intercom.io; the app id is JSON-escaped data. */
                        dangerouslySetInnerHTML={{ __html: intercomSnippet }}
                    />
                ) : null}
            </head>
            <body className="flex flex-col min-h-screen">
                {/* First tab stop on every page. #nd-page
                    is fumadocs' article column on docs pages. */}
                <a
                    href="#nd-page"
                    className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:bg-fd-background focus:px-3 focus:py-2 focus:text-sm"
                >
                    {strings.skipToContent}
                </a>
                {data.decoration === "windows" ? <DecorationWindows /> : null}
                {data.backgroundImage ? (
                    // JSON.stringify quoting doubles as CSS string escaping,
                    // so a hostile URL can never break out of url("…").
                    <>
                        <div
                            aria-hidden
                            className="-z-10 pointer-events-none fixed inset-0 bg-center bg-cover bg-no-repeat dark:hidden"
                            style={{
                                backgroundImage: `url(${JSON.stringify(data.backgroundImage.light)})`,
                            }}
                        />
                        <div
                            aria-hidden
                            className="-z-10 pointer-events-none fixed inset-0 hidden bg-center bg-cover bg-no-repeat dark:block"
                            style={{
                                backgroundImage: `url(${JSON.stringify(data.backgroundImage.dark)})`,
                            }}
                        />
                    </>
                ) : null}
                {/* The assistant provider lives here, above every page, so
                    the search dialog (rendered by RootProvider) can offer
                    "Ask Assistant". Non-"ai" search modes render the same
                    tree without any assistant context. */}
                {/* Chrome copy for every component below, article
                    components included (lib/chrome-strings.ts). */}
                <ChromeLocaleContext value={locale}>
                    {searchMode === "ai" ? (
                        <AISearch path={pathname.replace(/\/+$/, "") || "/"}>
                            {tree}
                        </AISearch>
                    ) : (
                        tree
                    )}
                </ChromeLocaleContext>
                <Scripts />
            </body>
        </html>
    )
}
