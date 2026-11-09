/**
 * Client bundle budget. Runs against a build (`.output/public` from
 * `NITRO_PRESET=node-server bun run build`, or Vercel's static output) —
 * the budget guards the regression that shipped the 2 MB icon map and a
 * 2.7 MB single chunk to every visitor.
 * Locally a missing build skips; on Vercel and in CI it fails, so a moved
 * output directory cannot turn the budget into a green no-op.
 */

import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs"
import { findPackageJSON } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { traceOptsFor } from "../vite-plugins"
import { ASSETS_DIR, REQUIRE_BUILD } from "./build-output"

/**
 * Chunks that exist only behind a user action or a rare page kind and are
 * never modulepreloaded on a docs page: mermaid + its layout engines, shiki
 * grammars, KaTeX, the OpenAPI console. Everything else must fit the
 * per-chunk budget.
 */
const LAZY_ONLY =
    /^(?:elk|cytoscape|katex|api-page|mermaid|[a-z0-9+#-]+-[A-Za-z0-9_-]{8}\.js$)/

it.runIf(REQUIRE_BUILD)("finds the build output to budget", () => {
    expect(ASSETS_DIR, "no client assets directory; build first").toBeDefined()
})

describe.skipIf(!ASSETS_DIR)("client bundle budget", () => {
    // Vitest collects a skipped describe's body too: list nothing then.
    const files = (ASSETS_DIR ? readdirSync(ASSETS_DIR) : [])
        .filter((file) => file.endsWith(".js"))
        .map((file) => ({
            file,
            size: statSync(join(ASSETS_DIR ?? "", file)).size,
        }))
        .sort((a, b) => b.size - a.size)

    it("ships no icon map to the browser", () => {
        // The map's first key: `DOCS_ICON_SVGS` (and its source JSON) start
        // with it, while the chrome subset in `virtual:chrome-icons` never
        // lists it.
        const iconMap = z
            .record(z.string(), z.unknown())
            .parse(
                JSON.parse(
                    readFileSync(
                        resolve(
                            import.meta.dirname,
                            "../scripts/icon-map.json",
                        ),
                        "utf8",
                    ),
                ),
            )
        const firstKey = Object.keys(iconMap)[0]
        const chromeNames = z
            .array(z.string())
            .parse(
                JSON.parse(
                    readFileSync(
                        resolve(
                            import.meta.dirname,
                            "../scripts/icon-chrome.json",
                        ),
                        "utf8",
                    ),
                ),
            )
        expect(firstKey).toBeDefined()
        expect(chromeNames).not.toContain(firstKey)
        expect(files.length).toBeGreaterThan(0)
        // Unquoted: a minifier may emit the key with either quote style.
        for (const { file } of files) {
            expect(
                readFileSync(join(ASSETS_DIR ?? "", file), "utf8"),
                `${file} contains the docs icon map`,
            ).not.toContain(firstKey)
        }
    })

    it("ships no classic zod in the chunks a docs page loads eagerly", () => {
        // The client entry and the docs route chunk (`routes/$.tsx`), plus
        // everything they import statically. `import()` targets load on
        // demand: the Ask-AI panel (the `ai` SDK bundles classic zod) and the
        // OpenAPI console. zod/mini names its classes `ZodMini*`; core's
        // `$ZodEncodeError` sets its name to "ZodEncodeError".
        const queue = files
            .map(({ file }) => file)
            .filter((file) => /^(?:index|_)-[\w-]{8}\.js$/.test(file))
        expect(queue.length).toBeGreaterThanOrEqual(2)
        const eager = new Set<string>()
        for (let file = queue.pop(); file; file = queue.pop()) {
            if (eager.has(file)) continue
            eager.add(file)
            const source = readFileSync(join(ASSETS_DIR ?? "", file), "utf8")
            for (const [, imported] of source.matchAll(
                /\b(?:import|export)\s*(?:[\w$\s{},*]*?from\s*)?["']\.\/([\w.-]+\.js)["']/g,
            )) {
                if (imported) queue.push(imported)
            }
            expect(source, `${file} bundles classic zod`).not.toMatch(
                /["'`]Zod(?!Mini|EncodeError)[A-Z][A-Za-z]+["'`]/,
            )
        }
        expect([...eager].some((file) => file.startsWith("react-"))).toBe(true)
    })

    it("keeps every eagerly loaded chunk under 700 KB raw", () => {
        // Named vendor groups (react, tanstack, fumadocs, radix) and the
        // route entry `index-*` are what a docs page preloads; the shiki
        // grammar chunks (`cpp-*`, `emacs-lisp-*`, …) and diagram engines
        // load on demand and are excluded by name.
        const eager = files.filter(
            ({ file }) =>
                /^(?:index|react|tanstack|fumadocs|radix|chunk)-/.test(file) &&
                !LAZY_ONLY.test(file),
        )
        expect(eager.length).toBeGreaterThan(0)
        for (const { file, size } of eager) {
            expect(size, `${file} is ${size} bytes`).toBeLessThanOrEqual(
                700 * 1024,
            )
        }
    })
})

/**
 * Cold-start budget for the serverless function. The function parses every
 * module on the first request's static import graph before it can answer
 * (~1 s at 27 MB / 750 files; ~0.5 s once trimmed), and Vercel visitors hit
 * a cold instance most of the time.
 */
const FUNCTION_DIR =
    [".output/server", ".vercel/output/functions/__server.func"].find((dir) =>
        existsSync(dir),
    ) ?? ".vercel/output/functions/__server.func"

it.runIf(REQUIRE_BUILD)("finds the function output to budget", () => {
    expect(existsSync(FUNCTION_DIR), "no function output; build first").toBe(
        true,
    )
})

describe.skipIf(!existsSync(FUNCTION_DIR))("server function cold start", () => {
    it("bundles Sentry instead of tracing hundreds of loose files", () => {
        expect(existsSync(join(FUNCTION_DIR, "node_modules/@sentry"))).toBe(
            false,
        )
    })

    it("keeps single-route libraries off the first request's import graph", () => {
        // Everything the SSR service loads before it can answer any page:
        // the Nitro entry and every static import below it. Dynamic
        // `import()` targets (the PDF renderer, the chat stack, the OpenAPI
        // proxy, sharp) are deliberately not followed.
        const roots = [
            "index.mjs",
            "_chunks/ssr-renderer.mjs",
            "_ssr/ssr.mjs",
            ...readdirSync(join(FUNCTION_DIR, "_ssr")).flatMap((file) =>
                /^(?:router|start|source)-/.test(file) ? [`_ssr/${file}`] : [],
            ),
            ...readdirSync(FUNCTION_DIR).filter((file) =>
                /^__root-.*\.mjs$/.test(file),
            ),
        ]
        const eager = new Set<string>()
        const packages = new Set<string>()
        for (let file = roots.pop(); file; file = roots.pop()) {
            if (eager.has(file)) continue
            eager.add(file)
            const source = readFileSync(join(FUNCTION_DIR, file), "utf8")
            // The bundler heads each inlined module with its source path,
            // as `//#region <path>` or (rolldown 1.2.15+) `// <path>`.
            for (const [, region] of source.matchAll(
                /^\/\/(?:#region)? \S*node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)\//gm,
            )) {
                if (region) packages.add(region)
            }
            for (const [, imported] of source.matchAll(
                /^(?:import|export)\s*(?:[\w$\s{},*]*?from\s*)?"([^"]+)";/gm,
            )) {
                if (!imported || imported.startsWith("node:")) continue
                if (imported.startsWith(".")) {
                    if (imported.endsWith(".mjs"))
                        roots.push(
                            resolve("/", dirname(file), imported).slice(1),
                        )
                    continue
                }
                // A bare specifier is a traced external (sharp, a native
                // addon) that Node loads eagerly with this module.
                const [scope, name] = imported.split("/")
                packages.add(
                    scope?.startsWith("@") ? `${scope}/${name}` : (scope ?? ""),
                )
            }
        }
        expect(eager.size).toBeGreaterThan(10)
        expect(packages.has("react-dom")).toBe(true)
        for (const heavy of [
            "@react-pdf/renderer",
            "@react-pdf/layout",
            "pdfkit",
            "fontkit",
            "sharp",
            "fumadocs-openapi",
            "@scalar/json-magic",
            "just-bash",
        ]) {
            expect(
                packages.has(heavy),
                `${heavy} loads on every cold start`,
            ).toBe(false)
        }
    })
})

/**
 * sharp ships glibc and musl builds as optional dependencies, and Nitro's
 * tracer copies every one installed. Vercel's runtime is glibc, so its
 * function drops the musl ones; a node-server output may run on Alpine and
 * must keep them, or image resizing falls back to the original.
 */
const MUSL = /(?:linux-\w+-musl|linuxmusl-\w+)$/
const VERCEL_FUNCTION_DIR = ".vercel/output/functions/__server.func"
const NODE_SERVER_DIR = ".output/server"
const tracedImgPackages = (dir: string) => {
    const img = join(dir, "node_modules/@img")
    return existsSync(img) ? readdirSync(img).map((name) => `@img/${name}`) : []
}

describe("sharp's native builds per preset", () => {
    const traced = () => ({
        sharp: {},
        "@img/sharp-linux-x64": {},
        "@img/sharp-linuxmusl-x64": {},
        "@img/sharp-libvips-linux-arm64": {},
        "@img/sharp-libvips-linuxmusl-arm64": {},
    })

    it("drops the musl builds from a Vercel function", () => {
        const packages = traced()
        traceOptsFor("vercel")?.hooks.tracedPackages(packages)
        expect(Object.keys(packages)).toEqual([
            "sharp",
            "@img/sharp-linux-x64",
            "@img/sharp-libvips-linux-arm64",
        ])
    })

    it("leaves a node-server output's traced packages to Nitro", () => {
        expect(traceOptsFor("node-server")).toBeUndefined()
    })
})

describe.skipIf(!existsSync(VERCEL_FUNCTION_DIR))("Vercel function", () => {
    it("ships sharp without its musl builds", () => {
        const names = tracedImgPackages(VERCEL_FUNCTION_DIR)
        // The host's native build: glibc Linux on Vercel and in CI, the
        // Darwin build for a local build on macOS.
        expect(names).toContain(
            `@img/sharp-${process.platform}-${process.arch}`,
        )
        expect(names.filter((name) => MUSL.test(name))).toEqual([])
    })
})

describe.skipIf(!existsSync(NODE_SERVER_DIR))("node-server output", () => {
    it("ships the host's native build of sharp", () => {
        expect(tracedImgPackages(NODE_SERVER_DIR)).toContain(
            `@img/sharp-${process.platform}-${process.arch}`,
        )
    })

    // Only a Linux install fetches sharp's musl builds; macOS and Windows
    // installs carry none to keep.
    it.skipIf(process.platform !== "linux")(
        "ships every musl build of sharp the build installed",
        () => {
            // sharp's own optional dependencies, as installed for this build,
            // resolved from sharp's real directory (the linker may symlink it).
            const sharpManifest = realpathSync(
                findPackageJSON("sharp", import.meta.url) ?? "",
            )
            const installed = Object.keys(
                z
                    .object({
                        optionalDependencies: z.record(z.string(), z.string()),
                    })
                    .parse(JSON.parse(readFileSync(sharpManifest, "utf8")))
                    .optionalDependencies,
            ).filter((name) => {
                if (!MUSL.test(name)) return false
                try {
                    return Boolean(
                        findPackageJSON(
                            name,
                            pathToFileURL(sharpManifest).href,
                        ),
                    )
                } catch {
                    return false
                }
            })
            expect(installed).toContain(`@img/sharp-linuxmusl-${process.arch}`)
            expect(
                tracedImgPackages(NODE_SERVER_DIR).filter((name) =>
                    MUSL.test(name),
                ),
            ).toEqual(installed.sort())
        },
    )
})
