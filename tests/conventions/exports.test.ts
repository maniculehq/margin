/**
 * Modules a host imports through the package's `exports` compile under the
 * host's tsconfig and bundler, where this package's `@/` alias means nothing
 * (or something else). Every file reachable from a public entry therefore
 * imports its siblings by relative path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")

const exportsMap = z
    .object({ exports: z.record(z.string(), z.string()) })
    .parse(
        JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
    ).exports

const entryFiles = Object.entries(exportsMap).flatMap(([, target]) => {
    if (!/\.tsx?$/.test(target)) return []
    if (!target.includes("*")) return [resolve(root, target)]
    const [prefix = "", suffix = ""] = target.split("*")
    const directory = resolve(root, dirname(prefix))
    return readdirSync(directory)
        .map((name) => resolve(directory, name))
        .filter(
            (path) =>
                path.startsWith(resolve(root, prefix)) && path.endsWith(suffix),
        )
})

const IMPORT_SPECIFIER =
    /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g

const resolveSource = (base: string): string | null => {
    for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
    ])
        if (existsSync(candidate) && statSync(candidate).isFile())
            return candidate
    return null
}

// Walk the import graph, following `@/` too so a file reached only through
// an aliased import is still scanned.
const reachable = new Set<string>()
const aliasImports: string[] = []
const queue = [...entryFiles]
for (let file = queue.pop(); file; file = queue.pop()) {
    if (reachable.has(file)) continue
    reachable.add(file)
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? ""
        let target: string | null = null
        if (specifier.startsWith("@/")) {
            aliasImports.push(`${relative(root, file)}: ${specifier}`)
            target = resolveSource(resolve(root, "src", specifier.slice(2)))
        } else if (specifier.startsWith(".")) {
            target = resolveSource(resolve(dirname(file), specifier))
        }
        if (target) queue.push(target)
    }
}

describe("public exports", () => {
    it("walks the ingest pipeline and the schema from the entries", () => {
        const walked = [...reachable].map((path) => relative(root, path))
        expect(walked).toEqual(
            expect.arrayContaining([
                "src/ingest/persist.ts",
                "src/db/schema/enums.ts",
                "src/types/docs.ts",
            ]),
        )
    })

    it("import nothing through the package's @/ alias", () => {
        expect(aliasImports).toEqual([])
    })
})
