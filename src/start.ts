import {
    sentryGlobalFunctionMiddleware,
    sentryGlobalRequestMiddleware,
    wrapMiddlewaresWithSentry,
} from "@sentry/tanstackstart-react"
import { isNotFound, redirect } from "@tanstack/react-router"
import {
    createCsrfMiddleware,
    createMiddleware,
    createStart,
} from "@tanstack/react-start"
import {
    getResponseHeader,
    setResponseHeader,
} from "@tanstack/react-start/server"
import { extensions } from "#docs-extensions"
import {
    AGENT_LINK_RELATION_BASE,
    ASSISTANT_MARKDOWN_PARAM,
    agentConfig,
    contentSignalValue,
    isSurfaceEnabled,
    siteAgentSettings,
} from "@/lib/agent.config"
import { normalizeDocUrl, wantsMarkdown } from "@/lib/agent-content"
import { siteScope, siteUrlFromRequest, withBase } from "@/lib/base-path"
import { emitEvent } from "@/lib/observability"
import { originFromRequest, slugsToMarkdownPath } from "@/lib/shared"
import { ssrSnapshotAdapter } from "@/lib/ssr-snapshot"
import { getDocsMarkdown } from "@/routes/{$}[.]md"
import { PAGE_SURFACES, surfaceOf, UNTRACKED_PATH } from "@/types/telemetry"

const csrfMiddleware = createCsrfMiddleware({
    filter: (ctx) => ctx.handlerType === "serverFn",
    // Fallback for browsers without Sec-Fetch-Site: their Origin/Referer
    // carries the visited domain, so compare against the host header —
    // request.url's origin (the library default) can be the internal
    // deployment host on Vercel and would 403 every custom domain. A site
    // behind its owner's proxy is visited on its public origin while the
    // request reaches this server on another host: that origin comes from
    // the resolved site (server.ts), never from a request header.
    origin: (value, ctx) =>
        value === originFromRequest(ctx.request) ||
        value === siteScope().getStore()?.publicOrigin,
})

/**
 * Agent-journeys capture — FIRST in the chain so it wraps the CSRF 403s and the
 * llmMiddleware's inline markdown answer. The in-path cost is a map lookup plus
 * emitEvent's header snapshot; all real analytics work runs post-response
 * inside waitUntil (see observability.ts).
 */
const analyticsMiddleware = createMiddleware().server(
    async ({ next, request, handlerType }) => {
        const url = new URL(request.url)
        if (UNTRACKED_PATH.test(url.pathname) || request.method === "OPTIONS")
            return next()

        const started = Date.now()
        let status = 0
        let contentType: string | null = null
        try {
            const result = await next()
            status = result.response.status
            contentType = result.response.headers.get("content-type")
            return result
        } catch (thrown) {
            status = thrown instanceof Response ? thrown.status : 500
            contentType =
                thrown instanceof Response
                    ? thrown.headers.get("content-type")
                    : null
            throw thrown
        } finally {
            const surface =
                handlerType === "serverFn"
                    ? "server_fn"
                    : surfaceOf(url.pathname)
            emitEvent(request, {
                type: PAGE_SURFACES.has(surface) ? "$pageview" : "api_request",
                surface,
                status,
                // For streaming routes this is time-to-response-head, not stream end.
                duration_ms: Date.now() - started,
                method: request.method,
                handler_type: handlerType,
                content_type: contentType,
            })
            // Alongside (never instead of) the 404's $pageview: broken
            // inbound links and stale agent URLs, attributed to the site
            // that sent the reader. Only the referrer's host leaves.
            if (
                status === 404 &&
                (surface === "docs_html" || surface === "docs_md")
            ) {
                const referer = request.headers.get("referer")
                emitEvent(request, {
                    type: "page_not_found",
                    surface,
                    referrer_host:
                        referer && URL.canParse(referer)
                            ? new URL(referer).hostname.toLowerCase()
                            : null,
                })
            }
        }
    },
)

/**
 * EVERY response the extension's request policy marks preview (a preview
 * deployment, a host's per-commit preview hostnames) skips the CDN and
 * search indexing: unreleased hostnames must never be indexed, and a shared
 * CDN entry for cookie-less-but-unlisted preview URLs is a leak vector. One
 * chokepoint so no surface (HTML, .md, llms*, search, MCP, sitemaps) can
 * forget — it wraps cacheMiddleware and overrides its header on the way
 * out. Request shape only, no DB.
 */
const previewMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        if (!extensions.requestPolicy(request).preview) return next()
        try {
            const result = await next()
            result.response.headers.set("Cache-Control", "private, no-store")
            result.response.headers.set("X-Robots-Tag", "noindex, nofollow")
            // Start merges the request-scoped response store over ok
            // responses AFTER this chain, so a handler's setResponseHeader
            // (the page and chrome RPCs' shared policy) would otherwise
            // overwrite the no-store set above.
            setResponseHeader("Cache-Control", "private, no-store")
            return result
        } catch (thrown) {
            if (thrown instanceof Response) {
                const response = new Response(thrown.body, thrown)
                response.headers.set("Cache-Control", "private, no-store")
                response.headers.set("X-Robots-Tag", "noindex, nofollow")
                throw response
            }
            throw thrown
        }
    },
)

/**
 * A request the extension answers outright from its shape (a host retiring a
 * hostname namespace answers 410, say) never reaches a route loader. It sees
 * the path with the site's base path removed (server.ts).
 */
const shortCircuitMiddleware = createMiddleware().server(
    ({ next, request }) => {
        const { shortCircuit } = extensions.requestPolicy(request)
        if (!shortCircuit) return next()
        throw shortCircuit
    },
)

/**
 * A host naming no site throws notFound() from the site head (lib/source.ts).
 * The router renders it as the 404 page for documents, but Start answers
 * anything else thrown past a server route or middleware (robots.txt,
 * llms.txt, .md, a trailing-slash redirect) with a 500. Server functions keep
 * Start's own notFound reply, which the client router rethrows.
 */
const notFoundMiddleware = createMiddleware().server(
    async ({ next, handlerType }) => {
        try {
            return await next()
        } catch (thrown) {
            if (handlerType !== "serverFn" && isNotFound(thrown)) {
                throw new Response("Not Found", {
                    status: 404,
                    headers: { "Content-Type": "text/plain; charset=utf-8" },
                })
            }
            throw thrown
        }
    },
)

/**
 * Root-level asset probes (favicon.png, apple-touch-icon…) have no route and
 * no file — there is no public/ dir (/favicon.ico has its own redirecting
 * route) — so they fell through to the not-found
 * page, whose ROOT LOADER resolves the site from Postgres. A browser icon
 * probe reaching the database is absurd on a good day; on a deployment with
 * no DATABASE_URL it was a Sentry error per probe (FRAMEWORK-1). Answer 404
 * before the router. Real asset routes (/_assets/$hash, /og/docs) are
 * untouched.
 */
const assetProbeMiddleware = createMiddleware().server(({ next, request }) => {
    const { pathname } = new URL(request.url)
    if (
        pathname.toLowerCase() !== "/favicon.ico" &&
        /^\/(favicon\.[a-z0-9]+|apple-touch-icon[^/]*)$/i.test(pathname)
    ) {
        throw new Response("Not Found", {
            status: 404,
            // Icon probes repeat per client — let the CDN absorb them.
            headers: { "Cache-Control": "public, max-age=86400" },
        })
    }
    return next()
})

/**
 * Docs serve at the root splat, so "is this a docs URL" is exclusion-based:
 * everything except the app's own API/asset routes and its fixed file
 * endpoints (which agents legitimately fetch with Accept: text/markdown and
 * must never be redirected away from).
 */
const NON_DOCS_PREFIX =
    /^\/(?:api|og|_assets|_theme|_margin|_build|\.well-known)(?:\/|$)/
const RESERVED_FILES =
    /^\/(?:llms(?:-full)?\.txt|robots\.txt|sitemap\.xml|favicon\.ico|manifest\.webmanifest)$/

/**
 * `/path/` → `/path` permanently for sites whose URL policy is slash-less
 * (the default). TanStack's own canonicalisation would answer the same
 * redirect with a 307 and unconditionally; the router runs with
 * trailingSlash "preserve" so the site's `seo.trailingSlash` decides
 * instead — those sites advertise `/path/` in canonicals and sitemaps and
 * must serve it, and routes/$.tsx adds the slash for them in the other
 * direction. Only slashed paths pay the site lookup (memoised).
 */
const trailingSlashMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        const url = new URL(request.url)
        if (
            (request.method === "GET" || request.method === "HEAD") &&
            url.pathname.length > 1 &&
            url.pathname.endsWith("/") &&
            !NON_DOCS_PREFIX.test(url.pathname)
        ) {
            // Dynamic: source.ts opens the database pool at module load and
            // must stay out of the client-shared middleware module graph.
            // Head only (site + artifacts): memoized per request, so the
            // page's loaders reuse it instead of resolving again.
            const { resolveSiteVersion } = await import("@/lib/source")
            const head = await resolveSiteVersion(request)
            if (!head.seo.trailingSlash) {
                throw redirect({
                    href: withBase(
                        `${url.pathname.replace(/\/+$/, "")}${url.search}`,
                    ),
                    reloadDocument: true,
                    statusCode: 308,
                    headers: { "Cache-Control": agentConfig.cache.header },
                })
            }
        }
        return next()
    },
)

/**
 * Baseline security headers on EVERY response (thrown Responses included),
 * so the app is self-sufficient instead of relying on whatever edge sits in
 * front of it. HSTS preload with includeSubDomains only where the extension's
 * request policy asks for it — a domain someone else owns must never be
 * preload-committed by us (its apex and other subdomains are not ours to
 * promise). No surface is meant to be framed: the only iframe embeds
 * third-party content INTO docs, never the other way round.
 */
const securityHeadersMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        const { hstsPreload } = extensions.requestPolicy(request)
        const stamp = (headers: Headers) => {
            headers.set(
                "Strict-Transport-Security",
                hstsPreload
                    ? "max-age=63072000; includeSubDomains; preload"
                    : "max-age=31536000",
            )
            headers.set("X-Content-Type-Options", "nosniff")
            headers.set("X-Frame-Options", "DENY")
            headers.set("Content-Security-Policy", "frame-ancestors 'none'")
            headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
            headers.set(
                "Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), browsing-topics=()",
            )
        }
        try {
            const result = await next()
            stamp(result.response.headers)
            return result
        } catch (thrown) {
            if (thrown instanceof Response) {
                const response = new Response(thrown.body, thrown)
                stamp(response.headers)
                throw response
            }
            throw thrown
        }
    },
)

/**
 * Conditional GET for HTML: routes/$.tsx stamps a weak ETag from the
 * immutable identities behind a page (build SHA, content version, page);
 * a matching If-None-Match answers 304 with the same caching headers, so a
 * browser revalidating `max-age=0` moves zero bytes instead of the whole
 * document (the .md twin already does this in routes/{$}.md.ts).
 */
const etagMiddleware = createMiddleware().server(async ({ next, request }) => {
    const result = await next()
    // The loader sets the validator through the request-scoped response
    // store (setResponseHeader); Start merges that store into the Response
    // after the middleware chain, so read it from the store here.
    const etag =
        result.response.headers.get("etag") ?? getResponseHeader("ETag")
    // The store value is merged after this chain only for some response
    // shapes — copy it onto the Response so the validator always ships and
    // browsers/CDNs can revalidate with If-None-Match.
    if (etag && !result.response.headers.has("etag"))
        result.response.headers.set("ETag", etag)
    if (
        etag &&
        result.response.status === 200 &&
        request.headers.get("if-none-match") === etag
    ) {
        await result.response.body?.cancel()
        return {
            ...result,
            response: new Response(null, {
                status: 304,
                headers: (() => {
                    const headers = new Headers(result.response.headers)
                    headers.set("ETag", etag)
                    return headers
                })(),
            }),
        }
    }
    return result
})

/**
 * Mintlify publishes a changelog's feed at `/<page>/rss.xml`; this app serves
 * it at `/<page>.rss.xml` (a splat cannot carry a trailing static segment in
 * the file router). Answer the upstream path with a permanent redirect so
 * feed readers configured against the original site keep working.
 */
