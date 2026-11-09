import {
    createMemoryHistory,
    createRouter as createTanStackRouter,
} from "@tanstack/react-router"
import { NotFound } from "@/components/not-found"
import { basePath, stripBase, withBase } from "@/lib/base-path"
import { routeTree } from "./routeTree.gen"

/** Built per request on the server and once in the browser, so the base
 * path is read when the router is created. */
export function getRouter() {
    const base = basePath()
    const router = createTanStackRouter({
        routeTree,
        defaultPreload: "intent",
        // Trailing-slash policy is per site (seo.trailingSlash): start.ts
        // and routes/$.tsx redirect between the two spellings; the router
        // itself must not canonicalise one of them away.
        trailingSlash: "preserve",
        scrollRestoration: true,
        defaultNotFoundComponent: NotFound,
        // A site under a base path: routes match the unprefixed path and
        // every href the router builds gets the prefix back. Not
        // `basepath`, which Start overwrites per request with the
        // build-time TSS_ROUTER_BASEPATH.
        rewrite: base
            ? {
                  input: ({ url }) => {
                      url.pathname =
                          stripBase(url.pathname, base) ?? url.pathname
                      return url
                  },
                  output: ({ url }) => {
                      url.pathname = withBase(url.pathname, base)
                      return url
                  },
              }
            : undefined,
    })
    if (base && typeof document === "undefined") {
        // Start builds the server router's history from the request, which
        // server.ts has already stripped, and the router redirects any
        // request whose href differs from the public href it builds for the
        // same location. Hand it the public href; the input rewrite above
        // strips it again.
        const update = router.update
        router.update = (options) =>
            update(
                options.history
                    ? {
                          ...options,
                          history: createMemoryHistory({
                              initialEntries: [
                                  withBase(options.history.location.href, base),
                              ],
                          }),
                      }
                    : options,
            )
    }
    return router
}
