import type { PostHog } from "posthog-node"

/** Site registry labels and serving policy. Displayed branding is resolved
 * separately on DocsHead.identity from deployment env and selected config. */
export interface DocsSite {
    id: string // docs_site.id
    slug: string // public id used in analytics, cache tags and URLs
    name: string
    description: string
    repo: { owner: string; name: string; branch: string; subdir: string } | null
    /** false suppresses the site's configured analytics integrations (GA4, PostHog…) at serve time. */
    analyticsEnabled: boolean
    /** docs_site.webmcp_enabled. The plugin may OR in a rollout (webmcpRollout). */
    webmcpEnabled: boolean
}

export type VersionSelector =
    | "current" // docs_site.current_version_id (status active, version ready)
    | { kind: "commit"; sha: string } // exact commit_sha, kind production|preview, status ready
    | { kind: "preview"; shaPrefix: string } // plugin: <sha7>-<slug> hosts; LIKE prefix, ambiguous → nothing

export interface SiteResolution {
    /** null → the host names nothing: production answers 404, previews an empty no-store page. */
    site: DocsSite | null
    versionSelector: VersionSelector
    /** Every response no-store + noindex (previewMiddleware). */
    preview: boolean
    /** Production hosts only: 308 to this host when it differs from the request host. null = never redirect. */
    canonicalHost: string | null
    /** "" or "/docs" (no trailing slash): every URL this site serves sits
     * under it. The server 308s requests outside it and strips it before
     * routing, so routes and loaders see root-relative paths. */
    basePath: string
    /** Origin for absolute URLs ("https://acme.com", no path); null = the
     * request's own origin. */
    publicOrigin: string | null
    /** Every visitor reaches this host from the same address (its owner's
     * proxy hides theirs), so the public rate limiters apply their per-site
     * limits only. Default false. */
    sharedClientAddress?: boolean
}

/** Cheap, DB-free facts derived from the request shape. Called on every request before any DB read. */
export interface RequestPolicy {
    /** HSTS preload+includeSubDomains (platform hosts) vs plain max-age (customer domains). */
    hstsPreload: boolean
    /** `Vercel-Cache-Tag` value for purgeable responses; null = no tag. ≤256 chars, no commas. */
    cacheTag: string | null
    /** Treat as preview (no-store) without consulting the DB. */
    preview: boolean
    /** Short-circuit the whole request (plugin: retired `docs.<root>` namespace → 410).
     * Evaluated after server.ts has resolved the site and stripped its base
     * path, so the request's path is the unprefixed one. */
    shortCircuit: Response | null
}

export interface TelemetryHooks {
    /** Extra PostHog event properties (plugin adds the site id, environment: preview on sha hosts). */
    eventProperties?(
        request: Request,
        resolution: SiteResolution | null,
    ): Record<string, unknown>
    /** PostHog groups for the capture (plugin: one group keyed by site slug) and the one-time groupIdentify.
     * Called with a null resolution when the site lookup failed, so a host can still group by request. */
    groups?(
        resolution: SiteResolution | null,
        request?: Request,
    ): {
        groupType: string
        groupKey: string
        properties?: Record<string, unknown>
    } | null
    /** Escape-hatch tap, replaces agentConfig.observability.onEvent. */
    onEvent?(event: Record<string, unknown>): void
    /** Stable visitor identity input for the deterministic $session_id/distinct_id hash. Default: the served site slug. */
    visitorKey?(request: Request, resolution: SiteResolution | null): string
}

export interface DocsExtensions {
    resolveSite(request: Request): Promise<SiteResolution>
    requestPolicy(request: Request): RequestPolicy
    telemetry: TelemetryHooks
    /** Operator rollout of WebMCP for a site, ORed with site.webmcpEnabled. Must never block: answer from cache. */
    webmcpRollout?(site: DocsSite, posthog: PostHog | undefined): boolean
    /** Identity string the rate limiter and feedback HMAC key on (default: site.id). */
    rateLimitScope?(site: DocsSite): string
    /** Client address for rate limits and feedback keys. Default: Vercel's forwarded address. */
    clientIp?(request: Request): string | undefined
    /** Extra `<meta>` tags rendered at the top of every site document's
     * `<head>`, before the route's own head tags (plugin: origin-trial
     * tokens registered to its domain). Default: none. */
    headMeta?: readonly HeadMeta[]
    /** A second opinion on a reader's report of a page view
     * (`docs_page_viewed`), recorded on the event and never acted on:
     * nothing is refused or answered differently because of it. Default:
     * none, and every report records `skipped`. */
    pageViewCheck?: PageViewCheck
}

export interface PageViewCheck {
    /** Render time: whether the site's pages send their reports through
     * the browser extension's `sendPageView`. A cached page keeps the
     * answer for as long as the CDN keeps the page, so `verify` must cope
     * with reports from pages rendered either way. Must answer from
     * cache, never block. */
    enabled(
        site: DocsSite,
        resolution: SiteResolution,
        posthog: PostHog | undefined,
    ): boolean
    /** Request time: the verdict on one report. The event route waits at
     * most a second, then records `skipped`, as it does on a rejection. */
    verify(
        request: Request,
        resolution: SiteResolution | null,
        posthog: PostHog | undefined,
    ): Promise<PageViewVerdict>
}

export interface PageViewVerdict {
    /** `skipped`: not checked, or the check could not tell. A report
     * judged `bot` is automation; the other two count as the reader's. */
    verdict: "human" | "bot" | "skipped"
    /** Extra event properties (plugin: the verified bot's name and
     * category). */
    properties?: Record<string, unknown>
}

/**
 * The browser half of a host's extensions: `#docs-browser-extensions`,
 * aliased at build time like `#docs-extensions` (DOCS_BROWSER_EXTENSIONS;
 * default src/extensions/browser-default.ts). Pages import it lazily and
 * only when they need it, so it never weighs on a page's first load.
 */
export interface DocsBrowserExtensions {
    /** Sends a page-view report (the JSON `body`, POSTed to `url`) in place
     * of the framework's beacon, on pages whose site turned
     * `pageViewCheck` on. A rejection falls back to the beacon, so it must
     * reject only when the report was not sent. */
    sendPageView?(url: string, body: string): Promise<void>
}

/** One literal `<meta>` tag: `http-equiv` (e.g. `origin-trial`) or `name`. */
export type HeadMeta =
    | { httpEquiv: string; content: string }
    | { name: string; content: string }
