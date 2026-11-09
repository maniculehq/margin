/**
 * `bun run check-deps`: fails when package.json lists a dependency nothing
 * uses. A package counts as used when a tracked source, script, test or
 * config loads it — read from the parsed syntax tree, so a comment or a
 * string that merely names a package never counts:
 *
 * - JS/TS: import declarations and export-from declarations (type-only
 *   too: the package must still be installed), dynamic imports, require
 *   calls, require.resolve, import.meta.resolve and vi.mock with a literal
 *   specifier, `declare module` augmentations, import types, import-equals
 *   declarations and triple-slash `reference types` directives;
 * - stylesheets: `@import`, `@plugin` and `@reference` at-rules, read
 *   from the lightningcss parse (comments and strings are not rules);
 * - tsconfig `compilerOptions.types` entries (tsconfig is JSONC).
 *
 * A specifier may reach into a package's files through a relative
 * `node_modules/` path (asset imports). A package also counts when a package
 * script runs one of its binaries in command position (after `&&`, `||`,
 * `;`, `|`, leading `VAR=value` assignments and `bunx`/`bun x`), never as an
 * argument; and `@types/<x>` when `<x>` is used or is a Node built-in /
 * ambient type set. TOOLING lists the few packages nothing names directly;
 * each entry says why.
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { transform, type UnknownAtRule } from "lightningcss"
import { type ESTree, parseSync, Visitor } from "rolldown/utils"
import { z } from "zod"

const root = resolve(import.meta.dirname, "..")

/** Used without being named as a specifier anywhere in the tree. */
const TOOLING: Record<string, string> = {
    esbuild:
        "anchors unplugin's optional esbuild peer to the version the monorepo resolves (nothing imports it; the out-of-tree CI job compares the two dependency graphs)",
}

const manifest = z
    .object({
        scripts: z.record(z.string(), z.string()).default({}),
        dependencies: z.record(z.string(), z.string()).default({}),
        devDependencies: z.record(z.string(), z.string()).default({}),
    })
    .parse(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")))

const files = execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    encoding: "utf8",
})
    .split("\0")
    .filter(
        (file) =>
            /\.(?:[cm]?[jt]sx?|css)$/.test(file) ||
            /^tsconfig.*\.json$/.test(basename(file)),
    )
    .filter((file) => !file.startsWith("tests/fixtures/"))

/** Every module specifier the tree loads. */
const specifiers = new Set<string>()
for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8")
    if (file.endsWith(".json")) {
        const tsconfig = z
            .object({
                compilerOptions: z
                    .object({ types: z.array(z.string()).default([]) })
                    .default({ types: [] }),
            })
            .parse(Bun.JSONC.parse(source))
        for (const type of tsconfig.compilerOptions.types) specifiers.add(type)
        continue
    }
    if (file.endsWith(".css")) {
        // Tailwind's @plugin/@reference are unknown at-rules to lightningcss;
        // their prelude is the quoted specifier.
        const prelude = (tokens: ReadonlyArray<unknown>) => {
            for (const token of tokens) {
                const parsed = z
                    .object({
                        type: z.literal("token"),
                        value: z.object({
                            type: z.string(),
                            value: z.unknown(),
                        }),
                    })
                    .safeParse(token)
                if (!parsed.success) return
                if (parsed.data.value.type === "white-space") continue
                if (
                    parsed.data.value.type === "string" &&
                    typeof parsed.data.value.value === "string"
                )
                    specifiers.add(parsed.data.value.value)
                return
            }
        }
        transform({
            filename: file,
            code: Buffer.from(source),
            errorRecovery: true,
            visitor: {
                Rule: {
                    // Property form: the isolation scan reads a method named
                    // `import` followed by a parenthesis as a dynamic import.
                    import: (rule) => {
                        specifiers.add(rule.value.url)
                    },
                    unknown: (rule: UnknownAtRule) => {
                        if (rule.name === "plugin" || rule.name === "reference")
                            prelude(rule.prelude)
                    },
                },
            },
        })
        continue
    }
    const { program, comments, errors } = parseSync(file, source)
    if (errors.length > 0)
        throw new Error(
            `check-deps: ${file} does not parse: ${errors.map((error) => error.message).join("; ")}`,
        )
    const literal = (node: ESTree.Node | undefined) => {
        if (node?.type === "Literal" && typeof node.value === "string")
            specifiers.add(node.value)
        else if (
            node?.type === "TemplateLiteral" &&
            node.expressions.length === 0 &&
            typeof node.quasis[0]?.value.cooked === "string"
        )
            specifiers.add(node.quasis[0].value.cooked)
    }
    new Visitor({
        ImportDeclaration(node) {
            specifiers.add(node.source.value)
        },
        ExportNamedDeclaration(node) {
            if (node.source) specifiers.add(node.source.value)
        },
        ExportAllDeclaration(node) {
            specifiers.add(node.source.value)
        },
        ImportExpression(node) {
            literal(node.source)
        },
        TSImportType(node) {
            specifiers.add(node.source.value)
        },
        TSExternalModuleReference(node) {
            specifiers.add(node.expression.value)
        },
        TSModuleDeclaration(node) {
            if (node.id.type === "Literal") specifiers.add(node.id.value)
        },
        CallExpression(node) {
            const [argument] = node.arguments
            if (argument === undefined || argument.type === "SpreadElement")
                return
            const callee = node.callee
            const loads =
                (callee.type === "Identifier" && callee.name === "require") ||
                (callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    ((callee.object.type === "Identifier" &&
                        ((callee.object.name === "require" &&
                            callee.property.name === "resolve") ||
                            (callee.object.name === "vi" &&
                                callee.property.name === "mock"))) ||
                        (callee.object.type === "MetaProperty" &&
                            callee.property.name === "resolve")))
            if (loads) literal(argument)
        },
    }).visit(program)
    // Triple-slash directives are comments by syntax: `/// <reference …>`.
    for (const comment of comments) {
        const match =
            comment.type === "Line"
                ? /^\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/.exec(
                      comment.value,
                  )
                : null
        if (match?.[1]) specifiers.add(match[1])
    }
}

