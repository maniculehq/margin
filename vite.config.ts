import { resolve } from "node:path"
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig, type Plugin } from "vite"
import { env } from "./src/env.ts"
import {
    ASSISTANT_MARKDOWN_PARAM,
    ASSISTANT_USER_AGENT_PATTERN,
} from "./src/lib/agent.config.ts"
import { sandboxRenderBundle } from "./src/sandbox/bundle-plugin.ts"
import {
    chromeIcons,
    clientModuleReport,
    resvgWasmBase64,
    traceOptsFor,
} from "./vite-plugins.ts"

/**
 * Source-map upload and release creation need all four Sentry values; with
 * any one missing the Sentry Vite plugin stays out of the build entirely
 * (runtime error capture only needs SENTRY_DSN, see src/instrument-sentry.ts).
 */
const sentryUpload =
    env.SENTRY_DSN &&
    env.SENTRY_ORG &&
    env.SENTRY_PROJECT &&
    env.SENTRY_AUTH_TOKEN
        ? {
              org: env.SENTRY_ORG,
              project: env.SENTRY_PROJECT,
              authToken: env.SENTRY_AUTH_TOKEN,
          }
        : undefined

/**
 * Bakes the content version this build serves: DOCS_CONTENT_SHA, else
 * VERCEL_GIT_COMMIT_SHA. `vercel-build` (scripts/vercel-build.ts) resolves
 * the version once — adding the git HEAD and `dev-<ms>` fallbacks — and
 * hands the same DOCS_CONTENT_SHA to the ingest and to this build, so the
 * server serves exactly the version it ingested. A plain `vite build` with
 * neither bakes no version and serves the `current` pointer; `vite dev`
 * never bakes one (the watch ingest moves `current`).
 */
function docsContentSha(): Plugin {
    return {
        name: "docs-content-sha",
        config(_config, { command }) {
            if (command !== "build") return
            const sha = env.DOCS_CONTENT_SHA ?? env.VERCEL_GIT_COMMIT_SHA
            return {
                define: {
                    "process.env.DOCS_CONTENT_SHA": sha
                        ? JSON.stringify(sha)
                        : "undefined",
                },
            }
        },
    }
}

/**
 * SITE_NAME overrides the docs.json name in the chrome; lib/shared.ts reads
 * it as a build-time literal so that module stays free of the env module.
 * Every environment gets it; environment `define`s merge over this one.
 */
const siteNameDefine = {
    "process.env.SITE_NAME": JSON.stringify(env.SITE_NAME) ?? "undefined",
}

/**
 * Live-assistant fetchers (ChatGPT-User, Claude-User, …) get a page's
 * markdown without asking for it. The rewrite runs in Vercel's router,
 * BEFORE the CDN cache, and moves them to a marker query: the markdown
 * caches under its own key, so the HTML entry never varies on User-Agent and
 * a browser can never be served a cached markdown body. llmMiddleware
 * (start.ts) answers the marker unless the site opted out. Docs paths
 * only: no API/asset/well-known prefix, no file extension on the last
 * segment (.md, .txt, .xml … already are agent formats). Build Output API
 * routes support `has`/`missing`; Nitro's route type predates them, so the
 * route is a named value rather than an inline literal. Under a site's base
 * path (`/docs/api/…`) the prefix list cannot apply: the base path is per
 * request, and a pattern that skipped those prefixes at any depth would also
 * skip docs pages such as /reference/api. The marker is then harmless:
 * llmMiddleware checks the same prefixes against the path server.ts has
 * already stripped, so a non-docs route ignores it, and the only cost is a
 * separate CDN entry for live-assistant fetchers.
 */
const assistantMarkdownRoute = {
    src: "^/(?!(?:api|og|_assets|_theme|_margin|_build|\\.well-known|_llms)(?:/|$))((?:[^/]+/)*[^/.]*)$",
    has: [
        {
            type: "header",
            key: "user-agent",
            value: `(?i).*(?:${ASSISTANT_USER_AGENT_PATTERN}).*`,
        },
    ],
    missing: [{ type: "query", key: ASSISTANT_MARKDOWN_PARAM }],
    dest: `/$1?${ASSISTANT_MARKDOWN_PARAM}=assistant`,
    continue: true,
}

/**
 * Built files live under /_margin/assets/ (build.assetsDir). A site under a
 * base path links them as /docs/_margin/assets/… (server.ts transformAssets,
 * relative chunk URLs below); Vercel serves those from the static output.
 * `continue` lets the generated cache-header and missing-asset routes match
 * the rewritten path before the filesystem answers it.
 */
const basePathAssetsRoute = {
    src: "^/.+?/(_margin/assets/.+)$",
    dest: "/$1",
    continue: true,
}

// Which source modules each client chunk bundles, read by
// tests/conventions/client-build.test.ts.
const moduleReport = clientModuleReport()

