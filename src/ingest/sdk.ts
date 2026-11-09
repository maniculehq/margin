import { z } from "zod"
import {
    type Diagnostic,
    type Navigation,
    navigationSchema,
} from "../types/docs"

/**
 * Reads validated TypeDoc JSON from the docs snapshot and generates ordinary
 * Markdown pages; it never runs a tenant-supplied generator. Those pages join
 * the snapshot before `compile.ts` and use the standard MDX pipeline. Other
 * SDK formats and remote sources are reported unsupported.
 */

export const MAX_SDK_ARTIFACT_BYTES = 30 * 1024 * 1024
export const MAX_SDK_PAGES_PER_NODE = 500

/** The docs.json sdk formats (nav node `sdk.format`). */
export const DOCS_SDK_FORMATS = [
    "typedoc",
    "docfx",
    "javadoc",
    "sphinx",
    "phpdoc",
] as const

/**
 * docs.json nav-node sdk ref: format + source required, no extra fields
 * (strict — the docs.json schema sets additionalProperties: false).
 */
export const docsSdkNavRefSchema = z
    .object({
        format: z.enum(DOCS_SDK_FORMATS),
        /** Path of the generated artifact inside the docs repo (or an https URL — deferred). */
        source: z.string().min(1).max(500),
        /** URL folder the generated pages live under; defaults to a slug of the node title. */
        directory: z.string().min(1).max(255).optional(),
    })
    .strict()

// ── Normalized symbol model ──────────────────────────────────────────────
// One format-agnostic shape every adapter (typedoc today) extracts into; the
// markdown renderer below consumes only this model. Types are TEXT — the
// adapter stringifies its native type trees into readable expressions.

export const SDK_SYMBOL_KINDS = [
    "module",
    "namespace",
    "class",
    "interface",
    "enum",
    "function",
    "type-alias",
    "variable",
] as const

export const SDK_MEMBER_KINDS = [
    "constructor",
    "property",
    "method",
    "accessor",
    "enum-member",
] as const

export const sdkParameterSchema = z.object({
    name: z.string(),
    type: z.string(),
    optional: z.boolean(),
    rest: z.boolean(),
    defaultValue: z.string().nullable(),
    description: z.string().nullable(),
})

export const sdkSignatureSchema = z.object({
    /** Full rendered signature, e.g. `listAudits(cursor?: string): Promise<Page>`. */
    text: z.string(),
    parameters: z.array(sdkParameterSchema),
    returnType: z.string(),
    description: z.string().nullable(),
})

export const sdkMemberSchema = z.object({
    name: z.string(),
    kind: z.enum(SDK_MEMBER_KINDS),
    /** Property/accessor/enum-member value type; null for methods. */
    type: z.string().nullable(),
    /** Method/constructor call signatures (overloads in order). */
    signatures: z.array(sdkSignatureSchema),
    description: z.string().nullable(),
    deprecated: z.boolean(),
    deprecationNote: z.string().nullable(),
    visibility: z.enum(["public", "protected", "private"]),
    static: z.boolean(),
    readonly: z.boolean(),
    optional: z.boolean(),
    defaultValue: z.string().nullable(),
})

export const sdkSymbolSchema = z.object({
    /** Namespace-qualified export name ("utils.Helper"). */
    name: z.string(),
    kind: z.enum(SDK_SYMBOL_KINDS),
    description: z.string().nullable(),
    deprecated: z.boolean(),
    deprecationNote: z.string().nullable(),
    /** Call signatures — functions (overloads in order). */
    signatures: z.array(sdkSignatureSchema),
    /** Declaration-level generics body ("T extends Transport"). */
    typeParameters: z.string().nullable(),
    /** Aliased type text (type aliases) or value type (variables). */
    type: z.string().nullable(),
    /** Variable initializer text, verbatim from the artifact. */
    defaultValue: z.string().nullable(),
    members: z.array(sdkMemberSchema),
    source: z
        .object({ file: z.string(), line: z.number().nullable() })
        .nullable(),
})

export type SdkParameter = z.infer<typeof sdkParameterSchema>
export type SdkSignature = z.infer<typeof sdkSignatureSchema>
export type SdkMember = z.infer<typeof sdkMemberSchema>
export type SdkSymbol = z.infer<typeof sdkSymbolSchema>

// ── Typedoc JSON artifact schemas ────────────────────────────────────────
// Deliberately loose: every field optional, unknown shapes tolerated. The
// extractor degrades (name or "unknown"), never throws — a tenant artifact
// from any typedoc version must not be able to reject a snapshot.

/** typedoc ReflectionKind values (stable across 0.23–0.28). */
const TYPEDOC_KIND = {
    project: 1,
    module: 2,
    namespace: 4,
    enum: 8,
    enumMember: 16,
    variable: 32,
    function: 64,
    class: 128,
    interface: 256,
    constructor: 512,
    callSignature: 4096,
    property: 1024,
    method: 2048,
    accessor: 262144,
    typeAlias: 2097152,
} as const

interface TypedocFlags {
    isOptional?: boolean | undefined
    isStatic?: boolean | undefined
    isReadonly?: boolean | undefined
    isPrivate?: boolean | undefined
    isProtected?: boolean | undefined
    isRest?: boolean | undefined
}

const typedocFlagsSchema: z.ZodType<TypedocFlags> = z
    .object({
        isOptional: z.boolean().optional().catch(undefined),
        isStatic: z.boolean().optional().catch(undefined),
        isReadonly: z.boolean().optional().catch(undefined),
        isPrivate: z.boolean().optional().catch(undefined),
        isProtected: z.boolean().optional().catch(undefined),
        isRest: z.boolean().optional().catch(undefined),
    })
    .loose()

interface TypedocNode {
    name?: string | undefined
    kind?: number | undefined
    flags?: TypedocFlags | undefined
    comment?: unknown
    children?: TypedocNode[] | undefined
    signatures?: TypedocNode[] | undefined
    getSignature?: TypedocNode | undefined
    setSignature?: TypedocNode | undefined
    parameters?: TypedocNode[] | undefined
    typeParameters?: TypedocNode[] | undefined
    indexSignatures?: TypedocNode[] | undefined
    type?: unknown
    /** typeParameter default type rides the `default` key. */
    default?: unknown
    defaultValue?: string | undefined
    sources?:
        | Array<{ fileName?: string | undefined; line?: number | undefined }>
        | undefined
}