/** The package a specifier loads, or undefined for relative/aliased ones. */
const packageOf = (specifier: string) => {
    const path = specifier.split("?")[0] ?? ""
    const bare = path.startsWith(".")
        ? path.split("node_modules/").slice(1).pop()
        : path
    if (bare === undefined || bare.startsWith("/") || bare.startsWith("@/"))
        return undefined
    const parts = bare.split("/")
    return bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}
const used = new Set(
    [...specifiers].flatMap((specifier) => packageOf(specifier) ?? []),
)

/** The first word of every command the package scripts run. */
const commands = new Set(
    Object.values(manifest.scripts).flatMap((script) =>
        script.split(/&&|\|\||[;|&\n]/).flatMap((segment) => {
            const words = segment.trim().split(/\s+/)
            while (words[0] !== undefined && /^[A-Za-z_]\w*=/.test(words[0]))
                words.shift()
            if (words[0] === "bunx") words.shift()
            else if (words[0] === "bun" && words[1] === "x") words.splice(0, 2)
            while (words[0]?.startsWith("-")) words.shift()
            return words[0] ? [words[0]] : []
        }),
    ),
)
/** Whether a package script runs one of `name`'s binaries. */
const runsBinary = async (name: string) => {
    for (let dir = root; ; dir = dirname(dir)) {
        const path = join(dir, "node_modules", name, "package.json")
        if (existsSync(path)) {
            const { bin } = z
                .object({
                    bin: z
                        .union([z.string(), z.record(z.string(), z.string())])
                        .optional(),
                })
                .parse(JSON.parse(await readFile(path, "utf8")))
            const bins =
                typeof bin === "string"
                    ? [name.split("/").pop() ?? name]
                    : Object.keys(bin ?? {})
            return bins.some((binary) => commands.has(binary))
        }
        if (dirname(dir) === dir) return false
    }
}
const ambientTypes = new Set(["node", "react", "react-dom"])

const listed = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
})
const running = new Set<string>()
for (const name of listed) if (await runsBinary(name)) running.add(name)
const unused = listed
    .filter((name) => {
        if (name in TOOLING || used.has(name) || running.has(name)) return false
        const typed = /^@types\/(.+)$/.exec(name)?.[1]
        if (typed === undefined) return true
        // @types/scope__pkg describes @scope/pkg.
        const described = typed.includes("__")
            ? `@${typed.replace("__", "/")}`
            : typed
        return !(
            ambientTypes.has(described) ||
            builtinModules.includes(described) ||
            used.has(described)
        )
    })
    .sort()

if (unused.length > 0) {
    console.error(
        `check-deps: package.json lists packages nothing uses:\n${unused.map((name) => `  ${name}`).join("\n")}\nRemove them, or add a TOOLING entry saying how they are used.`,
    )
    process.exit(1)
}
console.log("check-deps: every dependency is used")
