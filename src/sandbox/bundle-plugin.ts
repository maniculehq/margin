import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type Plugin } from "vite"
import { chromeIcons } from "../../vite-plugins.ts"

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** Import specifiers that must never reach the isolate: browser-only
 * renderers loaded from effects (never during a string render) and their
 * multi-megabyte runtimes. Each resolves to an empty module. */
const STUBBED = new Set(["mermaid", "katex", "shiki"])

let bundlePromise: Promise<string> | undefined

/**
 * Build src/sandbox/render.tsx into ONE self-contained IIFE with no Node
 * built-ins, no CSS, and no dynamic chunks — the text that
 * src/lib/sandbox-render.ts compiles once per isolate. Runs as a nested Vite
 * build (configFile: false so the app config's Nitro/Start/Sentry plugins
 * stay out); memoized per process so dev, build, and tests pay once.
 */
export function buildSandboxRenderBundle(): Promise<string> {
    bundlePromise ??= (async () => {
        const result = await build({
            configFile: false,
            root: frameworkRoot,
            logLevel: "warn",
            mode: "production",
            define: {
                "process.env.NODE_ENV": JSON.stringify("production"),
                // lib/shared.ts reads SITE_NAME at module load (the app build
                // defines it too); the isolate reaches that module through
                // lib/base-path.ts and has no `process`.
                "process.env.SITE_NAME": "undefined",
            },
            // The host process may run under NODE_ENV=test (vitest) or
            // development (vite dev); the isolate always gets the production
            // JSX runtime, matching the define above (jsx-dev-runtime is
            // empty in production and would leave jsxDEV undefined).
            oxc: { jsx: { development: false } },
            resolve: {
                tsconfigPaths: true,
                alias: [
                    // renderToString lives in the legacy string renderer.
                    // `react-dom/server.browser` also loads the Fizz stream
                    // build, which constructs a MessageChannel at module
                    // init; the node build pulls stream/util/async_hooks.
                    // Neither exists in the isolate, so import the legacy
                    // file directly (not in react-dom's exports map, hence
                    // the resolved path).
                    {
                        find: /^react-dom\/server$/,
                        replacement: join(
                            dirname(
                                createRequire(import.meta.url).resolve(
                                    "react-dom",
                                ),
                            ),
                            "cjs/react-dom-server-legacy.browser.production.js",
                        ),
                    },
                ],
            },
            plugins: [
                // The component map reaches chrome-icons.tsx, which reads the
                // build-time icon extraction the app build registers too.
                chromeIcons(),
                {
                    name: "sandbox-render-stubs",
                    enforce: "pre",
                    resolveId(id) {
                        if (id.endsWith(".css") || STUBBED.has(id))
                            return "\0sandbox-empty"
                    },
                    load(id) {
                        if (id === "\0sandbox-empty") return "export default {}"
                    },
                },
            ],
            build: {
                write: false,
                target: "es2022",
                minify: false,
                sourcemap: false,
                cssCodeSplit: false,
                lib: {
                    entry: resolve(frameworkRoot, "src/sandbox/render.tsx"),
                    formats: ["iife"],
                    name: "__sandboxRender",
                    fileName: () => "render.js",
                },
                rolldownOptions: {
                    // "use client" markers are meaningless in an IIFE and
                    // every fumadocs component carries one.
                    onwarn(warning, warn) {
                        if (warning.code !== "MODULE_LEVEL_DIRECTIVE")
                            warn(warning)
                    },
                },
            },
        })
        const outputs = Array.isArray(result) ? result : [result]
        for (const output of outputs) {
            if (!("output" in output)) continue
            for (const chunk of output.output) {
                if (chunk.type === "chunk" && chunk.isEntry) return chunk.code
            }
        }
        throw new Error("sandbox render bundle produced no entry chunk")
    })()
    return bundlePromise
}

/**
 * `virtual:sandbox-render-bundle` — the IIFE text as a string default
 * export, the same delivery trick resvgWasmBase64 (vite.config.ts) uses for
 * the resvg wasm: Vercel function bundling only ships what the server graph
 * imports.
 */
export function sandboxRenderBundle(): Plugin {
    return {
        name: "sandbox-render-bundle",
        resolveId(id) {
            if (id === "virtual:sandbox-render-bundle")
                return "\0sandbox-render-bundle"
        },
        async load(id) {
            if (id !== "\0sandbox-render-bundle") return
            const code = await buildSandboxRenderBundle()
            return `export default ${JSON.stringify(code)}`
        },
    }
}