const typedocNodeSchema: z.ZodType<TypedocNode> = z.lazy(() =>
    z
        .object({
            name: z.string().optional().catch(undefined),
            kind: z.number().optional().catch(undefined),
            flags: typedocFlagsSchema.optional().catch(undefined),
            comment: z.unknown().optional(),
            children: z.array(typedocNodeSchema).optional().catch(undefined),
            signatures: z.array(typedocNodeSchema).optional().catch(undefined),
            getSignature: typedocNodeSchema.optional().catch(undefined),
            setSignature: typedocNodeSchema.optional().catch(undefined),
            parameters: z.array(typedocNodeSchema).optional().catch(undefined),
            indexSignatures: z
                .array(typedocNodeSchema)
                .optional()
                .catch(undefined),
            typeParameters: z
                .array(typedocNodeSchema)
                .optional()
                .catch(undefined),
            type: z.unknown().optional(),
            default: z.unknown().optional(),
            defaultValue: z.string().optional().catch(undefined),
            sources: z
                .array(
                    z
                        .object({
                            fileName: z.string().optional().catch(undefined),
                            line: z.number().optional().catch(undefined),
                        })
                        .loose(),
                )
                .optional()
                .catch(undefined),
        })
        .loose(),
)

const commentDisplayPartSchema = z
    .object({
        kind: z.string().optional().catch(undefined),
        text: z.string().optional().catch(undefined),
    })
    .loose()

const typedocCommentSchema = z
    .object({
        summary: z.array(commentDisplayPartSchema).optional().catch(undefined),
        blockTags: z
            .array(
                z
                    .object({
                        tag: z.string().optional().catch(undefined),
                        content: z
                            .array(commentDisplayPartSchema)
                            .optional()
                            .catch(undefined),
                    })
                    .loose(),
            )
            .optional()
            .catch(undefined),
        modifierTags: z.array(z.string()).optional().catch(undefined),
    })
    .loose()

/**
 * Escape the two MDX-hazardous characters in prose emitted from tenant
 * comments — `<` opens JSX and `{` opens an expression, and either would
 * fail the generated page's MDX compile (a snapshot-fatal violation).
 * Typedoc already splits inline code into separate "code" display parts, so
 * text parts are pure prose and can be escaped wholesale; `\<`/`\{` render
 * back to the literal characters in both MD and MDX.
 */
function escapeMdxProse(text: string): string {
    return (
        text
            .replaceAll("<", "\\<")
            .replaceAll("{", "\\{")
            // A block-initial line starting with import/export is an MDX ESM
            // trigger and fails the compile before the allow-list can strip
            // it — encode the first letter as a character reference (renders
            // identically, no longer keyword-initial).
            .replace(
                /(^|\n[ \t]*\n)(import|export)(?=\s)/g,
                (_match, boundary: string, word: string) =>
                    `${boundary}&#${word.charCodeAt(0)};${word.slice(1)}`,
            )
    )
}

/**
 * Inline-code span whose delimiter outruns every backtick run in the content
 * (CommonMark: a span may contain shorter runs) — string-literal types and
 * initializers can carry backticks, and a broken span would leak the rest of
 * the line into live MDX.
 */
function inlineCode(text: string): string {
    const longestRun = Math.max(
        0,
        ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
    )
    if (longestRun === 0) return `\`${text}\``
    const marker = "`".repeat(longestRun + 1)
    return `${marker} ${text} ${marker}`
}

/**
 * ts code fence sized past every backtick run inside the code — a template-
 * literal default value containing ``` would otherwise terminate a fixed
 * three-backtick fence early and feed the tail to the MDX compiler.
 */
