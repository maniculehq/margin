// Relative path on purpose: Vite bundles the config with esbuild, which
// inlines relative TypeScript imports but externalizes path aliases —
// leaving Node to load the .ts source directly at config load.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { OutputBundle, PluginContext } from "rolldown"
import type { Plugin } from "vite"
import chromeIconNames from "./scripts/icon-chrome.json" with { type: "json" }
import { resolveDocsIconSvg } from "./src/types/docs-icons.ts"

/**
 * The framework chrome (chrome-icons.tsx) and code-tab triggers (mdx.tsx) use
 * a few dozen glyphs from the generated Hugeicons map, listed in
 * `scripts/icon-chrome.json` (`icons:build` fails if any is missing).
 * Importing the map in the browser cost 2 MB of JavaScript per visitor;
 * extracting those glyphs at build time keeps them in lockstep with the map
 * at zero client cost. Every other icon is resolved server-side (ingest,
 * serveLayoutConfig, page tree).
 */
export function chromeIcons(): Plugin {
    return {
        name: "chrome-icons",
        resolveId(id) {
            if (id === "virtual:chrome-icons") return "\0chrome-icons"
        },
        load(id) {
            if (id !== "\0chrome-icons") return
            const icons = Object.fromEntries(
                chromeIconNames.map((name) => {
                    const svg = resolveDocsIconSvg(name)
                    if (!svg)
                        throw new Error(
                            `chrome icon "${name}" is missing from the map`,
                        )
                    return [name, svg]
                }),
            )
            return `export default ${JSON.stringify(icons)}`
        },
    }
}

/**
 * Inline @resvg/resvg-wasm's binary as base64 at build time. The wasm can't
 * ship any other way: `?inline` collides with vite's .wasm handling,
 * `new URL(..., import.meta.url)` into node_modules isn't rewritten, and
 * externalized packages never get traced into the Vercel function (which is
 * how /og/docs/* 404ed silently in prod). Reading from node_modules keeps the
 * bytes in lockstep with the installed package version.
 */
export function resvgWasmBase64(): Plugin {
    return {
        name: "resvg-wasm-base64",
        resolveId(id) {
            if (id === "virtual:resvg-wasm-base64") return "\0resvg-wasm-b64"
        },
        load(id) {
            if (id !== "\0resvg-wasm-b64") return
            // The package exports map hides package.json — resolve the main
            // entry and read the wasm sibling.
            const require = createRequire(import.meta.url)
            const wasmPath = join(
                dirname(require.resolve("@resvg/resvg-wasm")),
                "index_bg.wasm",
            )
            return `export default "${readFileSync(wasmPath).toString("base64")}"`
        },
    }
}

/**
 * Record what every client chunk bundles, worker bundles included, as
 * `<cacheDir>/client-modules.json`: each chunk's modules, its static imports,
 * whether it is an entry and whether a worker bundle emitted it, plus the
 * importers of each bundled module and of everything above it. Module ids
 * are relative to the root. Kept out of the served output on purpose;
 * `tests/conventions/client-build.test.ts` reads it to prove no server-only
 * module or classic zod reaches the browser. Register `client` as a plugin
 * and `worker` in `worker.plugins`.
 */
export function clientModuleReport(): {
    client: Plugin
    worker: () => Plugin
} {
    const report: {
        chunks: Record<
            string,
            {
                modules: string[]
                imports: string[]
                isEntry: boolean
                worker: boolean
            }
        >
        importers: Record<string, string[]>
    } = { chunks: {}, importers: {} }
    let root = process.cwd()
    let reportPath = join(root, "node_modules/.vite/client-modules.json")
    const id = (moduleId: string) =>
        isAbsolute(moduleId) ? relative(root, moduleId) : moduleId
    function collect(
        this: PluginContext,
        bundle: OutputBundle,
        worker: boolean,
    ) {
        for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue
            report.chunks[output.fileName] = {
                modules: output.moduleIds.map(id),
                imports: output.imports,
                isEntry: output.isEntry,
                worker,
            }
            // Up the importer graph from every bundled module, through the
            // re-export barrels that render no code of their own.
            const queue = [...output.moduleIds]
            for (let moduleId = queue.pop(); moduleId; moduleId = queue.pop()) {
                if (id(moduleId) in report.importers) continue
                const info = this.getModuleInfo(moduleId)
                const importers = [
                    ...(info?.importers ?? []),
                    ...(info?.dynamicImporters ?? []),
                ]
                report.importers[id(moduleId)] = importers.map(id)
                queue.push(...importers)
            }
        }
    }
    return {
        client: {
            name: "client-module-report",
            applyToEnvironment: (environment) => environment.name === "client",
            configResolved(config) {
                root = config.root
                reportPath = join(config.cacheDir, "client-modules.json")
            },
            generateBundle(_options, bundle) {
                collect.call(this, bundle, false)
            },
            writeBundle() {
                mkdirSync(dirname(reportPath), { recursive: true })
                writeFileSync(reportPath, JSON.stringify(report))
            },
        },
        worker: () => ({
            name: "client-module-report-worker",
            generateBundle(_options, bundle) {
                collect.call(this, bundle, true)
            },
        }),
    }
}

/**
 * Nitro trace options for a preset. Vercel's nodejs24.x runs on glibc Amazon
 * Linux, so the musl builds sharp lists as optionalDependencies (~19 MB of
 * libvips) are never loaded there; nf3 copies every optional dependency of a
 * traced package, so a Vercel build drops the musl ones before it writes the
 * function. Every other preset keeps them: a node-server output may run on
 * Alpine, where sharp loads only the musl build.
 */
export function traceOptsFor(preset: string) {
    if (!/^vercel(?:$|[-_])/.test(preset)) return undefined
    return {
        hooks: {
            tracedPackages: (packages: Record<string, unknown>) => {
                for (const name of Object.keys(packages)) {
                    if (/(?:linux-\w+-musl|linuxmusl-\w+)$/.test(name)) {
                        delete packages[name]
                    }
                }
            },
        },
    }
}
