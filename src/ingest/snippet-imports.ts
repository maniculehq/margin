/**
 * Expands MD/MDX snippets into the validated AST and inlines compiled JS/JSX
 * snippets into the client-rendered page. No imports reach the MDX compiler,
 * whose sync client evaluator cannot handle its dynamic-import output.
 */

import type { PhrasingContent, Root } from "mdast"
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal"
// Type-only: the workflow step bundle is CommonJS, so a value import of the
// ESM-only rolldown compiles to a CommonJS require call, which Vercel's launcher rejects
// (it runs with --no-experimental-require-module). Load it dynamically.
import type { build } from "rolldown"
import { visit } from "unist-util-visit"
import { z } from "zod"
import type { Diagnostic } from "../types/docs"
import {
    evaluateStaticMdxExpression,
    type StaticMdxValue,
    staticMdxValueToEstree,
} from "../types/docs-hast"
import type { DocsViolation } from "./validate"

const importDeclarationSchema = z.object({
    type: z.literal("ImportDeclaration"),
    source: z.object({ value: z.string() }),
    specifiers: z.array(
        z.object({
            type: z.string(),
            local: z.object({ name: z.string() }),
            imported: z.object({ name: z.string() }).optional(),
        }),
    ),
})

const esmNodeSchema = z.object({
    value: z.string().optional(),
    data: z.object({
        estree: z.object({ body: z.array(z.unknown()) }),
    }),
    position: z
        .object({
            start: z.object({ line: z.number(), offset: z.number() }).partial(),
        })
        .partial()
        .optional(),
})

/**
 * Document-absolute acorn offsets every micromark-mdxjs estree statement
 * carries — used to slice one statement's source out of the node's value.
 */
const statementRangeSchema = z.object({
    start: z.number(),
    end: z.number(),
})

const exportStatementSchema = z.object({
    type: z.enum([
        "ExportNamedDeclaration",
        "ExportDefaultDeclaration",
        "ExportAllDeclaration",
    ]),
})

/** Named-export shapes we can lift binding names from (estree). */
const exportNamedNamesSchema = z.object({
    type: z.literal("ExportNamedDeclaration"),
    declaration: z
        .union([
            z.object({
                type: z.literal("VariableDeclaration"),
                declarations: z.array(
                    z.object({
                        id: z.object({ name: z.string() }).partial(),
                    }),
                ),
            }),
            z.object({
                type: z.enum(["FunctionDeclaration", "ClassDeclaration"]),
                id: z.object({ name: z.string() }),
            }),
        ])
        .nullish(),
    specifiers: z
        .array(
            z.object({
                exported: z.object({ name: z.string() }).partial(),
            }),
        )
        .optional(),
})

/** `export const name = <static literal>, …` — data, not code. */
const staticConstExportSchema = z.object({
    type: z.literal("ExportNamedDeclaration"),
    declaration: z.object({
        type: z.literal("VariableDeclaration"),
        kind: z.literal("const"),
        declarations: z.array(
            z.object({
                id: z.object({
                    type: z.literal("Identifier"),
                    name: z.string(),
                }),
                init: z.unknown(),
            }),
        ),
    }),
})

const identifierSchema = z.object({
    type: z.literal("Identifier"),
    name: z.string(),
})

const memberExpressionSchema = z.object({
    type: z.literal("MemberExpression"),
    computed: z.boolean(),
    object: z.unknown(),
    property: z.unknown(),
})

const literalKeySchema = z.object({
    type: z.literal("Literal"),
    value: z.union([z.string(), z.number()]),
})

/**
 * Resolve snippet props and exported constants at ingest (the passed
 * property replaces the variable in the snippet definition). A whole
 * expression that names a binding (`{region}`, `{plan.name}`, `title={x}`)
 * becomes static text or a static attribute, so the page needs no executable
 * scope for it: the stored HAST, the agent markdown, and the client render all
 * carry the value. Anything else is left for the client render, as before.
 */
