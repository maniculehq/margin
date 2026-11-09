import * as Sentry from "@sentry/tanstackstart-react"
import {
    createStartHandler,
    defaultStreamHandler,
} from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { waitUntil } from "@vercel/functions"
import { extensions } from "#docs-extensions"
import { agentConfig } from "@/lib/agent.config"
import { type SiteScope, siteScope, stripBase, withBase } from "@/lib/base-path"
import { flushTelemetry, initSentry } from "./instrument-sentry"

// Sentry must initialize before the handler serves anything. An explicit
// call, not a side-effect import — see instrument-sentry.ts.
initSentry()

// The build manifest's script and stylesheet URLs are root-relative
// (/_margin/assets/…). One deployment serves sites at different base paths,
// so they are prefixed per request rather than cached once.
const handler = createStartHandler({
    handler: defaultStreamHandler,
    transformAssets: { transform: ({ url }) => withBase(url), cache: false },
})

const instrumented = Sentry.wrapFetchWithSentry({
    fetch: (request) => handler(request),
})

/**
 * Only server functions and API routes go through Sentry's fetch wrapper:
 * it unconditionally rewrites every text/html body to inject
 * `sentry-trace` / `baggage` meta tags (no SDK switch), which the CDN then
 * caches into every visitor's page — stale trace ids plus the release SHA
 * and org id on a public surface, for a browser SDK that was never
 * installed. Page requests keep error capture (the one thing the wrapper
 * added for them) inline; loaders and middleware are already covered by
 * sentryGlobalRequestMiddleware in start.ts. The spanEnd → waitUntil hook in
 * instrument-sentry.ts flushes when the request span ends, which can be
 * before an SSR error surfaces here, so the capture below schedules its own
 * drain before rethrowing.
 */
async function serve(request: Request): Promise<Response> {
    if (/^\/(?:_serverFn|api)(?:\/|$)/.test(new URL(request.url).pathname))
        return instrumented.fetch(request)
    try {
        return await handler(request)
    } catch (error) {
        Sentry.captureException(error, {
            mechanism: { type: "auto.http.tanstackstart", handled: false },
        })
        // Keep the instance alive until this event ships.
        waitUntil(flushTelemetry())
        throw error
    }
}

/**
 * Custom server entry so Sentry can wrap the request handler (SSR rendering
 * exceptions are not covered by the start middlewares) and so a site can
 * serve under a base path (`SiteResolution.basePath`, e.g. "/docs" behind
 * its owner's proxy). Requests outside the base path get a 308 to the same
 * path under it; requests inside it are routed with the prefix removed, so
 * middleware, routes and loaders see root-relative paths, and run in the
 * site scope `withBase` and `siteUrlFromRequest` read (lib/base-path.ts).
 * Responses pass through untouched: every redirect names its public
 * target at its source (`withBase` on an internal path), because a
 * `Location` that starts with the base path is not thereby prefixed (under
 * "/help", the internal page /help/x redirects to /help/help/x).
 */
export default createServerEntry({
    fetch: async (request) => {
        // Every request takes this step, short-circuited ones included: the
        // extension's short-circuits see the stripped path (start.ts), so an
        // answer meant for /docs/x is never reachable at /x. A site lookup
        // that fails serves at the root, and the handler answers as it would
        // without a base path (source.ts surfaces the same failure).
        const resolution = await extensions
            .resolveSite(request)
            .catch(() => null)
        const scope: SiteScope = resolution
            ? {
                  basePath: resolution.basePath,
                  publicOrigin: resolution.publicOrigin,
                  sharedClientAddress: resolution.sharedClientAddress ?? false,
              }
            : { basePath: "", publicOrigin: null, sharedClientAddress: false }
        if (!scope.basePath) return siteScope().run(scope, () => serve(request))

        const url = new URL(request.url)
        const inner = stripBase(url.pathname, scope.basePath)
        // Built files stay at /_margin/assets/ too: the static handler serves
        // them there, and a miss must stay a 404 rather than redirect back
        // under the base path (vite.config.ts maps /<base>/_margin/assets/
        // onto it). A path that starts with "//" once the base path is
        // removed would parse as a host below (/docs//guide served the
        // home page), so it redirects to its single-slash spelling, as the
        // router answers //guide at the root.
        if (
            (inner === null && !url.pathname.startsWith("/_margin/assets/")) ||
            inner?.startsWith("//")
        ) {
            // Links from before the site moved under its base path keep
            // working. Shared like a page (the extension's cache tag purges
            // it when the base path changes); never stored by browsers.
            const { cacheTag, preview } = extensions.requestPolicy(request)
            const path = (inner ?? url.pathname).replace(/^\/+/, "/")
            const headers = new Headers({
                Location: `${scope.basePath}${path === "/" ? "" : path}${url.search}`,
                "Cache-Control": preview
                    ? "private, no-store"
                    : agentConfig.cache.header,
            })
            // Tagged like start.ts tags a page: a tag with a comma or past
            // Vercel's 256 chars is dropped, never split or truncated.
            if (
                !preview &&
                cacheTag &&
                cacheTag.length <= 256 &&
                !cacheTag.includes(",")
            )
                headers.set("Vercel-Cache-Tag", cacheTag)
            return new Response(null, { status: 308, headers })
        }

        return siteScope().run(scope, () =>
            serve(
                inner === null
                    ? request
                    : new Request(
                          new URL(`${inner}${url.search}`, url),
                          request,
                      ),
            ),
        )
    },
})
