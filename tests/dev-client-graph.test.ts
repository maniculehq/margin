/**
 * The dev server's client module graph stays free of server-only code.
 *
 * Production tree-shakes a dead server-only helper out of the client bundle,
 * but the dev client transform keeps every top-level function a route file
 * declares, along with its imports. A plain helper in `routes/$.tsx` that
 * only server-fn handlers called kept `@/lib/source` in the browser graph;
 * that pulled `@/db` and `@sentry/node`, which throws on load in a
 * browser, so the client entry rejected and no page ever hydrated in
 * `bun run dev` (bundle-budget.test.ts cannot see it: the build was clean).
 *
 * Walks the client environment's transformed graph from the app's client
 * entries, the same modules a browser requests, without descending into
 * dependencies.
 */

import { fileURLToPath } from "node:url"
import { createServer, type ViteDevServer } from "vite"
import { afterAll, beforeAll, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))

/** Modules that must never reach the browser: the DB layer, the source
 * loader that reads it and the build-time ingest pipeline, plus the
 * Node-only packages they import. */
const SERVER_ONLY =
    /\/src\/(?:db|ingest)\/|\/src\/lib\/source\.ts$|\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:@sentry\/node|pg|drizzle-orm|isolated-vm|posthog-node)\//

let server: ViteDevServer

beforeAll(async () => {
    server = await createServer({
        configFile: fileURLToPath(
            new URL("../vite.config.ts", import.meta.url),
        ),
        root,
        logLevel: "silent",
        // No pre-bundling: bare imports stay as resolved file paths, so the
        // walk can name the packages a source module pulls in.
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    })
}, 120_000)

afterAll(async () => {
    await server?.close()
})

it("keeps server-only modules out of the dev client graph", async () => {
    const client = server.environments.client
    // The app modules TanStack Start's client entry loads: the router
    // (and through routeTree.gen.ts every route) and the start instance.
    const queue = ["/src/router.tsx", "/src/start.ts"]
    const visited = new Set<string>()
    const reached: string[] = []
    for (let url = queue.pop(); url !== undefined; url = queue.pop()) {
        if (visited.has(url)) continue
        visited.add(url)
        await client.transformRequest(url)
        const node = await client.moduleGraph.getModuleByUrl(url)
        for (const imported of node?.importedModules ?? []) {
            const file = imported.file ?? imported.id ?? imported.url
            if (SERVER_ONLY.test(file)) reached.push(`${url} -> ${file}`)
            // Dependencies are not walked: what matters is which ones the
            // app's own (and workspace) modules import.
            else if (!file.includes("/node_modules/")) queue.push(imported.url)
        }
    }
    // The walk reached the docs route's client transform, so an empty
    // `reached` means the route was checked, not skipped.
    expect(
        [...visited].some((url) => url.startsWith("/src/routes/$.tsx")),
    ).toBe(true)
    expect(reached).toEqual([])
}, 120_000)