export function substituteStaticBindings(input: {
    tree: Root
    bindings: ReadonlyMap<string, StaticMdxValue>
    /** Also interpolate snippet props inside fenced code. */
    interpolateCode?: boolean
}): void {
    if (input.bindings.size === 0) return
    // A value reads like the same text authored inline: an email or URL
    // autolinks (as GFM does for prose), and the agent markdown keeps it
    // verbatim instead of escaping it as `support\@orbit.example`.
    const phrasing = (value: string | number): PhrasingContent[] => {
        const fragment: Root = {
            type: "root",
            children: [
                {
                    type: "paragraph",
                    children: [{ type: "text", value: String(value) }],
                },
            ],
        }
        for (const transform of gfmAutolinkLiteralFromMarkdown().transforms ??
            [])
            transform(fragment)
        const [paragraph] = fragment.children
        return paragraph?.type === "paragraph" ? paragraph.children : []
    }
    const resolve = (
        expression: unknown,
    ): { ok: true; value: StaticMdxValue } | { ok: false } => {
        const identifier = identifierSchema.safeParse(expression)
        if (identifier.success)
            return input.bindings.has(identifier.data.name)
                ? { ok: true, value: input.bindings.get(identifier.data.name) }
                : { ok: false }
        const member = memberExpressionSchema.safeParse(expression)
        if (!member.success) return { ok: false }
        const key = member.data.computed
            ? literalKeySchema.safeParse(member.data.property).data?.value
            : identifierSchema.safeParse(member.data.property).data?.name
        const base = resolve(member.data.object)
        if (
            key === undefined ||
            !base.ok ||
            typeof base.value !== "object" ||
            base.value === null ||
            !Object.hasOwn(base.value, key)
        )
            return { ok: false }
        return {
            ok: true,
            value: Array.isArray(base.value)
                ? key === "length"
                    ? base.value.length
                    : base.value[Number(key)]
                : base.value[String(key)],
        }
    }
    const resolveProgram = (
        program: { body: ReadonlyArray<{ type: string }> } | null | undefined,
    ) => {
        const [statement, ...rest] = program?.body ?? []
        return statement?.type === "ExpressionStatement" &&
            "expression" in statement &&
            rest.length === 0
            ? resolve(statement.expression)
            : { ok: false as const }
    }
    if (input.interpolateCode) {
        visit(input.tree, "code", (node) => {
            node.value = node.value.replaceAll(
                /\{([A-Za-z_$][\w$]*)\}/g,
                (match, name: string) => {
                    const value = input.bindings.get(name)
                    return typeof value === "string" ||
                        typeof value === "number"
                        ? String(value)
                        : match
                },
            )
        })
    }
    visit(input.tree, "mdxTextExpression", (node, index, parent) => {
        if (typeof index !== "number" || !parent) return
        const resolved = resolveProgram(node.data?.estree)
        if (!resolved.ok) return
        const value = resolved.value
        if (typeof value === "string" || typeof value === "number") {
            const children = phrasing(value)
            parent.children.splice(index, 1, ...children)
            return index + children.length
        }
        // null/undefined/booleans render nothing in React; arrays and
        // objects stay with the client render.
        if (typeof value === "object" && value !== null) return
        parent.children.splice(index, 1)
        return index
    })
    visit(input.tree, "mdxFlowExpression", (node, index, parent) => {
        if (typeof index !== "number" || !parent) return
        const resolved = resolveProgram(node.data?.estree)
        if (!resolved.ok) return
        const value = resolved.value
        if (typeof value === "string" || typeof value === "number") {
            parent.children.splice(index, 1, {
                type: "paragraph",
                children: phrasing(value),
            })
            return index + 1
        }
        if (typeof value === "object" && value !== null) return
        parent.children.splice(index, 1)
        return index
    })
    visit(input.tree, (node) => {
        if (
            node.type !== "mdxJsxFlowElement" &&
            node.type !== "mdxJsxTextElement"
        )
            return
        for (const attribute of node.attributes) {
            if (
                attribute.type !== "mdxJsxAttribute" ||
                attribute.value === null ||
                attribute.value === undefined ||
                typeof attribute.value === "string"
            )
                continue
            const resolved = resolveProgram(attribute.value.data?.estree)
            if (!resolved.ok) continue
            if (typeof resolved.value === "string") {
                attribute.value = resolved.value
                continue
            }
            attribute.value = {
                type: "mdxJsxAttributeValueExpression",
                value: JSON.stringify(resolved.value) ?? "undefined",
                data: {
                    estree: {
                        type: "Program",
                        sourceType: "module",
                        body: [
                            {
                                type: "ExpressionStatement",
                                expression: staticMdxValueToEstree(
                                    resolved.value,
                                ),
                            },
                        ],
                    },
                },
            }
        }
    })
}

export interface JsSnippetBinding {
    /** Identifier the page uses, e.g. `GuidesList`. */
    localName: string
    /** Exported name in the snippet module (same as localName unless aliased). */
    importedName: string
    snippetPath: string
}

const ENTRY_ID = "docs-snippet:entry"
const SNIPPET_ID_PREFIX = "docs-snippet:"

