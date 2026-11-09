import { createHash } from "node:crypto"
import type { OpenAPIOptions } from "fumadocs-openapi/server"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import {
    type Diagnostic,
    DOCS_OPENAPI_HTTP_METHODS,
    type DocsConfigSuperset,
    type DocsPageOpenapiProps,
    docsOpenapiConfigEntrySchema,
    docsOpenapiHttpMethodSchema,
    docsPageOpenapiPropsSchema,
    isPublicDocsApiOrigin,
    type VersionsManifest,
} from "../types/docs"
import type { CompiledDocsMeta, CompiledDocsPage } from "./compile"
import type { DocsViolation } from "./validate"

/**
 * Ingests tenant OpenAPI specs as bounded, validated data; external `$ref`s
 * are rejected to prevent SSRF. The framework renders descriptions in the
 * browser, so specs never execute on the server or pass through the MDX JSX
 * allow-list.
 */

export const MAX_SPEC_BYTES = 4 * 1024 * 1024
export const MAX_OPERATIONS_PER_SPEC = 500

/** Path of the optional docs-root config file. */
export const DOCS_CONFIG_PATH = "docs.json"

/** Convention: any openapi/swagger spec file anywhere in the docs root. */
const SPEC_PATH_RE = /(^|\/)(?:[\w.-]+\.)?(?:openapi|swagger)\.(?:json|ya?ml)$/i
const SPEC_EXT_RE = /\.(?:json|ya?ml)$/i

/**
 * fumadocs-openapi's Document type isn't re-exported from a public subpath —
 * derive it from the exported OpenAPIOptions input record (file path | URL |
 * Document | thunk).
 */
type OpenapiDocumentType = Exclude<
    Exclude<NonNullable<OpenAPIOptions["input"]>, string[]>[string],
    string | (() => unknown)
>

/**
 * Structural gate for a parsed spec. Full validation happens implicitly in
 * fumadocs-openapi's page builder; this typed accessor uses the same pattern
 * as mdastRootSchema in src/lib/source.ts.
 */
const openapiDocumentSchema = z.custom<OpenapiDocumentType>(
    (value) =>
        typeof value === "object" &&
        value !== null &&
        "openapi" in value &&
        typeof value.openapi === "string" &&
        value.openapi.startsWith("3.") &&
        "info" in value &&
        typeof value.info === "object" &&
        value.info !== null,
)
type OpenapiDocument = z.infer<typeof openapiDocumentSchema>

export interface CompiledOpenapiDocument {
    docId: string
    sourcePath: string
    /** sha256 of the bundled document JSON — informational + change tracking. */
    specHash: string
    label: string
    basePath: string
    document: OpenapiDocument
    /** Absolute origins from the spec's servers list — proxy allowlist. */
    servers: string[]
    /**
     * Registration provenance (not persisted): compile.ts uses it to drop
     * convention-generated routes when a BARE frontmatter ref resolves into
     * the spec — otherwise every operation serves at two routes.
     */
    origin: "config" | "nav" | "convention" | "frontmatter"
}

export interface CompiledOpenapiResult {
    documents: CompiledOpenapiDocument[]
    pages: CompiledDocsPage[]
    metas: CompiledDocsMeta[]
}

interface ResolvedSpec {
    id: string
    sourcePath: string
    label: string
    basePath: string
    /**
     * Where the registration came from. "frontmatter" specs (and convention
     * finds that are only frontmatter-referenced) register the DOCUMENT only
     * — the authored pages are the routes; nothing is generated for them.
     */
    origin: "config" | "nav" | "convention" | "frontmatter"
}

/**
 * Slug id for a spec registered by path (nav string refs, page frontmatter
 * refs): filename stem, falling back to the full path slug and then -n
 * suffixes until unique. "openapi.json" → "api"; "v2-openapi.json" →
 * "v2-openapi"; a second "es/openapi.json" → "es-openapi".
 */