export default defineConfig({
    define: siteNameDefine,
    nitro: {
        preset: env.NITRO_PRESET,
        // Keep these CommonJS/WASM/native packages intact at runtime.
        // Bundling harfbuzzjs into Nitro's ESM _libs removes its Node
        // __dirname and breaks Satori before Resvg can render an OG image;
        // isolated-vm loads its prebuilt .node addon through node-gyp-build
        // relative to its own package directory.
        //
        // @sentry/tanstackstart-react is on nf3's non-bundleable list, so it
        // shipped as ~500 loose files (@sentry/node, core, server-utils)
        // that Node parsed one by one on every cold start (~125 ms). This
        // app has no OTel preload for Sentry's module hooks to attach to
        // (see src/instrument-sentry.ts), so bundling loses nothing.
        traceDeps: [
            "pdfkit*",
            "harfbuzzjs*",
            "isolated-vm*",
            "!@sentry/tanstackstart-react",
        ],
        // Vercel builds drop sharp's musl binaries; see traceOptsFor.
        traceOpts: traceOptsFor(env.NITRO_PRESET),
        // Self-hosted servers (node-server preset): Nitro's static handler
        // serves /_margin/assets/* only at the root, ahead of the app, so a
        // site under a base path of up to four segments maps
        // /<base>/_margin/assets/* onto it in-process. On Vercel the
        // basePathAssetsRoute below answers first, from the CDN.
        routeRules: Object.fromEntries(
            [1, 2, 3, 4].map((depth) => [
                `${Array.from({ length: depth }, (_, i) => `/:base${i}`).join("")}/_margin/assets/**`,
                { proxy: "/_margin/assets/**" },
            ]),
        ),
        // isolated-vm 7 requires Node >= 24 (package.json engines mirrors
        // this); Nitro otherwise pins the function to the build host's
        // major, which Vercel's build image may not match.
        vercel: {
            functions: { runtime: "nodejs24.x" },
            config: {
                version: 3,
                routes: [basePathAssetsRoute, assistantMarkdownRoute],
            },
        },
    },
    server: {
        ...(env.PORT === undefined ? {} : { port: env.PORT, strictPort: true }),
    },
    // `vite preview` (the start script) listens on preview.port, not server.port.
    preview: {
        ...(env.PORT === undefined ? {} : { port: env.PORT, strictPort: true }),
    },
    environments: {
        client: {
            build: {
                rolldownOptions: {
                    output: {
                        // Stable vendor chunks: a content-component change
                        // must not invalidate React/TanStack/fumadocs for
                        // every returning visitor, and no single chunk
                        // should carry the whole app (the pre-split bundle
                        // was one 2.7 MB file).
                        codeSplitting: {
                            groups: [
                                {
                                    name: "react",
                                    test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                                    priority: 40,
                                },
                                {
                                    name: "tanstack",
                                    test: /node_modules[\\/]@tanstack[\\/]/,
                                    priority: 30,
                                },
                                {
                                    name: "fumadocs",
                                    test: /node_modules[\\/]fumadocs-(?:ui|core)[\\/]/,
                                    priority: 20,
                                },
                                {
                                    name: "radix",
                                    test: /node_modules[\\/]@radix-ui[\\/]/,
                                    priority: 10,
                                },
                            ],
                            minSize: 20_000,
                        },
                    },
                },
            },
            define: {
                ...siteNameDefine,
                "process.env.VERCEL_ENV":
                    JSON.stringify(env.VERCEL_ENV) ?? "undefined",
                // SITE_ORIGIN is a shared (client + server) required value with
                // no fallback; the browser bundle has no process.env, so inline
                // the build-time value the same way as VERCEL_ENV.
                "process.env.SITE_ORIGIN": JSON.stringify(env.SITE_ORIGIN),
            },
        },
        ssr: {
            resolve: {
                noExternal: ["fumadocs-ui"],
            },
        },
    },
    worker: { plugins: () => [moduleReport.worker()] },
    plugins: [
        moduleReport.client,
        resvgWasmBase64(),
        chromeIcons(),
        sandboxRenderBundle(),
        docsContentSha(),
        tailwindcss(),
        // Prerendering is OFF by design: content lives in Postgres and moves
        // with each ingest, and a DocsExtensions host may serve different
        // sites per hostname, so no page's HTML is fixed at build time.
        // Serving stays fast via host-keyed CDN caching (s-maxage) — Vercel's
        // cache key includes the domain. (observability.ts keeps its
        // x-prerender guard for any future build-time crawl.)
        tanstackStart(),
        react(),
        // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
        nitro(),
        // Last in the array (Sentry's documented placement): source-map
        // upload for readable server stack traces. Middleware is wrapped
        // explicitly in start.ts, so auto-instrumentation stays off.
        ...(sentryUpload
            ? [
                  sentryTanstackStart({
                      ...sentryUpload,
                      autoInstrumentMiddleware: false,
                      release: { create: true },
                      silent: !env.CI,
                  }),
              ]
            : []),
    ],
    // A site's base path is chosen per request (server.ts), so browser code
    // must not hard-code built URLs to the root: chunk preloads, lazy CSS,
    // `?url` imports and CSS url()s resolve against the file that names them.
    // The server's own `?url` values stay root-relative; routes/__root.tsx
    // prefixes them when it renders them.
    experimental: {
        renderBuiltUrl: (_filename, { ssr }) =>
            ssr ? undefined : { relative: true },
    },
    build: {
        // One reserved prefix for everything the build emits, so a Vercel
        // route can map /<base>/_margin/assets/* without matching a docs page.
        assetsDir: "_margin/assets",
        rollupOptions: {
            // Shiki uses its JS regex engine; externalize the unused WASM
            // import. Bundle Satori and resvg so Vercel includes them in the
            // function that serves /og/docs/*.
            external: [/shiki\/wasm/],
        },
    },
    resolve: {
        tsconfigPaths: true,
        alias: {
            // The site seam (src/extensions/types.ts): a host swaps in its
            // own DocsExtensions module at build time. A relative path
            // resolves against this file's directory.
            "#docs-extensions": process.env.DOCS_EXTENSIONS
                ? resolve(import.meta.dirname, process.env.DOCS_EXTENSIONS)
                : resolve(import.meta.dirname, "src/extensions/default.ts"),
        },
    },
})
