/**
 * What the browser really downloads: no server-only module and no classic
 * zod in any client chunk, eager, lazy or worker. This is the authoritative
 * check; `client-bundle.test.ts` is a fast source scan that warns earlier
 * but cannot model every compiler transform.
 *
 * Reads the build `bundle-budget.test.ts` reads, plus the module report the
 * build writes beside Vite's cache (`clientModuleReport` in vite-plugins.ts):
 * each chunk's bundled modules, its static imports, and the importer graph
 * above every bundled module. Locally a missing build skips; in CI and on
 * Vercel it fails.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ASSETS_DIR, REQUIRE_BUILD } from "../build-output"
import { SERVER_ONLY_MODULES, SERVER_ONLY_PATTERN } from "./server-only"

const REPORT = resolve(
    import.meta.dirname,
    "../../node_modules/.vite/client-modules.json",
)

const reportSchema = z.object({
    chunks: z.record(
        z.string(),
        z.object({
            modules: z.array(z.string()),
            imports: z.array(z.string()),
            isEntry: z.boolean(),
            worker: z.boolean(),
        }),
    ),
    importers: z.record(z.string(), z.array(z.string())),
})

const ZOD = /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?zod\//
// zod/mini and the core it is built on; everything else under zod/ is the
// classic build (its schemas, locales and the `zod` / `zod/v4` barrels).
const ZOD_MINI =
    /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?zod\/(?:v4\/)?(?:mini|core)\//
const isClassicZod = (module: string) =>
    ZOD.test(module) && !ZOD_MINI.test(module)
// The Ask-AI panel's SDK validates with classic zod. It loads on demand
// (the panel opens on a click), so the exemption holds only outside the
// chunks every page loads.
const AI_SDK =
    /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:ai|@ai-sdk\/[^/]+)\//

it.runIf(REQUIRE_BUILD)("finds the client build and its module report", () => {
    expect(ASSETS_DIR, "no client assets directory; build first").toBeDefined()
    expect(existsSync(REPORT), "no module report; rebuild").toBe(true)
})

describe.skipIf(!ASSETS_DIR || !existsSync(REPORT))("client build", () => {
    // Vitest collects a skipped describe's body too: read nothing then.
    const report = reportSchema.parse(
        ASSETS_DIR && existsSync(REPORT)
            ? JSON.parse(readFileSync(REPORT, "utf8"))
            : { chunks: {}, importers: {} },
    )
    const chunks = Object.entries(report.chunks)
    const bundled = (test: (module: string) => boolean) =>
        chunks.flatMap(([chunk, { modules }]) =>
            modules.filter(test).map((module) => `${chunk}: ${module}`),
        )

    // The client entry and everything it imports statically load on every
    // page; a worker's entry loads only when something starts the worker.
    const eager = new Set<string>()
    const queue = chunks
        .filter(([, { isEntry, worker }]) => isEntry && !worker)
        .map(([chunk]) => chunk)
    for (let chunk = queue.pop(); chunk; chunk = queue.pop()) {
        if (eager.has(chunk)) continue
        eager.add(chunk)
        queue.push(...(report.chunks[chunk]?.imports ?? []))
    }

    it("describes the build on disk", () => {
        // A report from an older build would vouch for chunks that are gone.
        const onDisk = readdirSync(ASSETS_DIR ?? "")
            .filter((file) => file.endsWith(".js"))
            .map((file) => `_margin/assets/${file}`)
            .sort()
        expect(onDisk.length).toBeGreaterThan(0)
        expect(chunks.map(([chunk]) => chunk).sort()).toEqual(onDisk)
        // The entry, the docs route and its components are all accounted for.
        expect(eager.size).toBeGreaterThan(1)
        expect(bundled((module) => module === "src/router.tsx")).toHaveLength(1)
        expect(
            bundled((module) => module === "src/components/mdx.tsx"),
        ).toHaveLength(1)
    })

    it("bundles no server-only module into any client chunk", () => {
        expect(
            bundled(
                (module) =>
                    SERVER_ONLY_MODULES.includes(module) ||
                    SERVER_ONLY_PATTERN.test(module),
            ),
        ).toEqual([])
    })

    it("bundles no classic zod into a chunk every page loads", () => {
        // zod/mini's core is eager: the classifier sees zod at all.
        expect(
            [...eager].some((chunk) =>
                report.chunks[chunk]?.modules.some((module) =>
                    ZOD.test(module),
                ),
            ),
        ).toBe(true)
        expect(
            [...eager].flatMap((chunk) =>
                (report.chunks[chunk]?.modules ?? [])
                    .filter(isClassicZod)
                    .map((module) => `${chunk}: ${module}`),
            ),
        ).toEqual([])
    })

    it("lets only the AI SDK pull classic zod into the browser", () => {
        // Every edge from outside zod into its classic build.
        const entrances = Object.entries(report.importers).flatMap(
            ([module, importers]) =>
                isClassicZod(module)
                    ? importers
                          .filter((importer) => !ZOD.test(importer))
                          .map((importer) => `${importer} → ${module}`)
                    : [],
        )
        // The SDK's own entrances prove the importer graph reaches zod; when
        // the SDK drops classic zod this fails and the exemption goes too.
        expect(entrances.length).toBeGreaterThan(0)
        expect(
            entrances.filter(
                (entrance) => !AI_SDK.test(entrance.split(" → ")[0] ?? ""),
            ),
        ).toEqual([])
    })
})

it("names server-only modules that exist", () => {
    expect(
        SERVER_ONLY_MODULES.filter(
            (module) =>
                !existsSync(resolve(import.meta.dirname, "../..", module)),
        ),
    ).toEqual([])
})
