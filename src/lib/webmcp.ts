import { captureException } from "@sentry/tanstackstart-react"
import type {} from "webmcp-types"

/** Load and register a component's WebMCP tools only when the feature is on
 *  for this viewer AND the browser is Chrome or Edge and exposes
 *  `document.modelContext`, so every other browser never downloads the tool
 *  chunk. `enabled` is the site's
 *  WebMCP setting as evaluated by the route loader; `undefined` is treated
 *  as off. `register` dynamically imports the tools module and registers
 *  them with the given signal; returns the effect cleanup, which aborts it.
 *  A failed chunk load is logged and sent to Sentry when a client is
 *  initialised (`captureException` is a no-op otherwise).
 *
 *  useEffect(() => loadWebmcpTools(webmcp, (signal) =>
 *      import("./x-webmcp").then((tools) => tools.registerXTools(..., signal)),
 *  ), [webmcp, ...]) */
export function loadWebmcpTools(
    enabled: boolean | undefined,
    register: (signal: AbortSignal) => Promise<void>,
) {
    // WebMCP ships to Chrome and Edge only for now (a host supplies its origin
    // trial tokens through the headMeta extension); Chromium-based Opera and
    // Samsung also match.
    const chromeOrEdge = /Chrome\/|Edg\//.test(navigator.userAgent)
    if (enabled !== true || !chromeOrEdge || !document.modelContext) return
    const registration = new AbortController()
    register(registration.signal).catch((error: unknown) => {
        console.error("WebMCP: loading tools failed", error)
        captureException(error, { tags: { webmcp: "load" } })
    })
    return () => registration.abort()
}