/**
 * The bundler rejected with a per-module error list — it ran, and the
 * tenant's source is what failed (syntax, a disallowed import, a missing
 * snippet). Anything else thrown by `build` means the toolchain itself did
 * not run (binding load, WASI init, OOM) and must fail the ingest instead.
 */
const bundleErrorSchema = z.object({
    errors: z
        .array(
            z.object({
                kind: z.string().optional(),
                message: z.string(),
            }),
        )
        .min(1),
})

export class SnippetCompilerUnavailableError extends Error {
    constructor(cause: unknown, rolldownVersion: string) {
        super(
            `snippet compiler unavailable on ${process.platform}/${process.arch} (rolldown ${rolldownVersion}): ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
        )
        this.name = "SnippetCompilerUnavailableError"
    }
}

let compilerAnnounced = false

/** Strip rolldown's ANSI-coloured, multi-line diagnostic down to its headline. */
function headline(message: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
    const plain = message.replaceAll(/\u001b\[[\d;]*m/g, "")
    const first = plain.split("\n").find((line) => line.trim().length > 0) ?? ""
    return first.replace(/^\[[A-Z_]+\]\s*/, "").trim()
}

function normalizeSnippetPath(specifier: string): string {
    const path = specifier.replaceAll("\\", "/").replace(/^\//, "")
    return path.startsWith("snippets/") ? path : `snippets/${path}`
}

/**
 * Module-map key for the component exports extracted from an .mdx snippet
 * (reusable snippets may `export const Counter = () => …`). The
 * suffix can never collide with a real file path.
 */
export function mdxSnippetExportsKey(snippetPath: string): string {
    return `${snippetPath}::exports`
}

/** Lift exports from snippets and pages so both compile through the shared
 * JS-snippet path. Keep imports with their exports; rolldown resolves snippet
 * imports and rejects unsupported modules. */
export function remarkExtractSnippetExports(input: {
    onExports: (source: string) => void
    /**
     * out (page chain only): named-export identifiers, registered as module
     * scope BEFORE the allow-list runs so `<ThemeCard/>` usages aren't
     * unwrapped as component_unknown.
     */
    moduleScopeNames?: Set<string>
    /**
     * out: the lifted export names alone (moduleScopeNames also carries
     * snippet imports) — what a failed module must still bind so its usages
     * render a scoped notice instead of throwing (see failedModuleFallback).
     */
    exportNames?: Set<string>
    /**
     * out: `export const name = <static literal>` values, substituted into
     * the tree at ingest (substituteStaticBindings) so `{name}` usages
     * need no executable scope.
     */
    constants?: Map<string, StaticMdxValue>
    /**
     * Page chain: a page whose export blocks are all static constants
     * lifts no module at all, so it keeps server rendering. Blocks still
     * lift (in source order, constants included) when any block holds
     * code that may reference them.
     */
    deferConstantOnlyBlocks?: boolean
}) {
    return () => (tree: Root) => {
        const liftedBlocks: Array<{ source: string; constantOnly: boolean }> =
            []
        // Names rendered as JSX tags (`<Tag>`): a string constant used as a
        // tag alias needs its runtime binding, so it is never resolved away.
        const tagNames = new Set<string>()
        visit(tree, (node) => {
            if (
                (node.type === "mdxJsxFlowElement" ||
                    node.type === "mdxJsxTextElement") &&
                node.name
            )
                tagNames.add(node.name)
        })
        visit(tree, "mdxjsEsm", (node, index, parent) => {
            const esm = esmNodeSchema.safeParse(node)
            if (!esm.success || typeof index !== "number" || !parent) return
            const hasExport = esm.data.data.estree.body.some(
                (statement) =>
                    exportStatementSchema.safeParse(statement).success,
            )
            if (!hasExport || !esm.data.value) return
            let constantOnly = true
            for (const statement of esm.data.data.estree.body) {
                // Static constant export → its [name, value] pairs; null
                // for code, imports, or a non-static initializer.
                const constant = staticConstExportSchema.safeParse(statement)
                let pairs: Array<[string, StaticMdxValue]> | null =
                    constant.success ? [] : null
                for (const declarator of constant.data?.declaration
                    .declarations ?? []) {
                    const evaluated = evaluateStaticMdxExpression(
                        declarator.init,
                    )
                    if (!evaluated.ok) {
                        pairs = null
                        break
                    }
                    pairs?.push([declarator.id.name, evaluated.value])
                }
                if (!pairs || pairs.some(([name]) => tagNames.has(name))) {
                    constantOnly = false
                }
                for (const [name, value] of pairs ?? [])
                    input.constants?.set(name, value)
            }
            if (input.moduleScopeNames || input.exportNames) {
                const register = (name: string) => {
                    input.moduleScopeNames?.add(name)
                    input.exportNames?.add(name)
                }
                for (const statement of esm.data.data.estree.body) {
                    const named = exportNamedNamesSchema.safeParse(statement)
                    if (!named.success) continue
                    const declaration = named.data.declaration
                    if (declaration?.type === "VariableDeclaration") {
                        for (const entry of declaration.declarations) {
                            if (entry.id.name) register(entry.id.name)
                        }
                    } else if (declaration) {
                        register(declaration.id.name)
                    }
                    for (const specifier of named.data.specifiers ?? []) {
                        if (specifier.exported.name)
                            register(specifier.exported.name)
                    }
                }
            }
            // node.value may still contain imports consumed by an earlier
            // pass. Rebuild from statement offsets and omit snippets; retain
            // other imports for the bundler's normal handling. Fall back if offsets
            // are unavailable.
            const value = esm.data.value
            const nodeOffset = esm.data.position?.start?.offset
            let lifted = value
            if (nodeOffset !== undefined) {
                const kept: string[] = []
                let sliceable = true
                for (const statement of esm.data.data.estree.body) {
                    const range = statementRangeSchema.safeParse(statement)
                    if (!range.success) {
                        sliceable = false
                        break
                    }
                    const decl = importDeclarationSchema.safeParse(statement)
                    if (
                        decl.success &&
                        /^\/?snippets\//i.test(decl.data.source.value)
                    )
                        continue
                    kept.push(
                        value.slice(
                            range.data.start - nodeOffset,
                            range.data.end - nodeOffset,
                        ),
                    )
                }
                if (sliceable) lifted = kept.join("\n")
            }
            if (lifted.trim().length > 0)
                liftedBlocks.push({ source: lifted, constantOnly })
            parent.children.splice(index, 1)
            return index
        })
        if (
            input.deferConstantOnlyBlocks &&
            liftedBlocks.every((block) => block.constantOnly)
        )
            return
        for (const block of liftedBlocks) input.onExports(block.source)
    }
}

/**
 * Remark plugin: consume snippet import statements and transclude MDX snippet
 * usages. Must run BEFORE remarkDocsAllowList — whatever mdxjsEsm content it
 * leaves behind is an unsupported import/export the allow-list rejects.
 */
export function remarkSnippetImports(input: {
    path: string
    snippetTrees: ReadonlyMap<string, Root>
    jsSnippetSources: ReadonlyMap<string, string>
    /** Modules that failed to precompile — imports from them never bind. */
    failedJsSnippets: ReadonlyMap<string, string>
    /** Component-export modules extracted from .mdx snippets. */
    mdxExportModules: ReadonlyMap<string, CompiledJsSnippet>
    /** Static `export const` values per .mdx snippet. */
    mdxSnippetConstants: ReadonlyMap<
        string,
        ReadonlyMap<string, StaticMdxValue>
    >
    violations: DocsViolation[]
    diagnostics: Diagnostic[]
    /** out: component names bound by imports (skip in the allow-list). */
    moduleScopeNames: Set<string>
    /** out: js/jsx imports to inline into the compiled page after compile. */
    jsBindings: JsSnippetBinding[]
}) {
    const mdxBindings = new Map<string, Root>()
    const importedConstants = new Map<string, StaticMdxValue>()
    // Pages whose snippet imports dangle still serve
    // — a warn + dropped usage, never a dark tenant. The unbound component
    // name then unwraps under the allow-list's component_unknown policy.
    const warnMissing = (specifier: string) =>
        input.diagnostics.push({
            code: "snippet_missing",
            severity: "warn",
            message: `Missing snippet file: ${specifier} — its usages were dropped.`,
            path: input.path,
        })
    return () => (tree: Root) => {
        // Names rendered as JSX tags (`<Tag>`): a string constant used as a
        // tag alias needs its runtime binding, so it is never resolved away.
        const tagNames = new Set<string>()
        visit(tree, (node) => {
            if (
                (node.type === "mdxJsxFlowElement" ||
                    node.type === "mdxJsxTextElement") &&
                node.name
            )
                tagNames.add(node.name)
        })
        visit(tree, "mdxjsEsm", (node, index, parent) => {
            const esm = esmNodeSchema.safeParse(node)
            if (!esm.success || typeof index !== "number" || !parent) return
            const line = esm.data.position?.start?.line
            const remaining: unknown[] = []
            for (const statement of esm.data.data.estree.body) {
                const decl = importDeclarationSchema.safeParse(statement)
                if (
                    !decl.success ||
                    !/^\/?snippets\//i.test(decl.data.source.value)
                ) {
                    // Page-local static constants (`export const
                    // defaultRegion = "eu-west"`) resolve here too, before
                    // transclusion, so they can feed snippet props. The
                    // statement itself stays for remarkExtractSnippetExports.
                    const constant =
                        staticConstExportSchema.safeParse(statement)
                    const declarators =
                        constant.data?.declaration.declarations ?? []
                    const evaluated = declarators.map((declarator) => ({
                        name: declarator.id.name,
                        result: evaluateStaticMdxExpression(declarator.init),
                    }))
                    // All-or-nothing, like the export lift: one dynamic
                    // initializer keeps the whole statement on the JS path.
                    if (evaluated.every((entry) => entry.result.ok))
                        for (const { name, result } of evaluated)
                            if (result.ok && !tagNames.has(name))
                                importedConstants.set(name, result.value)
                    remaining.push(statement)
                    continue
                }
                const snippetPath = normalizeSnippetPath(decl.data.source.value)
                if (/\.(mdx|md)$/i.test(snippetPath)) {
                    const snippet = input.snippetTrees.get(snippetPath)
                    const exports = input.mdxExportModules.get(snippetPath)
                    const constants = input.mdxSnippetConstants.get(snippetPath)
                    if (!snippet && !exports) {
                        warnMissing(decl.data.source.value)
                        continue
                    }
                    for (const spec of decl.data.specifiers) {
                        if (spec.type === "ImportDefaultSpecifier") {
                            if (snippet) {
                                mdxBindings.set(spec.local.name, snippet)
                                input.moduleScopeNames.add(spec.local.name)
                            } else {
                                warnMissing(decl.data.source.value)
                            }
                            continue
                        }
                        // Named import — a component the snippet `export`ed
                        // (reusable snippets); compiled through the
                        // js-snippet path and inlined like a .jsx import.
                        const importedName =
                            spec.imported?.name ?? spec.local.name
                        // Exported data (`export const supportEmail =
                        // "…"`) resolves at ingest: no binding, so the page
                        // keeps server rendering and the value reaches the
                        // agent markdown. A constant also rendered as a tag
                        // (`<Tag>` with Tag = "span") resolves its `{Tag}`
                        // values too, and keeps the runtime binding below.
                        if (
                            spec.type === "ImportSpecifier" &&
                            constants?.has(importedName)
                        ) {
                            importedConstants.set(
                                spec.local.name,
                                constants.get(importedName),
                            )
                            if (!tagNames.has(spec.local.name)) continue
                        }
                        if (
                            spec.type === "ImportSpecifier" &&
                            exports?.exportedNames.includes(importedName)
                        ) {
                            input.jsBindings.push({
                                localName: spec.local.name,
                                importedName,
                                snippetPath: mdxSnippetExportsKey(snippetPath),
                            })
                            input.moduleScopeNames.add(spec.local.name)
                            continue
                        }
                        input.diagnostics.push({
                            code: "snippet_missing",
                            severity: "warn",
                            message: `Snippet ${decl.data.source.value} has no export "${importedName}" — its usages were dropped.`,
                            path: input.path,
                        })
                    }
                } else if (/\.(jsx?|tsx?)$/i.test(snippetPath)) {
                    if (!input.jsSnippetSources.has(snippetPath)) {
                        warnMissing(decl.data.source.value)
                        continue
                    }
                    if (input.failedJsSnippets.has(snippetPath)) {
                        // The module-level warn was emitted at precompile;
                        // skipping the binding here lets the usages unwrap
                        // under component_unknown instead of throwing.
                        input.diagnostics.push({
                            code: "js_snippet_rejected",
                            severity: "warn",
                            message: `Snippet module ${decl.data.source.value} failed to compile — its usages on this page were dropped.`,
                            path: input.path,
                        })
                        continue
                    }
                    for (const spec of decl.data.specifiers) {
                        if (spec.type === "ImportNamespaceSpecifier") {
                            input.violations.push({
                                path: input.path,
                                message: `namespace imports from snippets are not supported: ${spec.local.name}`,
                                line,
                            })
                            continue
                        }
                        input.jsBindings.push({
                            localName: spec.local.name,
                            importedName:
                                spec.type === "ImportDefaultSpecifier"
                                    ? "default"
                                    : (spec.imported?.name ?? spec.local.name),
                            snippetPath,
                        })
                        input.moduleScopeNames.add(spec.local.name)
                    }
                } else {
                    warnMissing(decl.data.source.value)
                }
            }
            if (remaining.length === 0) {
                parent.children.splice(index, 1)
                return index
            }
            esm.data.data.estree.body.length = 0
            esm.data.data.estree.body.push(...remaining)
            return undefined
        })
        // Before transclusion, so `<RegionNote region={defaultRegion} />`
        // (imported or page-local) passes the resolved value as a prop.
        substituteStaticBindings({ tree, bindings: importedConstants })
        if (mdxBindings.size === 0) return
        visit(tree, (node, index, parent) => {
            if (
                (node.type !== "mdxJsxFlowElement" &&
                    node.type !== "mdxJsxTextElement") ||
                !node.name ||
                !mdxBindings.has(node.name)
            )
                return
            const snippet = mdxBindings.get(node.name)
            if (
                snippet &&
                typeof index === "number" &&
                parent &&
                "children" in parent &&
                Array.isArray(parent.children)
            ) {
                // Props with static values (`region="eu-west"`, a bare
                // boolean attribute, `count={3}`) replace the snippet's
                // `{region}` variables. Dynamic props are
                // left unresolved.
                const props = new Map<string, StaticMdxValue>()
                for (const attribute of node.attributes) {
                    if (attribute.type !== "mdxJsxAttribute") continue
                    if (
                        attribute.value === null ||
                        attribute.value === undefined
                    ) {
                        props.set(attribute.name, true)
                        continue
                    }
                    if (typeof attribute.value === "string") {
                        props.set(attribute.name, attribute.value)
                        continue
                    }
                    const statement = attribute.value.data?.estree?.body[0]
                    const evaluated =
                        statement?.type === "ExpressionStatement"
                            ? evaluateStaticMdxExpression(statement.expression)
                            : { ok: false as const }
                    if (evaluated.ok) props.set(attribute.name, evaluated.value)
                }
                const transcluded: Root = {
                    type: "root",
                    children: structuredClone(snippet.children),
                }
                substituteStaticBindings({
                    tree: transcluded,
                    bindings: props,
                    interpolateCode: true,
                })
                parent.children.splice(index, 1, ...transcluded.children)
            }
        })
    }
}