function tsFence(code: string): string {
    const longestRun = Math.max(
        2,
        ...[...code.matchAll(/`+/g)].map((match) => match[0].length),
    )
    const marker = "`".repeat(longestRun + 1)
    return `${marker}ts\n${code}\n${marker}`
}

/**
 * Render a typedoc comment into MDX-safe markdown text plus deprecation
 * facts. Summary text/code parts concatenate ({@link X} inline-tags become
 * inline code of their text); an @remarks block appends as a second
 * paragraph; @deprecated (modifier or block tag) sets the flag with the
 * tag's content as the note.
 */
function renderTypedocComment(comment: unknown): {
    description: string | null
    deprecated: boolean
    deprecationNote: string | null
} {
    const parsed = typedocCommentSchema.safeParse(comment)
    if (!parsed.success || comment === undefined || comment === null) {
        return { description: null, deprecated: false, deprecationNote: null }
    }
    const renderParts = (
        parts: Array<z.infer<typeof commentDisplayPartSchema>> | undefined,
    ): string =>
        (parts ?? [])
            .map((part) => {
                const text = part.text ?? ""
                // typedoc code parts arrive backtick-wrapped (span or fence)
                // — safe verbatim ONLY when no interior run reaches the
                // delimiter length (CommonMark closes at the FIRST matching
                // run, so "`safe` {value} `" would leak {value} as live
                // MDX). Anything else re-wraps with a correctly-sized span.
                if (part.kind === "code") {
                    const wrapped = /^(`+)([\s\S]*)\1$/.exec(text)
                    const delimiter = wrapped?.[1]
                    const inner = wrapped?.[2] ?? ""
                    const safe =
                        delimiter !== undefined &&
                        ![...inner.matchAll(/`+/g)].some(
                            (run) => run[0].length >= delimiter.length,
                        )
                    return safe
                        ? text
                        : inlineCode(text.replace(/^`+|`+$/g, ""))
                }
                if (part.kind === "inline-tag")
                    return text ? inlineCode(text) : ""
                return escapeMdxProse(text)
            })
            .join("")
            .trim()
    const summary = renderParts(parsed.data.summary)
    const remarks = renderParts(
        parsed.data.blockTags?.find((tag) => tag.tag === "@remarks")?.content,
    )
    const description = [summary, remarks].filter(Boolean).join("\n\n") || null
    const deprecatedTag = parsed.data.blockTags?.find(
        (tag) => tag.tag === "@deprecated",
    )
    const deprecated =
        deprecatedTag !== undefined ||
        (parsed.data.modifierTags ?? []).includes("@deprecated")
    const deprecationNote = deprecatedTag
        ? renderParts(deprecatedTag.content) || null
        : null
    return { description, deprecated, deprecationNote }
}

// ── Typedoc type → text ──────────────────────────────────────────────────

const MAX_TYPE_DEPTH = 16

/**
 * Stringify a typedoc type object into a readable TypeScript-ish type
 * expression. Coverage is deliberately partial (the common shapes); every
 * unknown or malformed node degrades to its `name` or "unknown", never
 * throws — full fidelity is a non-goal.
 */
export function typedocTypeToString(node: unknown, depth = 0): string {
    if (depth > MAX_TYPE_DEPTH) return "unknown"
    const base = z
        .object({
            type: z.string().optional().catch(undefined),
            name: z.string().optional().catch(undefined),
        })
        .loose()
        .safeParse(node)
    if (!base.success || node === null || node === undefined) return "unknown"
    const fallback = base.data.name ?? "unknown"
    const record = z.record(z.string(), z.unknown()).safeParse(node)
    if (!record.success) return fallback
    const fields = record.data
    const inner = (value: unknown): string =>
        typedocTypeToString(value, depth + 1)
    /** Parenthesize compound operands inside tighter constructs (T[] etc.). */
    const grouped = (text: string): string =>
        /[|&]|=>/.test(text) ? `(${text})` : text
    const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(inner) : []

    switch (base.data.type) {
        case "intrinsic":
            return fallback
        case "reference": {
            const typeArguments = Array.isArray(fields.typeArguments)
                ? fields.typeArguments.map(inner)
                : []
            return typeArguments.length > 0
                ? `${fallback}<${typeArguments.join(", ")}>`
                : fallback
        }
        case "union":
            return list(fields.types).join(" | ") || "unknown"
        case "intersection":
            return list(fields.types).join(" & ") || "unknown"
        case "array":
            return `${grouped(inner(fields.elementType))}[]`
        case "tuple":
            return `[${list(fields.elements).join(", ")}]`
        case "namedTupleMember": {
            const optional = fields.isOptional === true ? "?" : ""
            return `${fallback}${optional}: ${inner(fields.element)}`
        }
        case "optional":
            return `${inner(fields.elementType)}?`
        case "rest":
            return `...${inner(fields.elementType)}`
        case "literal": {
            const value = fields.value
            if (typeof value === "string") return JSON.stringify(value)
            if (typeof value === "number" || typeof value === "boolean")
                return String(value)
            if (value === null) return "null"
            // BigInt literals serialize as {value: string, negative: boolean}.
            const bigint = z
                .object({
                    value: z.string(),
                    negative: z.boolean().optional(),
                })
                .loose()
                .safeParse(value)
            if (bigint.success)
                return `${bigint.data.negative ? "-" : ""}${bigint.data.value}n`
            return "unknown"
        }
        case "reflection": {
            const declaration = typedocNodeSchema.safeParse(fields.declaration)
            if (!declaration.success) return "object"
            const signature = declaration.data.signatures?.[0]
            if (signature && !declaration.data.children?.length) {
                const parameters = (signature.parameters ?? [])
                    .map((parameter) => {
                        const optional =
                            parameter.flags?.isOptional === true ? "?" : ""
                        const rest =
                            parameter.flags?.isRest === true ? "..." : ""
                        return `${rest}${parameter.name ?? "arg"}${optional}: ${inner(parameter.type)}`
                    })
                    .join(", ")
                return `(${parameters}) => ${inner(signature.type)}`
            }
            const children = declaration.data.children ?? []
            if (children.length > 0) {
                const entries = children.map((child) => {
                    const optional = child.flags?.isOptional === true ? "?" : ""
                    return `${child.name ?? "unknown"}${optional}: ${inner(child.type)}`
                })
                return `{ ${entries.join("; ")} }`
            }
            return "object"
        }
        case "typeOperator": {
            const operator =
                typeof fields.operator === "string" ? fields.operator : "keyof"
            return `${operator} ${inner(fields.target)}`
        }
        case "query":
            return `typeof ${inner(fields.queryType)}`
        case "indexedAccess":
            return `${grouped(inner(fields.objectType))}[${inner(fields.indexType)}]`
        case "predicate": {
            const target =
                fields.targetType === undefined
                    ? null
                    : inner(fields.targetType)
            return target
                ? `${fields.asserts === true ? "asserts " : ""}${fallback} is ${target}`
                : `asserts ${fallback}`
        }
        case "inferred":
            return `infer ${fallback}`
        case "templateLiteral": {
            const head = typeof fields.head === "string" ? fields.head : ""
            const tail = Array.isArray(fields.tail)
                ? fields.tail
                      .map((pair) => {
                          if (!Array.isArray(pair)) return ""
                          const text =
                              typeof pair[1] === "string" ? pair[1] : ""
                          return `\${${inner(pair[0])}}${text}`
                      })
                      .join("")
                : ""
            return `\`${head}${tail}\``
        }
        // Conditional (and anything else unrecognized) falls through to the
        // degraded default — the name when present, otherwise "unknown".
        default:
            return fallback
    }
}

// ── Typedoc extraction into the normalized model ─────────────────────────

function extractParameters(signature: TypedocNode): SdkParameter[] {
    return (signature.parameters ?? []).map((parameter) => {
        const comment = renderTypedocComment(parameter.comment)
        return {
            name: parameter.name ?? "arg",
            type: typedocTypeToString(parameter.type),
            optional: parameter.flags?.isOptional === true,
            rest: parameter.flags?.isRest === true,
            defaultValue: parameter.defaultValue ?? null,
            description: comment.description,
        }
    })
}

function signatureText(
    signature: TypedocNode,
    displayName: string,
    prefix: string,
): string {
    const typeParameters = typeParametersText(signature.typeParameters)
    const parameters = extractParameters(signature)
        .map((parameter) => {
            const rest = parameter.rest ? "..." : ""
            const optional =
                parameter.optional && parameter.defaultValue === null ? "?" : ""
            const defaulted =
                parameter.defaultValue === null
                    ? ""
                    : ` = ${parameter.defaultValue}`
            return `${rest}${parameter.name}${optional}: ${parameter.type}${defaulted}`
        })
        .join(", ")
    const generics = typeParameters ? `<${typeParameters}>` : ""
    return `${prefix}${displayName}${generics}(${parameters}): ${typedocTypeToString(signature.type)}`
}

/** "<T extends X = Y>" body — shared by signatures and declarations. */
function typeParametersText(nodes: TypedocNode[] | undefined): string {
    return (nodes ?? [])
        .map((typeParameter) => {
            const constraint =
                typeParameter.type === undefined
                    ? ""
                    : ` extends ${typedocTypeToString(typeParameter.type)}`
            const defaulted =
                typeParameter.default === undefined
                    ? ""
                    : ` = ${typedocTypeToString(typeParameter.default)}`
            return `${typeParameter.name ?? "T"}${constraint}${defaulted}`
        })
        .join(", ")
}

function extractSignatures(
    node: TypedocNode,
    displayName: string,
    prefix: string,
): SdkSignature[] {
    return (node.signatures ?? []).map((signature) => {
        const comment = renderTypedocComment(signature.comment)
        return {
            text: signatureText(signature, displayName, prefix),
            parameters: extractParameters(signature),
            returnType: typedocTypeToString(signature.type),
            description: comment.description,
        }
    })
}

function extractMembers(node: TypedocNode, symbolName: string): SdkMember[] {
    const members: SdkMember[] = []
    // Index signatures live in their own array, not children — a
    // Dictionary's defining member must not vanish from the page.
    for (const signature of node.indexSignatures ?? []) {
        const key = signature.parameters?.[0]
        const comment = renderTypedocComment(signature.comment)
        members.push({
            name: `[${key?.name ?? "key"}: ${typedocTypeToString(key?.type)}]`,
            kind: "property",
            type: typedocTypeToString(signature.type),
            signatures: [],
            description: comment.description,
            deprecated: comment.deprecated,
            deprecationNote: comment.deprecationNote,
            visibility: "public",
            static: false,
            readonly: signature.flags?.isReadonly === true,
            optional: false,
            defaultValue: null,
        })
    }
    for (const child of node.children ?? []) {
        const name = child.name ?? "unknown"
        const flags = child.flags ?? {}
        const comment = renderTypedocComment(child.comment)
        // @deprecated commonly annotates the call SIGNATURE, not the
        // declaration — promote it so a deprecated method never presents
        // as current.
        const deprecatedSignature = (child.signatures ?? [])
            .map((signature) => renderTypedocComment(signature.comment))
            .find((rendered) => rendered.deprecated)
        const visibility: SdkMember["visibility"] =
            flags.isPrivate === true
                ? "private"
                : flags.isProtected === true
                  ? "protected"
                  : "public"
        const base = {
            name,
            description: comment.description,
            deprecated: comment.deprecated || deprecatedSignature !== undefined,
            deprecationNote:
                comment.deprecationNote ??
                deprecatedSignature?.deprecationNote ??
                null,
            visibility,
            static: flags.isStatic === true,
            readonly: flags.isReadonly === true,
            optional: flags.isOptional === true,
            defaultValue: child.defaultValue ?? null,
        }
        switch (child.kind) {
            case TYPEDOC_KIND.constructor:
                members.push({
                    ...base,
                    kind: "constructor",
                    type: null,
                    // Constructor signatures carry the class name — render
                    // as `new Class(...)`.
                    signatures: extractSignatures(child, symbolName, "new "),
                })
                break
            case TYPEDOC_KIND.method:
                members.push({
                    ...base,
                    kind: "method",
                    type: null,
                    signatures: extractSignatures(child, name, ""),
                })
                break
            case TYPEDOC_KIND.property:
                members.push({
                    ...base,
                    kind: "property",
                    type: typedocTypeToString(child.type),
                    signatures: [],
                })
                break
            case TYPEDOC_KIND.accessor: {
                // Setter-only accessors carry their value type on the set
                // signature's first parameter (no getSignature, no
                // declaration-level type).
                const setterParameterType =
                    child.setSignature?.parameters?.[0]?.type
                members.push({
                    ...base,
                    kind: "accessor",
                    type: typedocTypeToString(
                        child.getSignature?.type ??
                            setterParameterType ??
                            child.type,
                    ),
                    signatures: [],
                })
                break
            }
            case TYPEDOC_KIND.enumMember:
                members.push({
                    ...base,
                    kind: "enum-member",
                    type:
                        child.type === undefined
                            ? null
                            : typedocTypeToString(child.type),
                    signatures: [],
                })
                break
            default:
                break
        }
    }
    return members
}

const MAX_SYMBOL_TREE_DEPTH = 64

const SYMBOL_KIND_BY_TYPEDOC_KIND = new Map<number, SdkSymbol["kind"]>([
    [TYPEDOC_KIND.enum, "enum"],
    [TYPEDOC_KIND.variable, "variable"],
    [TYPEDOC_KIND.function, "function"],
    [TYPEDOC_KIND.class, "class"],
    [TYPEDOC_KIND.interface, "interface"],
    [TYPEDOC_KIND.typeAlias, "type-alias"],
])

/**
 * Extract page-worthy exported symbols from a parsed `typedoc --json`
 * artifact. Returns null when the value is not a typedoc project (kind 1
 * root); modules/namespaces are traversed with dot-qualified names rather
 * than emitted (they carry no page of their own).
 */
export function extractSdkSymbols(artifact: unknown): SdkSymbol[] | null {
    const root = typedocNodeSchema.safeParse(artifact)
    if (!root.success || root.data.kind !== TYPEDOC_KIND.project) return null
    const symbols: SdkSymbol[] = []
    const multiModule =
        (root.data.children ?? []).filter(
            (node) => node.kind === TYPEDOC_KIND.module,
        ).length > 1
    const walk = (
        nodes: TypedocNode[],
        prefix: string,
        depth: number,
    ): void => {
        // Real module/namespace trees are a handful of levels deep; an
        // adversarially nested artifact stops here instead of recursing
        // toward a stack overflow (the caller also try/catches — a parse
        // that blows the stack earlier degrades to a diagnostic).
        if (depth > MAX_SYMBOL_TREE_DEPTH) return
        for (const node of nodes) {
            if (
                node.kind === TYPEDOC_KIND.module ||
                node.kind === TYPEDOC_KIND.namespace
            ) {
                // Namespaces always qualify their children; module names
                // join only in MULTI-entry projects, where two entry points
                // can export the same identifier and an unqualified name
                // could not say which module to import from.
                const qualifies =
                    node.kind === TYPEDOC_KIND.namespace ||
                    (node.kind === TYPEDOC_KIND.module && multiModule)
                walk(
                    node.children ?? [],
                    qualifies && node.name ? `${prefix}${node.name}.` : prefix,
                    depth + 1,
                )
                continue
            }
            const kind =
                node.kind === undefined
                    ? undefined
                    : SYMBOL_KIND_BY_TYPEDOC_KIND.get(node.kind)
            if (!kind) continue
            const name = `${prefix}${node.name ?? "unknown"}`
            const comment = renderTypedocComment(node.comment)
            // Function @deprecated tags commonly live on the signature.
            const deprecatedSignature = (node.signatures ?? [])
                .map((signature) => renderTypedocComment(signature.comment))
                .find((rendered) => rendered.deprecated)
            const firstSource = node.sources?.[0]
            symbols.push({
                name,
                kind,
                description: comment.description,
                deprecated:
                    comment.deprecated || deprecatedSignature !== undefined,
                deprecationNote:
                    comment.deprecationNote ??
                    deprecatedSignature?.deprecationNote ??
                    null,
                typeParameters:
                    (node.typeParameters ?? []).length > 0
                        ? typeParametersText(node.typeParameters)
                        : null,
                signatures:
                    kind === "function"
                        ? extractSignatures(
                              node,
                              node.name ?? name,
                              "function ",
                          )
                        : // Callable interfaces: kind-4096 call-signature
                          // children ARE the primary API.
                          (node.children ?? [])
                              .filter(
                                  (child) =>
                                      child.kind === TYPEDOC_KIND.callSignature,
                              )
                              .flatMap((child) =>
                                  extractSignatures(
                                      child,
                                      node.name ?? name,
                                      "",
                                  ),
                              ),
                type:
                    node.type === undefined
                        ? null
                        : typedocTypeToString(node.type),
                defaultValue: node.defaultValue ?? null,
                members:
                    kind === "class" ||
                    kind === "interface" ||
                    kind === "enum" ||
                    // Newer typedoc expands object-literal type aliases into
                    // property children instead of a `type` tree.
                    kind === "type-alias"
                        ? extractMembers(node, node.name ?? name)
                        : [],
                source: firstSource?.fileName
                    ? {
                          file: firstSource.fileName,
                          line: firstSource.line ?? null,
                      }
                    : null,
            })
        }
    }
    walk(root.data.children ?? [], "", 0)
    return symbols
}

// ── Markdown rendering ───────────────────────────────────────────────────

const KIND_LABELS: Record<SdkSymbol["kind"], string> = {
    module: "module",
    namespace: "namespace",
    class: "class",
    interface: "interface",
    enum: "enum",
    function: "function",
    "type-alias": "type alias",
    variable: "variable",
}

/** Deterministic frontmatter — JSON strings are valid YAML scalars. */
function frontmatter(title: string, description: string | null): string {
    const lines = [`title: ${JSON.stringify(title)}`]
    if (description) lines.push(`description: ${JSON.stringify(description)}`)
    return `---\n${lines.join("\n")}\n---\n`
}

/** Plain-text excerpt of a rendered description (frontmatter/index lists). */
function plainExcerpt(description: string | null): string | null {
    if (!description) return null
    const text = description
        .replaceAll(/\\([<{])/g, "$1")
        .replaceAll("`", "")
        .replaceAll(/\s+/g, " ")
        .trim()
    if (!text) return null
    return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text
}

function deprecationBlock(symbol: {
    deprecated: boolean
    deprecationNote: string | null
}): string[] {
    if (!symbol.deprecated) return []
    return [
        `> **Deprecated.**${symbol.deprecationNote ? ` ${symbol.deprecationNote}` : ""}`,
    ]
}

function signatureBlocks(signatures: SdkSignature[]): string[] {
    const blocks: string[] = []
    for (const signature of signatures) {
        blocks.push(tsFence(signature.text))
        if (signature.description) blocks.push(signature.description)
        const parameterLines = signature.parameters.map((parameter) => {
            const optional = parameter.optional ? "?" : ""
            const defaulted =
                parameter.defaultValue === null
                    ? ""
                    : ` (default: ${inlineCode(parameter.defaultValue)})`
            const description = parameter.description
                ? ` — ${parameter.description}`
                : ""
            return `- \`${parameter.name}${optional}\`: ${inlineCode(parameter.type)}${defaulted}${description}`
        })
        if (parameterLines.length > 0) blocks.push(parameterLines.join("\n"))
    }
    return blocks
}

function memberSections(title: string, members: SdkMember[]): string[] {
    if (members.length === 0) return []
    const blocks: string[] = [`## ${title}`]
    for (const member of members) {
        // The section heading already says "Constructor" — an H3 named
        // "constructor" underneath it would just repeat it.
        if (member.kind !== "constructor")
            blocks.push(`### ${escapeMdxProse(member.name)}`)
        blocks.push(...deprecationBlock(member))
        if (member.kind === "method" || member.kind === "constructor") {
            // Callables carry modifiers too — a static or protected method
            // must not present as an ordinary public instance member.
            const badges: string[] = []
            if (member.visibility !== "public") badges.push(member.visibility)
            if (member.static) badges.push("static")
            if (member.optional) badges.push("optional")
            if (badges.length > 0)
                blocks.push(
                    badges.map((badge) => inlineCode(badge)).join(" · "),
                )
            blocks.push(...signatureBlocks(member.signatures))
        } else if (member.type !== null) {
            const badges: string[] = []
            if (member.visibility !== "public") badges.push(member.visibility)
            if (member.static) badges.push("static")
            if (member.readonly) badges.push("readonly")
            if (member.optional) badges.push("optional")
            const defaulted =
                member.defaultValue === null
                    ? ""
                    : ` (default: ${inlineCode(member.defaultValue)})`
            blocks.push(
                `${inlineCode(member.type)}${badges.map((badge) => ` · ${badge}`).join("")}${defaulted}`,
            )
        }
        if (member.description) blocks.push(member.description)
    }
    return blocks
}

/**
 * Deterministic markdown for one symbol page — template rendering of
 * already-structured data, never an LLM. The frontmatter title is the page
 * H1 (DocsTitle renders it; a body H1 would double it), so the body opens
 * with the kind badge line.
 */
export function sdkSymbolMarkdown(symbol: SdkSymbol): string {
    const name = escapeMdxProse(symbol.name)
    const generics = symbol.typeParameters
        ? ` ${inlineCode(`<${symbol.typeParameters}>`)}`
        : ""
    const blocks: string[] = [
        `\`${KIND_LABELS[symbol.kind]}\` **${name}**${generics}`,
    ]
    blocks.push(...deprecationBlock(symbol))
    if (symbol.description) blocks.push(symbol.description)
    if (symbol.source) {
        blocks.push(
            `Defined in ${inlineCode(`${symbol.source.file}${symbol.source.line === null ? "" : `:${symbol.source.line}`}`)}`,
        )
    }

    if (symbol.kind === "function") {
        blocks.push(...signatureBlocks(symbol.signatures))
    } else if (symbol.kind === "variable") {
        const defaulted =
            symbol.defaultValue === null ? "" : ` = ${symbol.defaultValue}`
        // Fences show the LEAF declaration name — a module-qualified
        // "const core.X" is invalid TypeScript (titles keep the full name).
        const leaf = symbol.name.split(".").at(-1) ?? symbol.name
        blocks.push(
            tsFence(`const ${leaf}: ${symbol.type ?? "unknown"}${defaulted}`),
        )
    } else if (symbol.kind === "type-alias") {
        if (symbol.type !== null) {
            const leaf = symbol.name.split(".").at(-1) ?? symbol.name
            const generics = symbol.typeParameters
                ? `<${symbol.typeParameters}>`
                : ""
            blocks.push(tsFence(`type ${leaf}${generics} = ${symbol.type}`))
        }
        blocks.push(
            ...memberSections(
                "Properties",
                symbol.members.filter(
                    (member) =>
                        member.kind === "property" ||
                        member.kind === "accessor",
                ),
            ),
            // Newer typedoc expands object-literal alias METHODS too.
            ...memberSections(
                "Methods",
                symbol.members.filter((member) => member.kind === "method"),
            ),
        )
    } else if (symbol.kind === "enum") {
        const members = symbol.members.filter(
            (member) => member.kind === "enum-member",
        )
        if (members.length > 0) {
            blocks.push(
                "## Members",
                members
                    .map((member) => {
                        const value =
                            member.type === null
                                ? ""
                                : ` = ${inlineCode(member.type)}`
                        const description = member.description
                            ? ` — ${member.description}`
                            : ""
                        const deprecation = member.deprecated
                            ? ` — **Deprecated.**${member.deprecationNote ? ` ${member.deprecationNote}` : ""}`
                            : ""
                        return `- ${inlineCode(member.name)}${value}${deprecation}${description}`
                    })
                    .join("\n"),
            )
        }
    } else {
        // class / interface — call signatures (callable interfaces) first.
        if (symbol.signatures.length > 0)
            blocks.push(...signatureBlocks(symbol.signatures))
        blocks.push(
            ...memberSections(
                "Constructor",
                symbol.members.filter(
                    (member) => member.kind === "constructor",
                ),
            ),
            ...memberSections(
                "Properties",
                symbol.members.filter(
                    (member) =>
                        member.kind === "property" ||
                        member.kind === "accessor",
                ),
            ),
            ...memberSections(
                "Methods",
                symbol.members.filter((member) => member.kind === "method"),
            ),
        )
    }

    return `${frontmatter(symbol.name, plainExcerpt(symbol.description))}\n${blocks.join("\n\n")}\n`
}

const INDEX_SECTION_ORDER: Array<{ kind: SdkSymbol["kind"]; title: string }> = [
    { kind: "class", title: "Classes" },
    { kind: "interface", title: "Interfaces" },
    { kind: "enum", title: "Enums" },
    { kind: "function", title: "Functions" },
    { kind: "type-alias", title: "Type Aliases" },
    { kind: "variable", title: "Variables" },
]

/** Index page for one sdk node: symbols grouped by kind, linked by URL. */
export function sdkIndexMarkdown(
    title: string,
    entries: Array<{ symbol: SdkSymbol; stem: string }>,
): string {
    const blocks: string[] = []
    for (const section of INDEX_SECTION_ORDER) {
        const rows = entries.filter(
            (entry) => entry.symbol.kind === section.kind,
        )
        if (rows.length === 0) continue
        blocks.push(
            `## ${section.title}`,
            rows
                .map((entry) => {
                    const excerpt = plainExcerpt(entry.symbol.description)
                    return `- [${escapeMdxProse(entry.symbol.name)}](/${entry.stem})${excerpt ? ` — ${escapeMdxProse(excerpt)}` : ""}`
                })
                .join("\n"),
        )
    }
    return `${frontmatter(title, `${title} API reference.`)}\n${blocks.join("\n\n")}\n`
}

// ── Navigation sweep + page generation ───────────────────────────────────

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

const NODE_TITLE_KEYS = [
    "group",
    "tab",
    "anchor",
    "dropdown",
    "item",
    "product",
    "version",
    "language",
] as const

// Matches compile.ts MAX_PAGE_BYTES without importing the compile graph
// (compile.ts imports this module — a value import back would cycle).
const MAX_GENERATED_PAGE_BYTES = 1024 * 1024

export interface GeneratedSdkResult {
    navigation: Navigation
    files: Array<{ path: string; content: string }>
}

/**
 * Sweep the parsed navigation for sdk nodes, generate markdown pages for
 * typedoc artifacts, and append the generated page stems to each node's
 * `pages` list (the sdk key itself stays on the node like any other authored
 * data). Every failure is a warn diagnostic and the node simply generates
 * nothing — an sdk artifact can never reject a snapshot.
 */
export function generateSdkDocs(input: {
    navigation: Navigation
    files: Array<{ path: string; content: string }>
    diagnostics: Diagnostic[]
}): GeneratedSdkResult {
    const configPath = input.files.some((file) => file.path === "docs.json")
        ? "docs.json"
        : input.files.some((file) => file.path === "mint.json")
          ? "mint.json"
          : "docs.json"
    const filesByPath = new Map(input.files.map((file) => [file.path, file]))
    // Stems already claimed by authored pages (any extension) or earlier sdk
    // nodes — a generated page never shadows an authored one.
    const claimedStems = new Set(
        input.files
            .filter((file) => /\.(mdx|md)$/i.test(file.path))
            .map((file) => file.path.replace(/\.(mdx|md)$/i, "")),
    )
    const generatedFiles: Array<{ path: string; content: string }> = []
    // Directories already claimed by earlier sdk nodes — default (title-
    // derived) directories suffix themselves out of collisions.
    const usedDirectories = new Set<string>()

    const generateForNode = (
        ref: z.infer<typeof docsSdkNavRefSchema>,
        nodeTitle: string | null,
        scope: string | null,
    ): string[] => {
        if (ref.format !== "typedoc") {
            input.diagnostics.push({
                code: "unsupported_field",
                severity: "warn",
                message: `navigation sdk format "${ref.format}" is not supported yet; only typedoc JSON artifacts generate pages.`,
                path: configPath,
            })
            return []
        }
        if (/^https?:\/\//i.test(ref.source)) {
            input.diagnostics.push({
                code: "unsupported_field",
                severity: "warn",
                message: `navigation sdk source "${ref.source}" is remote; remote sdk sources land with the hardened-fetcher stack — commit the typedoc JSON artifact into the docs repo for now.`,
                path: configPath,
            })
            return []
        }
        const sourcePath = ref.source.replaceAll("\\", "/").replace(/^\/+/, "")
        const file = filesByPath.get(sourcePath)
        if (!file) {
            input.diagnostics.push({
                code: "asset_missing",
                severity: "warn",
                message: `navigation sdk source was not found in the docs repo: ${ref.source}.`,
                path: configPath,
            })
            return []
        }
        if (Buffer.byteLength(file.content, "utf8") > MAX_SDK_ARTIFACT_BYTES) {
            input.diagnostics.push({
                code: "asset_oversize",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" exceeds ${MAX_SDK_ARTIFACT_BYTES / 1024 / 1024}MB; no pages were generated.`,
                path: sourcePath,
            })
            return []
        }
        let artifact: unknown
        try {
            artifact = JSON.parse(file.content)
        } catch (error) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" is not valid JSON (${error instanceof Error ? error.message.slice(0, 120) : "parse error"}); no pages were generated.`,
                path: sourcePath,
            })
            return []
        }
        let symbols: SdkSymbol[] | null
        try {
            symbols = extractSdkSymbols(artifact)
        } catch {
            // A pathologically nested artifact can exhaust the call stack
            // inside the schema parse before the walk's own depth bound
            // applies — degrade to the same warn instead of rejecting the
            // snapshot.
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" is too deeply nested to process; no pages were generated.`,
                path: sourcePath,
            })
            return []
        }
        if (symbols === null) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" is not a typedoc --json artifact (expected a kind-1 project root); no pages were generated.`,
                path: sourcePath,
            })
            return []
        }
        if (symbols.length === 0) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" contains no documented exports; no pages were generated.`,
                path: sourcePath,
            })
            return []
        }
        // The cap covers GENERATED PAGES per node — the index page occupies
        // one slot, so at most MAX-1 symbols mint pages.
        if (symbols.length > MAX_SDK_PAGES_PER_NODE - 1) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `sdk artifact "${sourcePath}" would generate ${symbols.length + 1} pages including the index (limit ${MAX_SDK_PAGES_PER_NODE}); only the first ${MAX_SDK_PAGES_PER_NODE - 1} symbols got pages.`,
                path: sourcePath,
            })
            symbols = symbols.slice(0, MAX_SDK_PAGES_PER_NODE - 1)
        }

        // Authored directories are URL segment paths — never dot segments
        // (browsers normalize "../" away from the stored route, so links and
        // collision checks would disagree). Invalid → the title default.
        const explicitSegments = ref.directory
            ?.replaceAll("\\", "/")
            .split("/")
            .filter((segment) => segment.length > 0)
        if (
            explicitSegments !== undefined &&
            (explicitSegments.length === 0 ||
                explicitSegments.some(
                    (segment) => segment === "." || segment === "..",
                ))
        ) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `navigation sdk directory "${ref.directory}" may not contain dot segments; the default directory was used.`,
                path: configPath,
            })
        }
        let explicitDirectory =
            explicitSegments !== undefined &&
            explicitSegments.length > 0 &&
            explicitSegments.every(
                (segment) => segment !== "." && segment !== "..",
            )
                ? explicitSegments.join("/")
                : null
        // snippets/ never compiles into served pages (authoredPageFiles
        // excludes it) — generating there would produce nav refs to pages
        // that do not exist.
        if (
            explicitDirectory === "snippets" ||
            explicitDirectory?.startsWith("snippets/")
        ) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `navigation sdk directory "${explicitDirectory}" is reserved (snippets/ never serves pages); the default directory was used.`,
                path: configPath,
            })
            explicitDirectory = null
        }
        // Default directories disambiguate across sdk nodes: two "SDK
        // Reference" tabs (v1/v2) would otherwise derive the same directory
        // and the second node's every page would collide away. They also
        // inherit the nearest enclosing nav directory (version/language
        // scope) so partitioning versions/localizes the generated pages;
        // explicit directories stay exactly as authored.
        let directory = explicitDirectory
        if (directory === null) {
            const base = slugify(nodeTitle ?? "") || "sdk"
            // A reserved SCOPE would make every suffixed candidate reserved
            // too (snippets/sdk-2, snippets/sdk-3, … — an unterminating
            // loop); nothing under snippets/ ever serves, so drop it.
            const scopeIsReserved =
                scope !== null &&
                (scope === "snippets" || scope.startsWith("snippets/"))
            const prefixed =
                scope && !scopeIsReserved ? `${scope}/${base}` : base
            directory = prefixed
            for (
                let n = 2;
                usedDirectories.has(directory) ||
                directory === "snippets" ||
                directory.startsWith("snippets/");
                n += 1
            )
                directory = `${prefixed}-${n}`
        }
        usedDirectories.add(directory)

        // Slug per symbol, unique within the node's directory. "index" is
        // reserved up front for the section index page — a symbol literally
        // named index gets index-2 instead of colliding with it.
        const usedSlugs = new Set<string>(["index"])
        const entries: Array<{ symbol: SdkSymbol; stem: string }> = []
        for (const symbol of symbols) {
            const base = slugify(symbol.name) || "symbol"
            let slug = base
            for (let n = 2; usedSlugs.has(slug); n += 1) slug = `${base}-${n}`
            usedSlugs.add(slug)
            entries.push({ symbol, stem: `${directory}/${slug}` })
        }

        const admissible = (stem: string, content: string): boolean => {
            // Route equivalence, not just raw stems: "api/index" and "api"
            // serve the SAME /api route (trailing index strips), and a
            // collision there would reject the whole snapshot instead of
            // letting the authored page win as promised.
            const routeStems = stem.endsWith("/index")
                ? [stem, stem.slice(0, -"/index".length)]
                : [stem, `${stem}/index`]
            if (routeStems.some((candidate) => claimedStems.has(candidate))) {
                input.diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `generated sdk page "${stem}" collides with an authored page; the authored page wins.`,
                    path: `${stem}.md`,
                })
                return false
            }
            if (Buffer.byteLength(content, "utf8") > MAX_GENERATED_PAGE_BYTES) {
                input.diagnostics.push({
                    code: "asset_oversize",
                    severity: "warn",
                    message: `generated sdk page "${stem}" exceeds ${MAX_GENERATED_PAGE_BYTES / 1024}KB and was skipped.`,
                    path: `${stem}.md`,
                })
                return false
            }
            return true
        }

        // Symbol pages admit FIRST so the index only ever links to pages
        // that actually exist (a skipped oversize/colliding symbol must not
        // leave a dangling index entry).
        const symbolFiles: Array<{ path: string; content: string }> = []
        const admittedEntries: Array<{ symbol: SdkSymbol; stem: string }> = []
        for (const entry of entries) {
            const content = sdkSymbolMarkdown(entry.symbol)
            if (!admissible(entry.stem, content)) continue
            claimedStems.add(entry.stem)
            symbolFiles.push({ path: `${entry.stem}.md`, content })
            admittedEntries.push(entry)
        }
        const indexStem = `${directory}/index`
        const indexContent = sdkIndexMarkdown(
            nodeTitle ?? "SDK Reference",
            admittedEntries,
        )
        const indexAdmitted = admissible(indexStem, indexContent)
        if (indexAdmitted) {
            claimedStems.add(indexStem)
            generatedFiles.push({
                path: `${indexStem}.md`,
                content: indexContent,
            })
        }
        generatedFiles.push(...symbolFiles)
        return [
            ...(indexAdmitted ? [indexStem] : []),
            ...admittedEntries.map((entry) => entry.stem),
        ]
    }

    const recordSchema = z.record(z.string(), z.unknown())
    const rewrite = (value: unknown, scope: string | null): unknown => {
        if (Array.isArray(value))
            return value.map((entry) => rewrite(entry, scope))
        const record = recordSchema.safeParse(value)
        if (!record.success) return value
        // A nav node with its own physical directory (version/language/tab)
        // scopes everything under it: generated pages must live inside that
        // directory or version/locale partitioning would leave them
        // unpartitioned and the nested navigation pointing at shared routes.
        const ownDirectory =
            typeof record.data.directory === "string" &&
            record.data.directory.length > 0
                ? record.data.directory
                      .replaceAll("\\", "/")
                      .replace(/^\/+|\/+$/g, "")
                : null
        const childScope = ownDirectory ?? scope
        const rewritten = Object.fromEntries(
            Object.entries(record.data).map(([key, entry]) => [
                key,
                key === "sdk" ? entry : rewrite(entry, childScope),
            ]),
        )
        if (!("sdk" in rewritten)) return rewritten
        const ref = docsSdkNavRefSchema.safeParse(rewritten.sdk)
        if (!ref.success) {
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid navigation sdk reference (${ref.error.issues[0]?.message ?? "schema error"}); no pages were generated.`,
                path: configPath,
            })
            return rewritten
        }
        const titleEntry = NODE_TITLE_KEYS.map((key) => rewritten[key]).find(
            (candidate) => typeof candidate === "string",
        )
        const navRefs = generateForNode(
            ref.data,
            typeof titleEntry === "string" ? titleEntry : null,
            childScope,
        )
        if (navRefs.length === 0) return rewritten
        const existingPages = Array.isArray(rewritten.pages)
            ? rewritten.pages
            : []
        return { ...rewritten, pages: [...existingPages, ...navRefs] }
    }

    return {
        navigation: navigationSchema.parse(rewrite(input.navigation, null)),
        files: generatedFiles,
    }
}
