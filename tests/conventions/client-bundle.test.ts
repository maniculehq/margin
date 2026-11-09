/**
 * Classic zod and the modules built on it stay out of the browser.
 *
 * A single runtime `import { z } from "zod"` — or a runtime import of a
 * module that reaches it, like `@/types/docs` — in code the browser loads
 * ships zod's full runtime: every locale and JSON Schema support, ~70 KB
 * gzip as one shared chunk. Browser code validates with named imports from
 * `zod/mini` and reads the zod-free `@/types/docs-shared`,
 * `@/types/docs-hast` and `@/types/constants` modules instead.
 *
 * This source scan is advisory: a fast early warning that needs no build.
 * The authoritative check is `client-build.test.ts`, which reads what the
 * real client build bundled; the scan cannot model every compiler transform
 * (a boundary file exempts all of its imports, not only those its stripped
 * server code uses). The oxc parser reads every import, re-export, dynamic
 * import and worker, and oxc's resolver resolves them the way the bundler
 * does (tsconfig paths, `.js` → `.ts`, directory index).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { ResolverFactory } from "rolldown/experimental"
import { type ESTree, parseSync, Visitor } from "rolldown/utils"
import { describe, expect, it } from "vitest"
import { SERVER_ONLY_MODULES } from "./server-only"

const root = realpathSync(resolve(import.meta.dirname, "../.."))
const src = join(root, "src")

const resolver = new ResolverFactory({
    tsconfig: { configFile: join(root, "tsconfig.json") },
    conditionNames: ["browser", "import", "default"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".json"],
    // TypeScript's substitution: `./x.js` names `./x.ts` or `./x.tsx`.
    extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".jsx": [".tsx", ".jsx"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
    },
})

/** The package's own source file a specifier loads; null for a dependency,
 *  a builtin, a virtual module or an inert asset import. */
const resolveLocal = (from: string, specifier: string) => {
    const [bare = specifier, query] = specifier.split("?", 2)
    const params = new URLSearchParams(query)
    // `?url`, `?raw` and `?inline` hand over a URL or the file's text and
    // never run it; `?worker` (also `?worker&url`) and `?sharedworker` start
    // it as a browser entry, and any other query still loads the module.
    if (
        !params.has("worker") &&
        !params.has("sharedworker") &&
        ["url", "raw", "inline"].some((name) => params.has(name))
    )
        return null
    const { path } = resolver.resolveFileSync(from, bare)
    if (path === undefined) return null
    const real = realpathSync(path)
    return real.startsWith(`${root}/`) &&
        !real.split("/").includes("node_modules") &&
        /\.[cm]?[jt]sx?$/.test(real)
        ? real
        : null
}

interface Parsed {
    /** Every specifier the module loads at runtime: imports and re-exports
     *  that are not type-only, and the literal arguments of dynamic imports
     *  and require calls. */
    specifiers: string[]
    /** Dynamic import and require arguments that are not a literal. */
    nonLiteral: string[]
    /** Keys of the options object a `createFileRoute(…)({…})` call passes,
     *  or null when the module declares no file route. */
    routeOptions: Set<string> | null
    /** Whether the module calls a factory whose server code the start
     *  compiler strips from the client build. */
    strippedServerCode: boolean
}

// start-plugin-core's start compiler removes `createServerFn` handlers,
// `createMiddleware` `.server()` bodies and `createServerOnlyFn` bodies from
// the client build. `createIsomorphicFn` is left out on purpose: its
// `.client()` branch ships.
const STRIPPING_FACTORIES = new Set([
    "createServerFn",
    "createMiddleware",
    "createServerOnlyFn",
])