export interface CompiledJsSnippet {
    /** Function-body statements defining the module's bindings. */
    body: string
    exportedNames: string[]
}

/**
 * Stand-in module for page-local exports that failed to compile: every
 * lifted name renders a scoped notice, so the prose around a broken
 * component still ships instead of the whole article throwing (the esbuild
 * predecessor prepended `throw` to the page, blanking a whole home page).
 */
export function failedModuleFallback(input: {
    names: Iterable<string>
    message: string
}): CompiledJsSnippet {
    const names = [...new Set(input.names)]
    const notice = `const { jsx } = opts;
const __failedComponent = () => jsx("div", { role: "alert", className: "rounded-lg border bg-fd-muted/50 p-4 text-fd-muted-foreground text-sm", children: ${JSON.stringify(input.message)} });`
    return {
        body: `${notice}\n${names.map((name) => `const ${name} = __failedComponent;`).join("\n")}\nreturn {${names.join(", ")}};`,
        exportedNames: names,
    }
}

/**
 * Compile one js/jsx/ts/tsx snippet module into plain function-body
 * statements. rolldown normalizes the module for us: the automatic JSX runtime
 * arrives as a single `import {...} from "react/jsx-runtime"` line (rewritten
 * to destructure from the mdx-remote scope parameter `opts`) and every export
 * is collapsed into one trailing `export { ... }` list. The regexes below pin
 * that shape; `docs-ingest-js-snippets.test.ts` snapshots it.
 */