const rssAliasMiddleware = createMiddleware().server(({ next, request }) => {
    const url = new URL(request.url)
    // Exactly one leading slash: a `//host/…/rss.xml` pathname would turn
    // the captured prefix into a protocol-relative (off-site) redirect.
    const alias = /^(\/(?!\/)[^?#]+)\/rss\.xml$/i.exec(url.pathname)
    if (
        alias?.[1] &&
        !alias[1].includes("//") &&
        (request.method === "GET" || request.method === "HEAD") &&
        !NON_DOCS_PREFIX.test(url.pathname)
    ) {
        throw redirect({
            href: withBase(`${alias[1]}.rss.xml${url.search}`),
            reloadDocument: true,
            statusCode: 308,
            headers: { "Cache-Control": agentConfig.cache.header },
        })
    }
    return next()
})

/**
 * Content negotiation: a docs URL fetched with Accept: text/markdown (or
 * ?format=markdown) answers the page's markdown INLINE — the same body,
 * headers (Vary: Accept, ETag, canonical Link, shared cache policy) and
 * status the `.md` route serves — instead of a 307 hop. Agents that don't
 * follow redirects, and tools that count them, read the docs in one round
 * trip. The response keeps the shared policy: `Vary: Accept` on both the
 * markdown and the HTML (cacheMiddleware) keys the CDN entry per
 * representation, and cacheTagMiddleware tags it for the publish purge.
 *
 * Live-assistant fetchers arrive with `?__md=assistant`, set by the Vercel
 * router rewrite in vite.config.ts; they get markdown too unless the site
 * turned `agents.assistantMarkdown` off under the docs.json extension key
 * (then the marker URL just serves the HTML, cached under its own key).
 */
const llmMiddleware = createMiddleware().server(async ({ next, request }) => {
    const url = new URL(request.url)

    if (
        (request.method === "GET" || request.method === "HEAD") &&
        !NON_DOCS_PREFIX.test(url.pathname) &&
        !RESERVED_FILES.test(url.pathname) &&
        !url.pathname.endsWith(".md") &&
        // An explicit .pdf suffix is a format choice like .md — negotiating
        // it away would hand markdown-preferring agents a dead
        // "<page>.pdf.md" while the CDN could serve them cached PDF bytes
        // (the response doesn't Vary on Accept).
        !url.pathname.endsWith(".pdf")
    ) {
        let markdown = wantsMarkdown(request)
        if (
            !markdown &&
            url.searchParams.get(ASSISTANT_MARKDOWN_PARAM) === "assistant"
        ) {
            // Dynamic: source.ts opens the database pool at module load and
            // must stay out of the client-shared middleware module graph.
            const { resolveSiteVersion } = await import("@/lib/source")
            const head = await resolveSiteVersion(request)
            markdown = siteAgentSettings(head.config).assistantMarkdown
        }
        // Reuse the single URL normalizer instead of re-implementing slug splitting.
        // server.ts already removed the base path.
        const slugs = normalizeDocUrl(url.pathname, "")
        if (markdown)
            return getDocsMarkdown({
                request,
                params: { _splat: slugs.join("/") },
            })
        // An Accept admitting neither HTML nor */* (an HTTP client defaulting
        // to `Accept: application/json`) gets the router's 406: a page has no
        // JSON representation, and answering markdown under a JSON Accept
        // would hand a JSON parser prose. Keep the status, but replace the
        // router's bare error with one that names the representations that
        // do exist, so the client can recover in one hop.
        const result = await next()
        if (result.response.status !== 406) return result
        const markdownUrl = `${siteUrlFromRequest(request)}${slugsToMarkdownPath(slugs).url}`
        return Response.json(
            {
                error: "This URL serves text/html, or text/markdown when the Accept header asks for it.",
                markdown: markdownUrl,
            },
            {
                status: 406,
                headers: {
                    Vary: "Accept",
                    // Already escaped: the slugs come from the request's
                    // percent-encoded pathname.
                    Link: `<${markdownUrl}>; rel="alternate"; type="text/markdown"`,
                },
            },
        )
    }

    return next()
})

/**
 * Agent files the file router can't express: path-scoped
 * `/<scope>/llms.txt` + `/<scope>/llms-full.txt` (llmstxt.org scopes a file
 * to the URLs beneath it — a locale, a version, a section), the split-index
 * sub-indexes under `[/<scope>]/_llms/`, and `/mcp` — the MCP endpoint at
 * the path Mintlify sites use. `/mcp` only answers MCP traffic (a POST, or a
 * client asking for JSON or an event stream); a browser navigating to a
 * docs page named "mcp" still gets the page.
 */
const agentFilesMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        const url = new URL(request.url)
        if (NON_DOCS_PREFIX.test(url.pathname)) return next()
        if (url.pathname === "/mcp" && isSurfaceEnabled("mcp")) {
            const accept = request.headers.get("accept") ?? ""
            if (
                request.method === "POST" ||
                request.method === "DELETE" ||
                (request.method === "GET" &&
                    !accept.includes("text/html") &&
                    (accept.includes("application/json") ||
                        accept.includes("text/event-stream")))
            ) {
                const { handleMcp } = await import("@/routes/api/mcp")
                return handleMcp(request)
            }
            return next()
        }
        if (
            (request.method === "GET" || request.method === "HEAD") &&
            /(?:^|\/)(?:llms(?:-full)?\.txt$|_llms\/)/.test(url.pathname)
        ) {
            const { scopedLlmsRequest } = await import("@/lib/llms-index")
            const response = scopedLlmsRequest(request)
            if (response) return response
        }
        return next()
    },
)