const parsed = new Map<string, Parsed>()
const parse = (file: string): Parsed => {
    const cached = parsed.get(file)
    if (cached) return cached
    const source = readFileSync(file, "utf8")
    const { program, errors } = parseSync(file, source)
    if (errors.length > 0)
        throw new Error(`${file}: ${errors.map((e) => e.message).join("; ")}`)
    const result: Parsed = {
        specifiers: [],
        nonLiteral: [],
        routeOptions: null,
        strippedServerCode: false,
    }
    const loaded = (argument: ESTree.Expression | undefined) => {
        if (argument?.type === "Literal" && typeof argument.value === "string")
            result.specifiers.push(argument.value)
        else if (
            argument?.type === "TemplateLiteral" &&
            argument.expressions.length === 0 &&
            typeof argument.quasis[0]?.value.cooked === "string"
        )
            result.specifiers.push(argument.quasis[0].value.cooked)
        else
            result.nonLiteral.push(
                argument ? source.slice(argument.start, argument.end) : "",
            )
    }
    new Visitor({
        ImportDeclaration(node) {
            const typeOnly =
                node.importKind === "type" ||
                (node.specifiers.length > 0 &&
                    node.specifiers.every(
                        (specifier) =>
                            specifier.type === "ImportSpecifier" &&
                            specifier.importKind === "type",
                    ))
            if (!typeOnly) result.specifiers.push(node.source.value)
        },
        ExportNamedDeclaration(node) {
            if (
                node.source &&
                node.exportKind !== "type" &&
                !(
                    node.specifiers.length > 0 &&
                    node.specifiers.every(
                        (specifier) => specifier.exportKind === "type",
                    )
                )
            )
                result.specifiers.push(node.source.value)
        },
        ExportAllDeclaration(node) {
            if (node.exportKind !== "type")
                result.specifiers.push(node.source.value)
        },
        ImportExpression(node) {
            loaded(node.source)
        },
        // Vite's other worker syntax, a Worker (or SharedWorker) built from
        // a URL relative to the module: the URL's file runs in the browser.
        NewExpression(node) {
            const [url] = node.arguments
            if (
                node.callee.type === "Identifier" &&
                ["Worker", "SharedWorker"].includes(node.callee.name) &&
                url?.type === "NewExpression" &&
                url.callee.type === "Identifier" &&
                url.callee.name === "URL"
            ) {
                const [path] = url.arguments
                loaded(path?.type === "SpreadElement" ? undefined : path)
            }
        },
        CallExpression(node) {
            const [argument] = node.arguments
            if (
                node.callee.type === "Identifier" &&
                STRIPPING_FACTORIES.has(node.callee.name)
            )
                result.strippedServerCode = true
            if (
                node.callee.type === "Identifier" &&
                node.callee.name === "require"
            )
                loaded(
                    argument?.type === "SpreadElement" ? undefined : argument,
                )
            // createFileRoute("/path")({ …options })
            if (
                node.callee.type === "CallExpression" &&
                node.callee.callee.type === "Identifier" &&
                node.callee.callee.name === "createFileRoute" &&
                argument?.type === "ObjectExpression"
            )
                result.routeOptions = new Set(
                    argument.properties.map((property) =>
                        property.type === "Property" &&
                        property.key.type === "Identifier" &&
                        !property.computed
                            ? property.key.name
                            : "…",
                    ),
                )
        },
    }).visit(program)
    parsed.set(file, result)
    return result
}

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sourceFiles(path)
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })

/** Classic zod: the package root and every subpath but the mini and core
 *  builds. */
const isClassicZod = (specifier: string) =>
    specifier === "zod" ||
    (specifier.startsWith("zod/") &&
        !/^zod\/(?:v4\/)?(?:mini|core)(?:\/|$)|^zod\/v4-mini$/.test(specifier))

const typesRoot = join(src, "types")
const typesModules = sourceFiles(typesRoot)

/** The `src/types` modules that reach classic zod at runtime, directly or
 *  through another types module. Shared types are what browser and server
 *  code both import, so a schema there is the easiest one to pull into the
 *  browser by accident; every other module the walk below reads itself. */
const schemaModules = new Set<string>()
for (let grew = true; grew; ) {
    grew = false
    for (const file of typesModules) {
        if (schemaModules.has(file)) continue
        if (
            parse(file).specifiers.some((specifier) => {
                if (isClassicZod(specifier)) return true
                const local = resolveLocal(file, specifier)
                return local !== null && schemaModules.has(local)
            })
        ) {
            schemaModules.add(file)
            grew = true
        }
    }
}

/** Modules the browser never loads although browser modules import them:
 *  only the server code of a compiler boundary (below) uses them. */
const serverOnlyModules = new Set(
    SERVER_ONLY_MODULES.map((file) => join(root, file)),
)

/**
 * A compiler boundary is a module whose server code TanStack Start strips
 * from the client build, taking the imports only that code uses with it: a
 * call to a stripping factory (above), or a route whose `server`, `ssr` or
 * `headers` option the client code splitter deletes (start-router-plugin's
 * `deleteNodes`). Only a boundary may import a server-only module; a plain
 * module that does ships it to the browser.
 */
const isBoundary = (file: string) =>
    parse(file).strippedServerCode ||
    [...(parse(file).routeOptions ?? [])].some((option) =>
        ["server", "ssr", "headers"].includes(option),
    )