export async function compileJsSnippet(input: {
    path: string
    source: string
    /**
     * Resolve /snippets/… imports inside the module (snippets may
     * import each other) — normalized path → source. rolldown bundles the
     * graph; ESM semantics give cycles a defined order rather than a hang.
     */
    resolveSnippet?: (path: string) => string | undefined
    /** Override the loader (mdx-extracted export blocks are JSX source). */
    loader?: "js" | "jsx" | "ts" | "tsx"
    /** Test seam: stand-in for rolldown's `build` (a broken toolchain). */
    bundler?: typeof build
}): Promise<CompiledJsSnippet | { error: string }> {
    let code: string
    const loaderFor = (path: string): "js" | "jsx" | "ts" | "tsx" => {
        // .mdx resolves to the snippet's EXTRACTED export block (see
        // remarkExtractSnippetExports) — raw JSX source, not markdown.
        if (/\.(mdx|md)$/i.test(path)) return "jsx"
        const extension = /\.(jsx|tsx|ts)$/i.exec(path)?.[1]
        return extension === "jsx" || extension === "tsx" || extension === "ts"
            ? extension
            : "js"
    }
    let rolldownVersion = input.bundler ? "stand-in" : "not loaded"
    try {
        let bundle = input.bundler
        if (!bundle) {
            // Inside the try: a failed load is a toolchain failure, not a
            // tenant compile error.
            const rolldown = await import("rolldown")
            rolldownVersion = rolldown.VERSION
            bundle = rolldown.build
            if (!compilerAnnounced) {
                compilerAnnounced = true
                // One line per process so a platform/binding mismatch in the
                // Vercel step function is diagnosable from the runtime logs
                // (the esbuild predecessor failed silently into per-page
                // notices).
                console.log(
                    `[docs-ingest] snippet compiler: rolldown ${rolldownVersion} on ${process.platform}/${process.arch} (node ${process.version})`,
                )
            }
        }
        const result = await bundle({
            input: ENTRY_ID,
            write: false,
            // Left as the one import line the rewrite below consumes.
            external: ["react/jsx-runtime"],
            transform: {
                jsx: { runtime: "automatic", development: false },
                target: "es2022",
            },
            // Every export must survive: the page binds them by name.
            treeshake: false,
            logLevel: "silent",
            output: { format: "esm", minify: false },
            plugins: [
                {
                    name: "docs-snippet-imports",
                    resolveId(id) {
                        if (id === ENTRY_ID) return { id }
                        if (id === "react/jsx-runtime")
                            return { id, external: true }
                        if (/^\/?snippets\//.test(id))
                            return {
                                id: `${SNIPPET_ID_PREFIX}${normalizeSnippetPath(id)}`,
                            }
                        // Anything else (bare specifiers, URLs, relative
                        // paths) has no module registry here — fail the
                        // module, not the tenant.
                        throw new Error(
                            `snippet modules may only import other /snippets/ modules (got "${id}")`,
                        )
                    },
                    load(id) {
                        if (id === ENTRY_ID)
                            return {
                                code: input.source,
                                moduleType:
                                    input.loader ?? loaderFor(input.path),
                            }
                        if (!id.startsWith(SNIPPET_ID_PREFIX)) return null
                        const path = id.slice(SNIPPET_ID_PREFIX.length)
                        const source = input.resolveSnippet?.(path)
                        if (source === undefined)
                            throw new Error(`missing snippet module: ${path}`)
                        return { code: source, moduleType: loaderFor(path) }
                    },
                },
            ],
        })
        code = result.output[0]?.code ?? ""
    } catch (error) {
        const bundleError = bundleErrorSchema.safeParse(error)
        if (!bundleError.success)
            throw new SnippetCompilerUnavailableError(error, rolldownVersion)
        return {
            error: `snippet failed to compile: ${bundleError.data.errors
                .map((entry) => headline(entry.message))
                .join("; ")}`,
        }
    }
    code = code.replace(
        /^import\s*\{([^}]*)\}\s*from\s*"react\/jsx-runtime";?\s*$/m,
        (_line, names: string) => `const {${names}} = opts;`,
    )
    const exportedNames: string[] = []
    code = code.replace(
        /^export\s*\{([^}]*)\};?\s*$/m,
        (_line, names: string) => {
            const entries: string[] = []
            for (const entry of names.split(",")) {
                const [local, exported] = entry.trim().split(/\s+as\s+/)
                if (!local) continue
                const name = exported ?? local
                exportedNames.push(name)
                entries.push(
                    exported ? `${JSON.stringify(name)}: ${local}` : local,
                )
            }
            return `return {${entries.join(", ")}};`
        },
    )
    // Snippet-to-snippet imports were bundled above; anything that still
    // reads as ESM after the jsx-runtime and export rewrites is unsupported.
    if (/^\s*(import|export)[\s{]/m.test(code)) {
        return {
            error: "snippet modules may only import other /snippets/ modules",
        }
    }
    // Snippet JSX uses the built-in components (Card, Columns, …) as ambient
    // globals without importing them — so destructure every
    // capitalized component the transformed code renders (and doesn't define
    // itself) from the page's component map, passed in as `_c`.
    const declared = new Set(
        [
            ...code.matchAll(
                /\b(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g,
            ),
        ].map((match) => match[1]),
    )
    const ambient = [
        ...new Set(
            [...code.matchAll(/\bjsxs?\(\s*([A-Z][\w$]*)/g)].map(
                (match) => match[1],
            ),
        ),
    ].filter(
        (name) =>
            name !== undefined && name !== "Fragment" && !declared.has(name),
    )
    if (ambient.length > 0)
        code = `const { ${ambient.join(", ")} } = _c;\n${code}`
    // React hooks are ambient in snippets (`useState` bare). The
    // framework's executor spreads these into the mdx-remote scope's `opts`;
    // only referenced, undeclared hooks from this fixed list are wired.
    const hooks = [
        "useState",
        "useEffect",
        "useMemo",
        "useCallback",
        "useRef",
        "useReducer",
        "useContext",
        "useId",
        "useTransition",
        "useSyncExternalStore",
    ].filter(
        (hook) =>
            // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `hook` comes from the literal hook-name list above
            new RegExp(`\\b${hook}\\(`).test(code) &&
            // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `hook` comes from the literal hook-name list above
            !new RegExp(`\\b(?:const|let|var|function)\\s+${hook}\\b`).test(
                code,
            ),
    )
    // The React namespace itself is ambient too (`const { useEffect,
    // useState } = React`): a free `React`
    // reference threw ReferenceError at render and blanked the whole
    // article. The executor's opts carries the namespace object.
    if (
        /\bReact\b/.test(code) &&
        !/\b(?:const|let|var|function|class)\s+React\b/.test(code)
    )
        hooks.push("React")
    if (hooks.length > 0)
        code = `const { ${hooks.join(", ")} } = opts;\n${code}`
    return { body: code, exportedNames }
}

/**
 * Inline compiled js snippets into a page's compiled function-body JS. The
 * module bodies are appended as hoisted function declarations (safe after the
 * `return {toc, default: MDXContent}` statement, same trick mdx uses for
 * `_missingMdxReference`), and the bindings are spread into the page's
 * `_components` object so `<GuidesList />` resolves without touching the
 * built-in component map.
 */
export function inlineJsSnippets(input: {
    compiledJs: string
    bindings: JsSnippetBinding[]
    modules: ReadonlyMap<string, CompiledJsSnippet>
}): string | { error: string } {
    // mdx always emits this exact declaration; line-anchored so page content
    // that ECHOES the text (inside a string literal, where a real newline
    // cannot appear) can never match.
    const anchor = /^function _createMdxContent\(props\) \{$/m
    if (!anchor.test(input.compiledJs)) {
        // Import present but no content function — nothing to wire up.
        return input.compiledJs
    }
    const modulePaths = [
        ...new Set(input.bindings.map((b) => b.snippetPath)),
    ].sort()
    const moduleFns = new Map<string, string>()
    const preludes: string[] = []
    for (const [i, path] of modulePaths.entries()) {
        const module = input.modules.get(path)
        if (!module) return { error: `snippet module missing: ${path}` }
        const fnName = `__mdxSnippetModule${i}`
        moduleFns.set(path, fnName)
        preludes.push(`function ${fnName}(_c) {\n${module.body}\n}`)
    }
    const scopeEntries: string[] = []
    for (const binding of input.bindings) {
        const module = input.modules.get(binding.snippetPath)
        const fnName = moduleFns.get(binding.snippetPath)
        if (!module || !fnName)
            return { error: `snippet module missing: ${binding.snippetPath}` }
        if (!module.exportedNames.includes(binding.importedName)) {
            return {
                error: `snippet ${binding.snippetPath} does not export "${binding.importedName}"`,
            }
        }
        scopeEntries.push(
            `${JSON.stringify(binding.localName)}: ${fnName}(_c)[${JSON.stringify(binding.importedName)}]`,
        )
    }
    // Augment props.components before mdx's own destructuring reads it —
    // covers both generated shapes (`props.components || ({})` on
    // component-only pages, `{..., ...props.components}` otherwise). Imported
    // bindings win over provided components, matching module scope in MDX;
    // the map itself is handed to the modules so built-ins stay ambient.
    const patched = input.compiledJs.replace(
        anchor,
        "function _createMdxContent(props) {\n  props = {...props, components: {...(props.components || {}), ...__mdxSnippetScope(props.components || {})}};",
    )
    return `${patched}\nfunction __mdxSnippetScope(_c) {\n  return {${scopeEntries.join(", ")}};\n}\n${preludes.join("\n")}\n`
}