/**
 * Adds the request policy's cache tag, which a publisher purges after content
 * changes. Apply it to shared-policy pages and stable-URL OG/PDF responses;
 * omit immutable content-hashed assets and no-store previews. Tags derive
 * from the request without a database read, and Vercel strips the internal
 * header at the CDN.
 */
const cacheTagMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        const result = await next()
        const response = result.response
        const cacheControl = response.headers.get("cache-control") ?? ""
        const pathname = new URL(request.url).pathname
        if (
            request.method === "GET" &&
            (cacheControl === agentConfig.cache.header ||
                ((pathname.startsWith("/og/docs") ||
                    pathname.endsWith(".pdf")) &&
                    cacheControl.startsWith("public")))
        ) {
            const { cacheTag } = extensions.requestPolicy(request)
            // Commas delimit tags and Vercel caps one at 256 chars: a tag
            // breaking either rule is dropped, never split or truncated —
            // truncation could alias two sites onto one purge.
            if (cacheTag && cacheTag.length <= 256 && !cacheTag.includes(","))
                response.headers.set("Vercel-Cache-Tag", cacheTag)
        }
        return result
    },
)

/**
 * With prerendering off (HTML varies by content version), host-keyed CDN
 * caching is what keeps page serving fast: Vercel's cache key includes the
 * domain, so hosts cache independently and can never share entries. Only bare router
 * GET 200/404 HTML without its own caching policy is stamped — API routes and
 * the .md/llms surfaces (including the negotiated inline markdown) already
 * set their own headers. A 404 is as identity-independent as a 200 and the
 * publish purge (cache tag) clears it when the page appears, so bot probes
 * of unknown URLs are absorbed at the CDN instead of re-running the miss
 * path; preview hosts still end up no-store (previewMiddleware wraps this).
 */
const cacheMiddleware = createMiddleware().server(
    async ({ next, request, handlerType }) => {
        const result = await next()
        const response = result.response
        if (
            handlerType === "router" &&
            request.method === "GET" &&
            (response.status === 200 || response.status === 404) &&
            !response.headers.has("cache-control") &&
            (response.headers.get("content-type") ?? "").includes(
                "text/html",
            ) &&
            !new URL(request.url).pathname.startsWith("/api")
        ) {
            response.headers.set("Cache-Control", agentConfig.cache.header)
            // Same URL serves HTML or negotiated markdown depending on Accept
            // — without this, a CDN-cached 200 would shadow the .md negotiation.
            response.headers.append("Vary", "Accept")
            // routes/$.tsx marks its 404s noindex through the request-scoped
            // response store, which Start merges only into ok responses —
            // copy it so the cached 404 carries it (see etagMiddleware).
            const robots = getResponseHeader("X-Robots-Tag")
            if (robots && !response.headers.has("x-robots-tag"))
                response.headers.set("X-Robots-Tag", robots)
        } else if (
            handlerType === "serverFn" &&
            request.method === "GET" &&
            response.ok &&
            !response.headers.has("cache-control")
        ) {
            // Server functions declare their own policy through the response
            // store (routes/$.tsx's page and chrome RPCs, on success only).
            // Start merges that store after this chain, so copy it onto the
            // Response where cacheTagMiddleware can tag it and
            // previewMiddleware can override it.
            const policy = getResponseHeader("Cache-Control")
            if (policy) response.headers.set("Cache-Control", policy)
        }
        return result
    },
)

/**
 * Advertise every implemented machine-readable surface from human pages,
 * markdown and the text indexes. Registered relations (RFC 8288) where one
 * exists — `describedby`, `alternate`, `sitemap`, `service-desc`,
 * `api-catalog` — and for the agent surfaces with no registered token, the
 * bare token Mintlify sites use alongside an owned relation URI. Also
 * stamps `X-Llms-Txt` and the site's `Content-Signal`.
 */