// The generated route tree: each route's parent, for the subtree pruning
// below. `const XRoute = XRouteImport.update({ getParentRoute: () => Y })`.
const routeTree = join(src, "routeTree.gen.ts")
const routeImports = new Map<string, string>()
const routeConsts = new Map<string, { file: string; parent: string }>()
{
    const source = readFileSync(routeTree, "utf8")
    new Visitor({
        ImportDeclaration(node) {
            const local = resolveLocal(routeTree, node.source.value)
            for (const specifier of node.specifiers)
                if (local !== null)
                    routeImports.set(specifier.local.name, local)
        },
        VariableDeclarator(node) {
            const call = node.init
            if (
                node.id.type !== "Identifier" ||
                call?.type !== "CallExpression" ||
                call.callee.type !== "MemberExpression" ||
                call.callee.object.type !== "Identifier" ||
                call.arguments[0]?.type !== "ObjectExpression"
            )
                return
            const file = routeImports.get(call.callee.object.name)
            const parent = call.arguments[0].properties.flatMap((property) =>
                property.type === "Property" &&
                property.key.type === "Identifier" &&
                property.key.name === "getParentRoute" &&
                property.value.type === "ArrowFunctionExpression" &&
                property.value.body.type === "Identifier"
                    ? [property.value.body.name]
                    : [],
            )[0]
            if (file !== undefined && parent !== undefined)
                routeConsts.set(node.id.name, { file, parent })
        },
    }).visit(parseSync(routeTree, source).program)
}
const parentFile = (name: string) =>
    routeImports.get(name) ?? routeConsts.get(name)?.file
const children = new Map<string, string[]>()
for (const { file, parent } of routeConsts.values()) {
    const parentPath = parentFile(parent)
    if (parentPath !== undefined)
        children.set(parentPath, [...(children.get(parentPath) ?? []), file])
}

/** start-plugin-core's pruneServerOnlySubtrees: a route whose only option is
 *  `server`, with only such routes below it, leaves the client route tree. */
const isServerOnlyRoute = (file: string): boolean => {
    const options = parse(file).routeOptions
    return (
        options !== null &&
        options.size === 1 &&
        options.has("server") &&
        (children.get(file) ?? []).every(isServerOnlyRoute)
    )
}

// TanStack Start has no "use client": the router (and through
// routeTree.gen.ts every route), the start instance and every component are
// browser code unless the compiler strips it.
const entries = [
    join(src, "router.tsx"),
    join(src, "start.ts"),
    ...sourceFiles(join(src, "components")),
    ...sourceFiles(join(src, "hooks")),
]

// Every module the browser can load from `entries`, walking the package's own
// imports. Records each classic-zod or schema-module import, each server-only
// import from a module that is not a compiler boundary, and each load the
// scan cannot follow.
const offenders: string[] = []
const reached = new Set<string>()
const queue = [...entries]
for (let file = queue.pop(); file; file = queue.pop()) {
    if (reached.has(file)) continue
    reached.add(file)
    if (serverOnlyModules.has(file) || isServerOnlyRoute(file)) continue
    const { specifiers, nonLiteral } = parse(file)
    const name = relative(root, file)
    for (const expression of nonLiteral)
        offenders.push(`${name} → non-literal load ${expression}`)
    for (const specifier of specifiers) {
        const local = resolveLocal(file, specifier)
        if (isClassicZod(specifier) || (local && schemaModules.has(local)))
            offenders.push(`${name} → ${specifier}`)
        else if (local && serverOnlyModules.has(local) && !isBoundary(file))
            offenders.push(`${name} → ${specifier} (server-only)`)
        else if (local) queue.push(local)
    }
}

describe("client bundle conventions", () => {
    it("recognises the schema modules it guards against", () => {
        const schemas = [...schemaModules].map((file) => relative(src, file))
        expect(schemas).toContain("types/docs.ts")
        expect(schemas).not.toContain("types/docs-shared.ts")
        expect(schemas).not.toContain("types/docs-hast.ts")
        expect(schemas).not.toContain("types/constants.ts")
    })

    it("walks the route tree into the modules routes import", () => {
        // Reached only through routeTree.gen.ts and the routes' imports.
        expect(reached).toContain(join(src, "routes/$.tsx"))
        expect(reached).toContain(join(src, "lib/shared.ts"))
        expect(reached).toContain(join(src, "types/docs-shared.ts"))
    })

    it("prunes only server-handler-only routes", () => {
        const routes = sourceFiles(join(src, "routes"))
        const pruned = routes.filter(isServerOnlyRoute)
        expect(pruned).toContain(join(src, "routes/api/search.ts"))
        expect(pruned).not.toContain(join(src, "routes/$.tsx"))
        expect(pruned.length).toBeLessThan(routes.length)
    })

    it("lists only server-only modules browser code imports", () => {
        expect(
            [...serverOnlyModules]
                .filter((file) => !reached.has(file))
                .map((file) => relative(root, file)),
        ).toEqual([])
    })

    it("never reaches classic zod, a schema module or a server-only module from browser code", () => {
        expect(offenders).toEqual([])
    })
})