function specIdFromPath(refPath: string, taken: ReadonlySet<string>): string {
    const stem = (refPath.split("/").at(-1) ?? "")
        .replace(SPEC_EXT_RE, "")
        .replace(/\.(openapi|swagger)$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    let id =
        stem === "" || stem === "openapi" || stem === "swagger" ? "api" : stem
    const pathSlug =
        refPath
            .replace(SPEC_EXT_RE, "")
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "api"
    if (taken.has(id)) id = pathSlug
    for (let n = 2; taken.has(id); n += 1) id = `${pathSlug}-${n}`
    return id
}

/**
 * Resolve which specs to build: resolved config entries are authoritative;
 * convention-discovered files (openapi.yaml, payments.openapi.json, …) fill
 * in anything not already configured. Config syntax/schema handling belongs
 * exclusively to config.ts; malformed individual entries are diagnosed and
 * skipped here without rejecting the snapshot.
 */
export function discoverOpenapiSpecs(
    files: Array<{ path: string; content: string }>,
    config: DocsConfigSuperset | null,
    versionsManifest: VersionsManifest,
    frontmatterSpecPaths: ReadonlySet<string>,
    diagnostics: Diagnostic[],
    violations: DocsViolation[],
): ResolvedSpec[] {
    const configPath = files.some((file) => file.path === DOCS_CONFIG_PATH)
        ? DOCS_CONFIG_PATH
        : files.some((file) => file.path === "mint.json")
          ? "mint.json"
          : DOCS_CONFIG_PATH
    const rawEntries: Array<{ value: unknown; path: string }> = []
    for (const [index, value] of (config?.openapi ?? []).entries()) {
        rawEntries.push({ value, path: `openapi.${index}` })
    }
    const apiOpenapi = config?.api?.openapi
    if (typeof apiOpenapi === "string") {
        rawEntries.push({ value: apiOpenapi, path: "api.openapi" })
    } else if (Array.isArray(apiOpenapi)) {
        for (const [index, value] of apiOpenapi.entries()) {
            rawEntries.push({ value, path: `api.openapi.${index}` })
        }
    }

    const byPath = new Map(files.map((f) => [f.path, f]))
    const resolved: ResolvedSpec[] = []
    const seenEntryIds = new Set<string>()
    for (const rawEntry of rawEntries) {
        const entryResult = docsOpenapiConfigEntrySchema.safeParse(
            typeof rawEntry.value === "string"
                ? {
                      id:
                          (rawEntry.value.split("/").at(-1) ?? "")
                              .replace(SPEC_EXT_RE, "")
                              .replace(/\.(openapi|swagger)$/i, "")
                              .toLowerCase()
                              .replace(/[^a-z0-9-]+/g, "-")
                              .replace(/^-+|-+$/g, "") || "api",
                      spec: rawEntry.value,
                  }
                : rawEntry.value,
        )
        if (!entryResult.success) {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid OpenAPI config entry "${rawEntry.path}"; entry skipped: ${entryResult.error.issues[0]?.message ?? "schema error"}.`,
                path: configPath,
            })
            continue
        }
        const entry = entryResult.data
        // Two entries with one id would collide on the (version, docId)
        // unique index at persist — reject as a content error instead.
        if (seenEntryIds.has(entry.id)) {
            violations.push({
                path: configPath,
                message: `duplicate openapi doc id "${entry.id}" — ids must be unique across the openapi array`,
            })
            continue
        }
        seenEntryIds.add(entry.id)
        if (!byPath.has(entry.spec)) {
            violations.push({
                path: configPath,
                message: `openapi entry "${entry.id}": spec file not found: ${entry.spec}`,
            })
            continue
        }
        resolved.push({
            id: entry.id,
            sourcePath: entry.spec,
            label: entry.label,
            basePath: entry.path,
            origin: "config",
        })
    }

    // Navigation nodes name specs authoritatively too: a nav ref like
    // `openapi: "specs/api-public.yml"` must register even when the filename
    // escapes the convention scan and no openapi[] entry lists it (object
    // refs were already lifted into openapi[] by parseDocsConfig; this
    // covers the string form). Existence-gated — a dangling string ref keeps
    // its downstream nonexistent-document diagnostic instead of turning
    // into a fatal missing-file violation.
    const navigationStringRefs: string[] = []
    const collectNavRefs = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const entry of value) collectNavRefs(entry)
            return
        }
        const record = z.record(z.string(), z.unknown()).safeParse(value)
        if (!record.success) return
        for (const [key, entry] of Object.entries(record.data)) {
            if (
                key === "openapi" &&
                typeof entry === "string" &&
                SPEC_EXT_RE.test(entry)
            ) {
                navigationStringRefs.push(entry.replace(/^\/+/, ""))
            } else {
                collectNavRefs(entry)
            }
        }
    }
    collectNavRefs(config?.navigation)
    for (const refPath of navigationStringRefs) {
        if (!byPath.has(refPath)) continue
        if (resolved.some((spec) => spec.sourcePath === refPath)) continue
        const id = specIdFromPath(refPath, seenEntryIds)
        seenEntryIds.add(id)
        // basePath "" routes through the same api-reference defaulting the
        // convention scan uses (nesting under api-reference/<id> when
        // several specs share the root).
        resolved.push({
            id,
            sourcePath: refPath,
            label: "API Reference",
            basePath: "",
            origin: "nav",
        })
    }

    const configuredPaths = new Set(resolved.map((s) => s.sourcePath))
    const configuredIds = new Set(resolved.map((s) => s.id))
    const conventional = files.filter(
        (f) => SPEC_PATH_RE.test(f.path) && !configuredPaths.has(f.path),
    )
    for (const file of conventional) {
        // "openapi.yaml" → "api"; "payments.openapi.yaml" → "payments".
        const stem = (file.path.split("/").at(-1) ?? "")
            .replace(SPEC_EXT_RE, "")
            .replace(/\.(openapi|swagger)$/i, "")
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
        const conventionalId =
            stem === "" || stem === "openapi" || stem === "swagger"
                ? "api"
                : stem
        const owningVersion = versionsManifest.find(
            (version) =>
                version.directory.length > 0 &&
                file.path.startsWith(`${version.directory}/`),
        )
        const versionId = owningVersion?.label
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
        const id = versionId ? `${versionId}-${conventionalId}` : conventionalId
        if (configuredIds.has(id)) {
            // Localized spec copies (sites ship es/fr/zh openapi.json
            // beside the docs.json-configured one) collide by convention id.
            // The configured spec wins; the copy is skipped with a warn so
            // these sites still build.
            diagnostics.push({
                code: "openapi_orphaned",
                severity: "warn",
                message: `openapi doc id "${id}" already defined in ${configPath} — this copy was skipped; configure it explicitly to serve it.`,
                path: file.path,
            })
            continue
        }
        configuredIds.add(id)
        resolved.push({
            id,
            sourcePath: file.path,
            label: "API Reference",
            basePath: owningVersion?.directory ?? "",
            origin: "convention",
        })
    }

    // Frontmatter operation refs register document-only specs; they do not
    // generate pages. Register them last so they cannot claim the slug of a
    // route-generating spec. Missing files keep the unresolved-ref diagnostic.
    for (const rawPath of [...frontmatterSpecPaths].sort()) {
        const refPath = rawPath.replace(/^\/+/, "")
        if (!byPath.has(refPath)) continue
        if (resolved.some((spec) => spec.sourcePath === refPath)) continue
        const taken = new Set(resolved.map((spec) => spec.id))
        const id = specIdFromPath(refPath, taken)
        resolved.push({
            id,
            sourcePath: refPath,
            label: "API Reference",
            basePath: "",
            origin: "frontmatter",
        })
    }

    // Single-spec sites get the plain default; multiple specs nest under it.
    // Frontmatter-registered specs never mint routes — they neither claim a
    // basePath nor count toward the nesting decision.
    const conventionCounts = new Map<string, number>()
    for (const spec of resolved) {
        if (spec.origin === "frontmatter") continue
        if (
            spec.basePath === "" ||
            versionsManifest.some(
                (version) => version.directory === spec.basePath,
            )
        )
            conventionCounts.set(
                spec.basePath,
                (conventionCounts.get(spec.basePath) ?? 0) + 1,
            )
    }
    for (const spec of resolved) {
        if (spec.origin === "frontmatter") continue
        const conventionCount = conventionCounts.get(spec.basePath)
        if (conventionCount === undefined) continue
        spec.basePath = [
            spec.basePath,
            conventionCount === 1
                ? "api-reference"
                : `api-reference/${spec.id}`,
        ]
            .filter(Boolean)
            .join("/")
    }

    const byBasePath = new Map<string, string>()
    for (const spec of resolved) {
        if (spec.origin === "frontmatter") continue
        const other = byBasePath.get(spec.basePath)
        if (other) {
            violations.push({
                path: spec.sourcePath,
                message: `openapi path collision: "${spec.basePath}" is used by both ${other} and ${spec.sourcePath}`,
            })
        } else {
            byBasePath.set(spec.basePath, spec.sourcePath)
        }
    }
    return resolved
}

/**
 * Postgres jsonb rejects \u0000 anywhere in a JSON string. One NUL in a
 * description would fail the whole document insert. Scrub it so otherwise
 * valid OpenAPI documents remain publishable.
 */
function stripNulCharacters(node: unknown): unknown {
    if (typeof node === "string") return node.replaceAll("\u0000", "")
    if (Array.isArray(node)) return node.map(stripNulCharacters)
    if (typeof node === "object" && node !== null)
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [
                key.replaceAll("\u0000", ""),
                stripNulCharacters(value),
            ]),
        )
    return node
}

/**
 * Recursively find $ref values that leave the document — rejected, never
 * fetched. Deliberately schema-agnostic (every `$ref` key counts, even
 * inside example payloads): fumadocs' own bundler resolves `$ref` positions
 * blindly and fails on external ones wherever they appear, so a spec with
 * $ref-shaped example DATA cannot be processed downstream anyway — rejecting
 * it here with a clear message beats the generator's opaque resolve error.
 */
function findExternalRefs(node: unknown, refs: Set<string>): void {
    if (Array.isArray(node)) {
        for (const item of node) findExternalRefs(item, refs)
        return
    }
    if (typeof node !== "object" || node === null) return
    for (const [key, value] of Object.entries(node)) {
        if (
            key === "$ref" &&
            typeof value === "string" &&
            !value.startsWith("#")
        )
            refs.add(value)
        findExternalRefs(value, refs)
    }
}

/** Resolve a local path-item Reference Object ({$ref: "#/..."}), else pass through. */
function derefPathItem(root: unknown, node: unknown): unknown {
    if (
        typeof node === "object" &&
        node !== null &&
        "$ref" in node &&
        typeof node.$ref === "string" &&
        node.$ref.startsWith("#/")
    )
        return resolvePointer(root, node.$ref)
    return node
}

/** JSON-pointer lookup for a local "#/..." ref. */
function resolvePointer(root: unknown, ref: string): unknown {
    let node = root
    for (const raw of ref.slice(2).split("/")) {
        const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
        if (typeof node !== "object" || node === null) return undefined
        node = Object.entries(node).find(([k]) => k === key)?.[1]
    }
    return node
}

/**
 * Inline local $refs for the agent-markdown rendering (the served page
 * dereferences client-side on its own). Cycles stop at the re-entered ref —
 * the pointer string stays as the marker.
 */
function inlineRefs(root: unknown, node: unknown, stack: Set<string>): unknown {
    if (Array.isArray(node)) return node.map((n) => inlineRefs(root, n, stack))
    if (typeof node !== "object" || node === null) return node
    const entries = Object.entries(node)
    const ref = entries.find(([k, v]) => k === "$ref" && typeof v === "string")
    if (ref && typeof ref[1] === "string" && ref[1].startsWith("#/")) {
        if (stack.has(ref[1])) return { $ref: ref[1], circular: true }
        const target = resolvePointer(root, ref[1])
        if (target === undefined) return node
        return inlineRefs(root, target, new Set([...stack, ref[1]]))
    }
    return Object.fromEntries(
        entries.map(([k, v]) => [k, inlineRefs(root, v, stack)]),
    )
}

const operationShapeSchema = z
    .object({
        summary: z.string().optional(),
        description: z.string().optional(),
        deprecated: z.boolean().optional(),
        parameters: z.array(z.unknown()).optional(),
        requestBody: z.unknown().optional(),
        responses: z.record(z.string(), z.unknown()).optional(),
        security: z.array(z.unknown()).optional(),
    })
    .passthrough()

/** The operation's own deprecated flag (sidebar badge + header pill). */
/**
 * operation.description (else its summary) as PLAIN text for the page
 * subtitle / meta description: OpenAPI descriptions are CommonMark, but the
 * subtitle renders as text, so links collapse to their label, emphasis and
 * heading markers drop, only the first paragraph is kept, and the result is
 * bounded to the frontmatter description limit. `container` is "paths" or
 * "webhooks"; null when neither field has text.
 */
function operationDescription(
    document: OpenapiDocument,
    container: "paths" | "webhooks",
    key: string,
    method: string,
): string | null {
    const escapePointerSegment = (segment: string) =>
        segment.replaceAll("~", "~0").replaceAll("/", "~1")
    const pathItem = derefPathItem(
        document,
        resolvePointer(document, `#/${container}/${escapePointerSegment(key)}`),
    )
    if (typeof pathItem !== "object" || pathItem === null) return null
    const operation = z
        .object({
            description: z.string().optional(),
            summary: z.string().optional(),
        })
        .loose()
        .safeParse(
            z.record(z.string(), z.unknown()).parse(pathItem)[
                method.toLowerCase()
            ],
        )
    if (!operation.success) return null
    const raw =
        operation.data.description?.trim() ||
        operation.data.summary?.trim() ||
        ""
    const text = (raw.split(/\n\s*\n/)[0] ?? "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        // Emphasis markers only: `_` inside identifiers (user_id) survives.
        .replace(/\*\*|~~|\*/g, "")
        .replace(/(?<!\w)_+|_+(?!\w)/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000)
    return text === "" ? null : text
}

function isOperationDeprecated(
    document: OpenapiDocument,
    path: string,
    method: string,
): boolean {
    const escapePointerSegment = (segment: string) =>
        segment.replaceAll("~", "~0").replaceAll("/", "~1")
    const pathItem = derefPathItem(
        document,
        resolvePointer(document, `#/paths/${escapePointerSegment(path)}`),
    )
    if (typeof pathItem !== "object" || pathItem === null) return false
    const operation = z
        .object({ deprecated: z.boolean().optional() })
        .loose()
        .safeParse(
            z.record(z.string(), z.unknown()).parse(pathItem)[
                method.toLowerCase()
            ],
        )
    return operation.success && operation.data.deprecated === true
}

/**
 * Deterministic agent-facing markdown for one operation or webhook — served
 * by the .md route and llms-full. Template rendering of already-structured
 * data, never an LLM. Refs are inlined so the page is self-contained, and
 * inherited metadata (path-item parameters, document-level security) is
 * merged in so the text matches what the HTML page shows.
 */
function operationMarkdown(
    document: OpenapiDocument,
    title: string,
    method: string,
    target: { path: string } | { webhook: string },
    includeSchema: boolean,
): string {
    return `# ${title}\n\n${operationMarkdownBody(document, method, target, includeSchema)}`
}

/**
 * The markdown after the title heading — reused verbatim by authored
 * frontmatter-reference pages, which append it to their own processed
 * markdown so agent surfaces (.md twin, llms-full) carry the operation
 * detail alongside the authored prose.
 */
export function operationMarkdownBody(
    document: OpenapiDocument,
    method: string,
    target: { path: string } | { webhook: string },
    /**
     * docs.json markdown.schema (default true): embed the operation's spec
     * JSON in the agent markdown. `false` keeps the prose only.
     */
    includeSchema = true,
): string {
    const escapePointerSegment = (segment: string) =>
        segment.replaceAll("~", "~0").replaceAll("/", "~1")
    const pathItem = derefPathItem(
        document,
        resolvePointer(
            document,
            "webhook" in target
                ? `#/webhooks/${escapePointerSegment(target.webhook)}`
                : `#/paths/${escapePointerSegment(target.path)}`,
        ),
    )
    const rawOperation =
        typeof pathItem === "object" && pathItem !== null
            ? Object.entries(pathItem).find(([k]) => k === method)?.[1]
            : undefined
    const operation = operationShapeSchema.safeParse(
        inlineRefs(document, rawOperation, new Set()),
    )
    const lines: string[] = [
        "webhook" in target
            ? `\`${method.toUpperCase()}\` webhook \`${target.webhook}\``
            : `\`${method.toUpperCase()} ${target.path}\``,
    ]
    if (!operation.success) return `${lines.join("\n")}\n`

    const op = operation.data
    if (op.deprecated) lines.push("", "> Deprecated")
    // Same shape as the MDX description blockquote in compile.ts, so agents
    // read every page's summary line the same way.
    const description = op.description ?? op.summary
    if (description)
        lines.push(
            "",
            ...description
                .trim()
                .split("\n")
                .map((line) => (line.length > 0 ? `> ${line}` : ">")),
        )

    // Path-item-level parameters apply to every operation under the path.
    const inheritedParams =
        typeof pathItem === "object" &&
        pathItem !== null &&
        "parameters" in pathItem &&
        Array.isArray(pathItem.parameters)
            ? inlineRefs(document, pathItem.parameters, new Set())
            : []
    const parameters = [
        ...(Array.isArray(inheritedParams) ? inheritedParams : []),
        ...(op.parameters ?? []),
    ]
    // Operations without their own security inherit the document default.
    const security =
        op.security ??
        ("security" in document && Array.isArray(document.security)
            ? document.security
            : undefined)

    // The base URL and auth schemes live at document level (servers may be
    // overridden per path item or operation); without them an agent sees
    // `GET /projects` with no host and scheme names with no header. Prose
    // lines survive markdown.schema: false; the JSON embeds the relevant
    // spec parts (servers + components.securitySchemes).
    // Same precedence as the API console (operation ?? path item ?? doc):
    // the first PRESENT list wins, even an empty one. OpenAPI reads an
    // empty list as the default `/` server, never as "inherit the parent".
    const servers = [rawOperation, pathItem, document]
        .map((owner) => z.object({ servers: serverUrlSchema }).safeParse(owner))
        .find((parsed) => parsed.success)?.data?.servers
    if (servers?.length === 0) lines.push("", "Base URL: `/`")
    for (const server of servers ?? []) {
        const variables = Object.entries(server.variables ?? {}).map(
            ([name, variable]) =>
                `\`${name}\`: ${
                    variable.enum?.length
                        ? `one of ${variable.enum.map((value) => `\`${value}\``).join(", ")}`
                        : "any value"
                }${variable.default !== undefined ? `, default \`${variable.default}\`` : ""}`,
        )
        lines.push(
            "",
            `Base URL: \`${server.url}\`${variables.length ? ` (${variables.join("; ")})` : ""}`,
        )
    }
    const schemeNames = new Set(
        z
            .array(z.record(z.string(), z.unknown()))
            .catch([])
            .parse(security ?? [])
            .flatMap((requirement) => Object.keys(requirement)),
    )
    const declaredSchemes = z
        .object({
            components: z.object({
                securitySchemes: z.record(z.string(), z.unknown()),
            }),
        })
        .safeParse(document)
    const usedSchemes = Object.fromEntries(
        Object.entries(
            declaredSchemes.success
                ? declaredSchemes.data.components.securitySchemes
                : {},
        ).filter(([name]) => schemeNames.has(name)),
    )

    const detail: Record<string, unknown> = {}
    if (servers) detail.servers = servers
    if (security) detail.security = security
    if (Object.keys(usedSchemes).length > 0)
        detail.securitySchemes = inlineRefs(document, usedSchemes, new Set())
    if (parameters.length) detail.parameters = parameters
    if (op.requestBody !== undefined) detail.requestBody = op.requestBody
    if (op.responses) detail.responses = op.responses
    if (includeSchema && Object.keys(detail).length > 0) {
        lines.push(
            "",
            "## OpenAPI",
            "",
            "```json",
            JSON.stringify(detail, null, 2),
            "```",
        )
    }
    return `${lines.join("\n")}\n`
}

const serverUrlSchema = z.array(
    z
        .object({
            url: z.string(),
            variables: z
                .record(
                    z.string(),
                    z
                        .object({
                            default: z.string().optional(),
                            enum: z.array(z.string()).optional(),
                        })
                        .passthrough(),
                )
                .optional(),
        })
        .passthrough(),
)

/**
 * Build every resolved spec into openapi document + page + meta artifacts,
 * using fumadocs-openapi's own page generation (one page per operation,
 * grouped by tag) so titles, search data, and page props can never drift from
 * what the OpenAPIPage component renders.
 */
export async function compileOpenapiDocs(
    files: Array<{ path: string; content: string }>,
    config: DocsConfigSuperset | null,
    versionsManifest: VersionsManifest,
    frontmatterSpecPaths: ReadonlySet<string>,
    diagnostics: Diagnostic[],
    violations: DocsViolation[],
): Promise<CompiledOpenapiResult> {
    // docs.json markdown.schema (default true): spec JSON in agent markdown.
    const includeSchema = config?.markdown?.schema !== false
    const result: CompiledOpenapiResult = {
        documents: [],
        pages: [],
        metas: [],
    }
    const specs = discoverOpenapiSpecs(
        files,
        config,
        versionsManifest,
        frontmatterSpecPaths,
        diagnostics,
        violations,
    )
    // A convention-discovered spec that is ALSO referenced by page
    // frontmatter serves those authored pages — generating a parallel
    // /api-reference section would duplicate every operation at a second
    // route the official site doesn't have. Explicit config/nav wins over
    // this suppression (the author asked for a generated section).
    const referencedPaths = new Set(
        [...frontmatterSpecPaths].map((p) => p.replace(/^\/+/, "")),
    )
    const byPath = new Map(files.map((f) => [f.path, f]))

    for (const spec of specs) {
        const file = byPath.get(spec.sourcePath)
        if (!file) continue

        if (Buffer.byteLength(file.content, "utf8") > MAX_SPEC_BYTES) {
            violations.push({
                path: spec.sourcePath,
                message: `spec exceeds ${MAX_SPEC_BYTES / 1024 / 1024}MB`,
            })
            continue
        }

        let parsed: unknown
        try {
            parsed = stripNulCharacters(
                spec.sourcePath.toLowerCase().endsWith(".json")
                    ? JSON.parse(file.content)
                    : parseYaml(file.content),
            )
        } catch (error) {
            violations.push({
                path: spec.sourcePath,
                message: `spec parse error: ${error instanceof Error ? error.message : String(error)}`,
            })
            continue
        }

        const document = openapiDocumentSchema.safeParse(parsed)
        if (!document.success) {
            violations.push({
                path: spec.sourcePath,
                message:
                    "not an OpenAPI 3.x document (swagger 2.0 is not supported — convert the spec)",
            })
            continue
        }

        const externalRefs = new Set<string>()
        findExternalRefs(document.data, externalRefs)
        if (externalRefs.size > 0) {
            violations.push({
                path: spec.sourcePath,
                message: `external $ref not allowed (bundle the spec into one file): ${[...externalRefs].slice(0, 3).join(", ")}`,
            })
            continue
        }

        // One walk over paths AND webhooks (both generate pages): count
        // operations for the cap, decide tag grouping, and collect every
        // servers list (root, path-item, and operation level — OpenAPI allows
        // all three) for the proxy allowlist.
        const declaredTags = new Set(
            (Array.isArray(document.data.tags)
                ? document.data.tags
                : []
            ).flatMap((tag) =>
                typeof tag === "object" &&
                tag !== null &&
                "name" in tag &&
                typeof tag.name === "string"
                    ? [tag.name]
                    : [],
            ),
        )
        const serverUrls = new Set<string>()
        const collectServers = (node: unknown) => {
            for (const server of serverUrlSchema.catch([]).parse(node ?? [])) {
                // Expand server-variable templates ({region}) with their
                // declared defaults; anything left unresolved fails URL
                // parsing below and never reaches the allowlist.
                serverUrls.add(
                    server.url.replace(/\{([^{}]+)\}/g, (whole, name) => {
                        const variable = server.variables?.[name]
                        return variable?.default ?? variable?.enum?.[0] ?? whole
                    }),
                )
            }
        }
        collectServers(document.data.servers)
        let operationCount = 0
        // groupBy "tag" silently DROPS operations that are untagged or whose
        // tag isn't declared in the root tags list — only group when every
        // operation (webhooks included) is covered by a declared tag.
        let groupByTag = declaredTags.size > 0
        for (const collection of [
            document.data.paths,
            document.data.webhooks,
        ]) {
            if (typeof collection !== "object" || collection === null) continue
            for (const rawPathItem of Object.values(collection)) {
                // Entries may be local path-item Reference Objects — the page
                // generator dereferences them, so the guards must too.
                const pathItem = derefPathItem(document.data, rawPathItem)
                if (typeof pathItem !== "object" || pathItem === null) continue
                collectServers(
                    Object.entries(pathItem).find(
                        ([k]) => k === "servers",
                    )?.[1],
                )
                for (const method of DOCS_OPENAPI_HTTP_METHODS) {
                    const operation = Object.entries(pathItem).find(
                        ([k]) => k === method,
                    )?.[1]
                    if (typeof operation !== "object" || operation === null)
                        continue
                    operationCount += 1
                    collectServers(
                        Object.entries(operation).find(
                            ([k]) => k === "servers",
                        )?.[1],
                    )
                    const tags =
                        "tags" in operation && Array.isArray(operation.tags)
                            ? operation.tags
                            : []
                    if (
                        !tags.some(
                            (tag: unknown) =>
                                typeof tag === "string" &&
                                declaredTags.has(tag),
                        )
                    )
                        groupByTag = false
                }
            }
        }
        if (operationCount > MAX_OPERATIONS_PER_SPEC) {
            violations.push({
                path: spec.sourcePath,
                message: `too many operations: ${operationCount} (limit ${MAX_OPERATIONS_PER_SPEC})`,
            })
            continue
        }

        // Relative URLs and unresolved {templates} never reach the
        // allowlist; private/internal origins (metadata endpoints, RFC1918,
        // loopback) are rejected — the proxy must never let a tenant spec
        // point server-side fetches at infrastructure (isPublicDocsApiOrigin).
        const servers = [
            ...new Set(
                [...serverUrls].flatMap((raw) => {
                    if (/[{}]/.test(raw)) return []
                    try {
                        return [new URL(raw).origin]
                    } catch {
                        return []
                    }
                }),
            ),
        ].filter(isPublicDocsApiOrigin)

        // Document-only specs: same parse/gates, no generated pages — the
        // frontmatter-referencing authored pages are the routes.
        if (
            spec.origin === "frontmatter" ||
            (spec.origin === "convention" &&
                referencedPaths.has(spec.sourcePath))
        ) {
            result.documents.push({
                docId: spec.id,
                sourcePath: spec.sourcePath,
                specHash: createHash("sha256")
                    .update(JSON.stringify(document.data), "utf8")
                    .digest("hex"),
                label: spec.label,
                basePath: spec.basePath,
                document: document.data,
                servers,
                origin: spec.origin,
            })
            continue
        }

        const { createOpenAPI } = await import("fumadocs-openapi/server")
        const openapi = createOpenAPI({
            input: { [spec.id]: document.data },
            disableCache: true,
        })
        let generated: Awaited<ReturnType<typeof openapi.staticSource>>
        try {
            generated = await openapi.staticSource({
                per: "operation",
                groupBy: groupByTag ? "tag" : "none",
                baseDir: spec.basePath,
                meta: true,
            })
        } catch (error) {
            violations.push({
                path: spec.sourcePath,
                message: `OpenAPI page generation failed: ${error instanceof Error ? error.message : String(error)}`,
            })
            continue
        }

        const docPages: CompiledDocsPage[] = []
        const docMetas: CompiledDocsMeta[] = []
        let bad = false
        // Kebab-case route slugs from operation titles:
        // fumadocs names generated files by camelCase operationId
        // (/listSandboxes); Mintlify-hosted sites serve kebab-cased summaries
        // (/list-sandboxes). Renames are basename-level so the generated
        // metas' pages arrays can be rewritten in lockstep; collisions
        // within one directory get -2, -3… suffixes.
        const basenameRenames = new Map<string, string>()
        const claimedByDir = new Map<string, Set<string>>()
        for (const generatedFile of generated.files) {
            if (generatedFile.type === "meta") continue
            const stem = generatedFile.path.replace(/\.(mdx|md)$/i, "")
            const directory = stem.includes("/")
                ? stem.slice(0, stem.lastIndexOf("/"))
                : ""
            const basename = stem.slice(directory.length + (directory ? 1 : 0))
            const title = generatedFile.data.title
            const kebab =
                (typeof title === "string" ? title : basename)
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "") || basename
            const claimed = claimedByDir.get(directory) ?? new Set<string>()
            let unique = kebab
            for (let n = 2; claimed.has(unique); n++) unique = `${kebab}-${n}`
            claimed.add(unique)
            claimedByDir.set(directory, claimed)
            if (unique !== basename)
                basenameRenames.set(`${directory}/${basename}`, unique)
        }
        const renamedPath = (path: string): string => {
            const extension = /\.(mdx|md)$/i.exec(path)?.[0] ?? ""
            const stem = path.slice(0, path.length - extension.length)
            const directory = stem.includes("/")
                ? stem.slice(0, stem.lastIndexOf("/"))
                : ""
            const basename = stem.slice(directory.length + (directory ? 1 : 0))
            const renamed = basenameRenames.get(`${directory}/${basename}`)
            return renamed
                ? `${directory}${directory ? "/" : ""}${renamed}${extension}`
                : path
        }
        for (const generatedFile of generated.files) {
            if (generatedFile.type === "meta") {
                const data =
                    typeof generatedFile.data === "object" &&
                    generatedFile.data !== null
                        ? { ...generatedFile.data }
                        : {}
                // The section folder carries the configured nav label.
                if (generatedFile.path === `${spec.basePath}/meta.json`)
                    data.title ??= spec.label
                // Page ordering entries follow the kebab renames.
                const metaDirectory = generatedFile.path
                    .replace(/\/?meta\.json$/i, "")
                    .replace(/\.(mdx|md)$/i, "")
                if (Array.isArray(data.pages)) {
                    data.pages = data.pages.map((entry) =>
                        typeof entry === "string"
                            ? (basenameRenames.get(
                                  `${metaDirectory}/${entry}`,
                              ) ?? entry)
                            : entry,
                    )
                }
                docMetas.push({ path: generatedFile.path, data })
                continue
            }
            const data = generatedFile.data
            const { payload: _payload, ...rawProps } =
                data.getOpenAPIPageProps()
            const props = docsPageOpenapiPropsSchema.safeParse(rawProps)
            if (!props.success) {
                violations.push({
                    path: spec.sourcePath,
                    message: `unexpected page props for ${generatedFile.path}: ${props.error.issues[0]?.message ?? "schema error"}`,
                })
                bad = true
                break
            }
            const operation = props.data.operations?.[0]
            const webhook = props.data.webhooks?.[0]
            const title = (data.title ?? generatedFile.path).slice(0, 255)
            const markdown = operation
                ? operationMarkdown(
                      document.data,
                      title,
                      operation.method,
                      { path: operation.path },
                      includeSchema,
                  )
                : webhook
                  ? operationMarkdown(
                        document.data,
                        title,
                        webhook.method,
                        { webhook: webhook.name },
                        includeSchema,
                    )
                  : `# ${title}\n`
            const pagePath = renamedPath(generatedFile.path)
            const slugs = pagePath
                .replace(/\.(mdx|md)$/i, "")
                .split("/")
                .filter(Boolean)
            // The operation's method + deprecation ride the light
            // frontmatter column so the sidebar can render method badges
            // without loading openapiProps. No mode is
            // stamped: the wide layout that fits the API console is derived
            // at serving from the console's presence — frontmatter.mode
            // stays an authored override only.
            const deprecated =
                operation !== undefined &&
                isOperationDeprecated(
                    document.data,
                    operation.path,
                    operation.method,
                )
            docPages.push({
                kind: "openapi",
                path: pagePath,
                url: `/${slugs.join("/")}`,
                slugs,
                title,
                // Index/meta text is one plain line (llms.txt list items,
                // meta description); the frontmatter below keeps the full
                // CommonMark description for the page subtitle.
                description:
                    typeof data.description !== "string"
                        ? null
                        : operation
                          ? operationDescription(
                                document.data,
                                "paths",
                                operation.path,
                                operation.method,
                            )
                          : webhook
                            ? operationDescription(
                                  document.data,
                                  "webhooks",
                                  webhook.name,
                                  webhook.method,
                              )
                            : null,
                icon: null,
                hidden: false,
                frontmatter: {
                    title,
                    // The framework subtitle reads frontmatter.description;
                    // the console keeps showDescription: false so the text
                    // renders once, in the page header.
                    ...(typeof data.description === "string" &&
                    data.description.trim() !== ""
                        ? { description: data.description }
                        : {}),
                    ...(operation
                        ? {
                              api: `${operation.method.toUpperCase()} ${operation.path}`,
                          }
                        : webhook
                          ? {
                                api: `${webhook.method.toUpperCase()} ${webhook.name}`,
                            }
                          : {}),
                    ...(deprecated ? { deprecated: true } : {}),
                },
                source: markdown,
                compiledJs: null,
                hast: null,
                railHast: null,
                processedMarkdown: markdown,
                mdast: null,
                codeExamples: [],
                updates: null,
                structuredData: data.structuredData,
                toc: data.toc,
                // The description renders once, as the page subtitle
                // (frontmatter.description above) — not again inside the
                // console.
                openapiProps: { ...props.data, showDescription: false },
            })
        }
        if (bad) continue

        result.documents.push({
            docId: spec.id,
            sourcePath: spec.sourcePath,
            specHash: createHash("sha256")
                .update(JSON.stringify(document.data), "utf8")
                .digest("hex"),
            label: spec.label,
            basePath: spec.basePath,
            document: document.data,
            servers,
            origin: spec.origin,
        })
        result.pages.push(...docPages)
        result.metas.push(...docMetas)
    }

    return result
}

/**
 * Page-frontmatter operation reference (`openapi:`): `"[<spec path>] METHOD
 * /path"` or `"[<spec path>] webhook <name>"`. The prefixed form names a spec;
 * the bare form is the documented single-spec shorthand. Returns null on
 * unparseable input so the caller diagnoses it and keeps the page plain MDX.
 */
export type OpenapiFrontmatterTarget =
    | { kind: "operation"; method: DocsOpenapiHttpMethod; path: string }
    | { kind: "webhook"; name: string }

export interface OpenapiFrontmatterRef {
    /** Repo-root-relative spec path (leading slash stripped); null = search all registered specs. */
    specPath: string | null
    target: OpenapiFrontmatterTarget
}

type DocsOpenapiHttpMethod = (typeof DOCS_OPENAPI_HTTP_METHODS)[number]

export function parseOpenapiFrontmatterRef(
    value: string,
): OpenapiFrontmatterRef | null {
    const tokens = value.trim().split(/\s+/)
    let specPath: string | null = null
    const first = tokens[0]
    if (first !== undefined && SPEC_EXT_RE.test(first)) {
        specPath = first.replace(/^\/+/, "")
        tokens.shift()
    }
    if (tokens.length !== 2) return null
    const [head, tail] = tokens
    if (head === undefined || tail === undefined) return null
    if (head.toLowerCase() === "webhook")
        return { specPath, target: { kind: "webhook", name: tail } }
    const method = docsOpenapiHttpMethodSchema.safeParse(head.toLowerCase())
    if (!method.success || !tail.startsWith("/")) return null
    return {
        specPath,
        target: { kind: "operation", method: method.data, path: tail },
    }
}

export type FrontmatterOpenapiResolution =
    | {
          ok: true
          docId: string
          props: DocsPageOpenapiProps
          /** "METHOD /path" — stamped as frontmatter `api` for sidebar badges. */
          api: string
          deprecated: boolean
          /** Operation-detail markdown (no title heading) for agent surfaces. */
          detailMarkdown: string
          /** operation.description ?? operation.summary — the page subtitle
           * and meta description when the author's frontmatter has none. */
          description: string | null
          /** Bare ref matched in >1 spec — resolved to the first, but flagged. */
          ambiguousAmong: string[] | null
      }
    | { ok: false; reason: string }

/**
 * Resolve a parsed frontmatter reference against the version's compiled
 * OpenAPI documents. Bare refs (no spec path) search every registered spec,
 * preferring the one nearest the referencing page's directory (a v1 page
 * matches the v1 spec, an es/ page its locale copy — review finding: pure
 * alphabetical order could cross version boundaries), then an
 * alphabetical-by-path tie-break. Ambiguity still warns.
 */
export function resolveFrontmatterOpenapiRef(
    documents: CompiledOpenapiDocument[],
    ref: OpenapiFrontmatterRef,
    pagePath: string,
    /** docs.json markdown.schema — spec JSON in the composed agent markdown. */
    includeSchema = true,
): FrontmatterOpenapiResolution {
    const pageDirectory = pagePath.split("/").slice(0, -1)
    const sharedSegments = (specPath: string): number => {
        const specDirectory = specPath.split("/").slice(0, -1)
        let shared = 0
        while (
            shared < pageDirectory.length &&
            shared < specDirectory.length &&
            pageDirectory[shared] === specDirectory[shared]
        )
            shared += 1
        return shared
    }
    const target = ref.target
    // The method a webhook page renders is whichever the webhook item
    // declares (the frontmatter syntax names no method).
    const findTarget = (
        doc: CompiledOpenapiDocument,
    ): { method: DocsOpenapiHttpMethod } | null => {
        const document = doc.document
        const collection =
            target.kind === "webhook"
                ? "webhooks" in document
                    ? document.webhooks
                    : undefined
                : document.paths
        if (typeof collection !== "object" || collection === null) return null
        const key = target.kind === "webhook" ? target.name : target.path
        const rawItem = Object.entries(collection).find(([k]) => k === key)?.[1]
        const pathItem = derefPathItem(document, rawItem)
        if (typeof pathItem !== "object" || pathItem === null) return null
        if (target.kind === "operation") {
            const operation = Object.entries(pathItem).find(
                ([k]) => k === target.method,
            )?.[1]
            return typeof operation === "object" && operation !== null
                ? { method: target.method }
                : null
        }
        for (const method of DOCS_OPENAPI_HTTP_METHODS) {
            const operation = Object.entries(pathItem).find(
                ([k]) => k === method,
            )?.[1]
            if (typeof operation === "object" && operation !== null)
                return { method }
        }
        return null
    }

    const describeTarget =
        target.kind === "webhook"
            ? `webhook "${target.name}"`
            : `${target.method.toUpperCase()} ${target.path}`
    if (ref.specPath !== null) {
        const doc = documents.find((d) => d.sourcePath === ref.specPath)
        if (!doc)
            return {
                ok: false,
                reason: `spec "${ref.specPath}" is not registered (missing file or failed validation)`,
            }
        const found = findTarget(doc)
        if (!found)
            return {
                ok: false,
                reason: `${describeTarget} not found in "${ref.specPath}"`,
            }
        return resolution(doc, found.method)
    }
    const candidates = [...documents]
        .sort(
            (a, b) =>
                sharedSegments(b.sourcePath) - sharedSegments(a.sourcePath) ||
                a.sourcePath.localeCompare(b.sourcePath),
        )
        .flatMap((doc) => {
            const found = findTarget(doc)
            return found ? [{ doc, method: found.method }] : []
        })
    const firstCandidate = candidates[0]
    if (!firstCandidate)
        return {
            ok: false,
            reason: `${describeTarget} not found in any registered spec`,
        }
    return resolution(
        firstCandidate.doc,
        firstCandidate.method,
        candidates.length > 1
            ? candidates.map((candidate) => candidate.doc.sourcePath)
            : null,
    )

    function resolution(
        doc: CompiledOpenapiDocument,
        method: DocsOpenapiHttpMethod,
        ambiguousAmong: string[] | null = null,
    ): FrontmatterOpenapiResolution {
        if (target.kind === "webhook") {
            return {
                ok: true,
                docId: doc.docId,
                props: {
                    document: doc.docId,
                    showTitle: false,
                    showDescription: false,
                    webhooks: [{ name: target.name, method }],
                },
                api: `${method.toUpperCase()} ${target.name}`,
                deprecated: false,
                description: operationDescription(
                    doc.document,
                    "webhooks",
                    target.name,
                    method,
                ),
                detailMarkdown: operationMarkdownBody(
                    doc.document,
                    method,
                    { webhook: target.name },
                    includeSchema,
                ),
                ambiguousAmong,
            }
        }
        return {
            ok: true,
            docId: doc.docId,
            props: {
                document: doc.docId,
                showTitle: false,
                showDescription: false,
                operations: [{ path: target.path, method }],
            },
            api: `${method.toUpperCase()} ${target.path}`,
            deprecated: isOperationDeprecated(
                doc.document,
                target.path,
                method,
            ),
            description: operationDescription(
                doc.document,
                "paths",
                target.path,
                method,
            ),
            detailMarkdown: operationMarkdownBody(
                doc.document,
                method,
                { path: target.path },
                includeSchema,
            ),
            ambiguousAmong,
        }
    }
}