const discoveryMiddleware = createMiddleware().server(
    async ({ next, request }) => {
        const result = await next()
        const response = result.response
        const contentType = response.headers.get("content-type") ?? ""
        if (
            (request.method === "GET" || request.method === "HEAD") &&
            response.status >= 200 &&
            response.status < 300 &&
            (contentType.includes("text/html") ||
                contentType.includes("text/markdown") ||
                contentType.includes("text/plain"))
        ) {
            const rel = (token: string, ...registered: string[]) =>
                [
                    ...registered,
                    token,
                    `${AGENT_LINK_RELATION_BASE}${token}`,
                ].join(" ")
            // The site head is memoized per request — the page or index
            // that produced this response already resolved it.
            const { openapiDocumentIndex, resolveSiteVersion } = await import(
                "@/lib/source"
            )
            const head = await resolveSiteVersion(request).catch(() => null)
            const hasSpecs = head
                ? (await openapiDocumentIndex(head)).length > 0
                : false
            const links = [
                ...(isSurfaceEnabled("sitemap")
                    ? [
                          `<${withBase("/sitemap.xml")}>; rel="sitemap"; type="application/xml"`,
                      ]
                    : []),
                ...(isSurfaceEnabled("llms")
                    ? [
                          `<${withBase("/llms.txt")}>; rel="${rel("llms-txt", "describedby")}"; type="text/plain"; title="LLM index"`,
                      ]
                    : []),
                ...(isSurfaceEnabled("llmsFull")
                    ? [
                          `<${withBase("/llms-full.txt")}>; rel="${rel("llms-full-txt")}"; type="text/plain"; title="Full LLM corpus"`,
                      ]
                    : []),
                `<${withBase("/.well-known/llms-manifest.json")}>; rel="describedby"; type="application/json"`,
                ...(isSurfaceEnabled("mcp")
                    ? [
                          `<${withBase("/.well-known/mcp.json")}>; rel="service-desc"; type="application/json"`,
                          `<${withBase("/api/mcp/server-card")}>; rel="${rel("mcp-server-card")}"; type="application/mcp-server-card+json"`,
                      ]
                    : []),
                ...(hasSpecs
                    ? [
                          `<${withBase("/.well-known/api-catalog")}>; rel="api-catalog"; type="application/linkset+json"`,
                      ]
                    : []),
                ...(isSurfaceEnabled("skill")
                    ? [
                          `<${withBase("/.well-known/agent-skills/index.json")}>; rel="${rel("agent-skills")}"; type="application/json"`,
                          `<${withBase("/skill.md")}>; rel="alternate"; type="text/markdown"; title="Agent skill"`,
                          `<${withBase("/AGENTS.md")}>; rel="alternate"; type="text/markdown"; title="Agent instructions"`,
                      ]
                    : []),
            ]
            for (const link of links) response.headers.append("Link", link)
            if (isSurfaceEnabled("llms"))
                response.headers.set("X-Llms-Txt", withBase("/llms.txt"))
            if (head)
                response.headers.set(
                    "Content-Signal",
                    contentSignalValue(
                        siteAgentSettings(head.config).contentSignals,
                    ),
                )
        }
        return result
    },
)

export const startInstance = createStart(() => {
    return {
        // Sentry first so it wraps everything (error capture + tracing);
        // analytics stays ahead of the CSRF 403s and the llmMiddleware's
        // inline markdown answer it needs to observe.
        requestMiddleware: [
            sentryGlobalRequestMiddleware,
            ...wrapMiddlewaresWithSentry({
                analyticsMiddleware,
                securityHeadersMiddleware,
                // Outside preview/cache so it observes the FINAL Cache-Control:
                // cacheMiddleware's stamp and previewMiddleware's no-store
                // override both happen inside this wrapper.
                cacheTagMiddleware,
                previewMiddleware,
                assetProbeMiddleware,
                shortCircuitMiddleware,
                // Wraps every middleware and route below that reads the site head.
                notFoundMiddleware,
                discoveryMiddleware,
                // Sees the stamped Cache-Control/Vary so the 304 carries them.
                etagMiddleware,
                cacheMiddleware,
                csrfMiddleware,
                trailingSlashMiddleware,
                rssAliasMiddleware,
                agentFilesMiddleware,
                llmMiddleware,
            }),
        ],
        functionMiddleware: [sentryGlobalFunctionMiddleware],
        // kind="js" page bodies: the isolate snapshot is already in the SSR
        // HTML, so it dehydrates as null (lib/ssr-snapshot.ts).
        serializationAdapters: [ssrSnapshotAdapter],
        // Browser calls go to /_serverFn/<id>; a site under a base path
        // serves them under it (server.ts strips it again).
        serverFns: {
            fetch: (input, init) =>
                fetch(
                    typeof input === "string" ? withBase(input) : input,
                    init,
                ),
        },
    }
})
