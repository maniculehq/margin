import type { Root } from "mdast"
import { visit } from "unist-util-visit"
import {
    ALLOWED_MDX_COMPONENT_MEMBERS,
    ALLOWED_MDX_COMPONENTS,
    type AllowedMdxComponent,
    type Diagnostic,
    isAllowedUrl,
} from "../types/docs"

/**
 * Authored MDX runs in the visitor's browser and, for server snapshots,
 * only in a host-free V8 isolate (src/lib/sandbox-render.ts: no process,
 * require, fetch, timers, or DOM; 250 ms and 128 MB). This AST pass remains
 * the first gate. Reject markup that could escape the boundary: foreign
 * documents, inline handlers, and URL schemes outside the shared allow-list.
 */

export interface DocsViolation {
    path: string
    message: string
    line?: number
}

const ALLOWED_COMPONENT_SET: ReadonlySet<string> = new Set(
    ALLOWED_MDX_COMPONENTS,
)

function allowedMembersOf(rootName: string): readonly string[] {
    const known = ALLOWED_MDX_COMPONENTS.find(
        (component): component is AllowedMdxComponent => component === rootName,
    )
    return known ? (ALLOWED_MDX_COMPONENT_MEMBERS[known] ?? []) : []
}

/**
 * Deny intrinsic elements that execute code or load foreign documents. Inline
 * SVG is allowed, but script, foreignObject, and SMIL elements remain blocked
 * because their attributes can smuggle executable links past URL checks.
 */
export const DENIED_INTRINSICS: ReadonlySet<string> = new Set([
    "script",
    "object",
    "embed",
    "style",
    "link",
    "meta",
    "base",
    "frame",
    "frameset",
    "noscript",
    "foreignobject",
    "animate",
    "set",
    "animatemotion",
    "animatetransform",
])

export const URL_BEARING_ATTRIBUTES: ReadonlySet<string> = new Set([
    "href",
    "src",
    "img",
    "poster",
    "action",
    "formaction",
    "cite",
    "to",
    "srcset",
    "data",
    "background",
    // SVG spellings: React maps xlinkHref to xlink:href, and MDX also
    // accepts the namespaced form — both reach <a>/<use> inside inline svg
    // (the standalone SVG asset sanitizer covers the same pair).
    "xlinkhref",
    "xlink:href",
])

interface MdxJsxAttribute {
    type: string
    name?: string
    value?: unknown
}

interface MdxJsxElement {
    type: string
    name?: string | null
    attributes?: MdxJsxAttribute[]
    position?: { start?: { line?: number } }
}

/**
 * Authored iframes are https video embeds. Anything else about the element
 * (srcdoc, on* handlers) is denied by the general attribute rules; the src
 * itself must be a static https URL — no expressions, no other schemes.
 */
function iframeSrcViolation(jsx: MdxJsxElement): string | null {
    const src = jsx.attributes?.find(
        (attr) => attr.type === "mdxJsxAttribute" && attr.name === "src",
    )
    if (!src || typeof src.value !== "string")
        return "<iframe> requires a static string src attribute"
    if (!/^https:\/\//i.test(src.value.trim()))
        return "<iframe> src must be an https URL"
    return null
}

/**
 * Remark plugin collecting allow-list violations into `violations`. Runs
 * early in the remark chain (before our own plugins add generated exports),
 * so every mdxjsEsm node it sees is client-authored. Snippet imports are
 * consumed by remarkSnippetImports before this runs; `moduleScopeNames`
 * carries the component names those imports bound, which render from the
 * page's own inlined code rather than the built-in component map.
 */
export function remarkDocsAllowList(input: {
    path: string
    violations: DocsViolation[]
    diagnostics?: Diagnostic[]
    moduleScopeNames?: ReadonlySet<string>
}) {
    const { path, violations } = input
    const report = (
        message: string,
        node: { position?: { start?: { line?: number } } },
    ) => violations.push({ path, message, line: node.position?.start?.line })

    return () => (tree: Root) => {
        visit(tree, (node, index, parent) => {
            switch (node.type) {
                // Only snippet imports are meaningful — remarkSnippetImports
                // consumed those already (and the snippet chain lifts export
                // blocks), so whatever reaches here is an unsupported import
                // (bare specifiers, URLs) or a page-level export. Strip
                // these with a warn so the page renders
                // without the binding rather than failing the tenant.
                case "mdxjsEsm": {
                    if (
                        input.diagnostics &&
                        parent &&
                        typeof index === "number"
                    ) {
                        input.diagnostics.push({
                            code: "esm_stripped",
                            severity: "warn",
                            message:
                                "An import/export statement was removed — only imports of files under `/snippets/` are supported in docs MDX.",
                            path,
                        })
                        parent.children.splice(index, 1)
                        return index
                    }
                    report(
                        "only imports of files under `/snippets/` are supported in docs MDX — other import/export statements are not allowed",
                        node,
                    )
                    return
                }
                case "mdxJsxFlowElement":
                case "mdxJsxTextElement": {
                    const jsx: MdxJsxElement = node
                    const name = jsx.name ?? ""
                    // Fragments (<>...</>) have a null name — inert, allowed.
                    if (name) {
                        const isComponent = /^[A-Z]/.test(name)
                        // Member expressions (<Tree.File>): snippet-bound
                        // roots may carry any member (their module defines
                        // them); built-in roots only the members the
                        // framework actually attaches — anything else would
                        // dereference undefined at render time.
                        const segments = name.split(".")
                        const rootName = segments[0] ?? name
                        const memberAllowed =
                            segments.length === 1 ||
                            input.moduleScopeNames?.has(rootName) ||
                            (segments.length === 2 &&
                                allowedMembersOf(rootName).includes(
                                    segments[1] ?? "",
                                ))
                        if (
                            isComponent &&
                            (!memberAllowed ||
                                (!ALLOWED_COMPONENT_SET.has(rootName) &&
                                    !input.moduleScopeNames?.has(rootName)))
                        ) {
                            // Warn and unwrap unknown components rather than
                            // failing the tenant: Mintlify-authored content
                            // may use internal components, and compiled output
                            // must not reference an unknown runtime identifier.
                            input.diagnostics?.push({
                                code: "component_unknown",
                                severity: "warn",
                                message: `<${name}> is not a known component — rendered as its children.`,
                                path,
                            })
                            if (parent && typeof index === "number") {
                                parent.children.splice(
                                    index,
                                    1,
                                    ...node.children,
                                )
                                return index
                            }
                            return
                        }
                        if (!isComponent && name.toLowerCase() === "iframe") {
                            const violation = iframeSrcViolation(jsx)
                            if (violation) report(violation, jsx)
                        } else if (
                            !isComponent &&
                            DENIED_INTRINSICS.has(name.toLowerCase())
                        ) {
                            report(`<${name}> elements are not allowed`, jsx)
                        }
                    }
                    for (const attr of jsx.attributes ?? []) {
                        // Spread attributes ({...props}) have no static shape
                        // to check — still rejected.
                        if (attr.type !== "mdxJsxAttribute") {
                            report(
                                `spread attributes on <${name}> are not allowed`,
                                jsx,
                            )
                            continue
                        }
                        const attrName = attr.name ?? ""
                        // data-rail* are ingest-internal layout markers
                        // (splitPageRail): an authored copy would spoof the
                        // rail-mounted CSS state (`:has([data-rail])`) on
                        // pages where no rail actually renders.
                        if (
                            /^on/i.test(attrName) ||
                            attrName === "srcdoc" ||
                            /^data-rail/i.test(attrName)
                        ) {
                            report(
                                `attribute "${attrName}" on <${name}> is not allowed`,
                                jsx,
                            )
                        }
                        if (
                            typeof attr.value === "string" &&
                            URL_BEARING_ATTRIBUTES.has(
                                attrName.toLowerCase(),
                            ) &&
                            !isAllowedUrl(attr.value)
                        ) {
                            report(
                                `attribute "${attrName}" on <${name}> uses a disallowed URL scheme`,
                                jsx,
                            )
                        }
                    }
                    return
                }
                // Markdown links/images/reference-definitions carry URLs too
                // — same scheme allow-list as JSX attributes (defense in
                // depth; React additionally neutralizes javascript: hrefs,
                // but this pipeline must not depend on the renderer).
                case "link":
                case "image":
                case "definition": {
                    if (!isAllowedUrl(node.url)) {
                        report(
                            `${node.type} URL uses a disallowed scheme: ${node.url.slice(0, 60)}`,
                            node,
                        )
                    }
                    return
                }
                // md-format raw HTML never appears in mdx format, but if a
                // repo ships plain .md files the html node type can — deny it
                // outright rather than reason about its contents.
                case "html":
                    report("raw HTML blocks are not allowed", node)
                    return
                default:
            }
        })
    }
}

export function remarkDocsVariables(input: {
    variables: Record<string, string>
    diagnostics: Diagnostic[]
    path: string
}) {
    return () => (tree: Root) => {
        visit(tree, "mdxTextExpression", (node, index, parent) => {
            const match = /^\{\{([A-Za-z0-9_.-]+)\}\}$/.exec(`{${node.value}}`)
            if (!match || typeof index !== "number" || !parent) return
            const key = match[1]
            if (!key) return
            const value = Object.hasOwn(input.variables, key)
                ? input.variables[key]
                : undefined
            if (value === undefined) {
                input.diagnostics.push({
                    code: "field_invalid",
                    severity: "info",
                    message: `Unknown docs variable "${key}" was left as literal text.`,
                    path: input.path,
                })
            }
            parent.children.splice(index, 1, {
                type: "text",
                value: value ?? `{{${key}}}`,
            })
        })
        // Substitution applies inside code fences and inline code too.
        // Only declared names resolve: code
        // samples legitimately show template syntax ({{ .Name }}, Jinja),
        // so unknown names stay literal without a diagnostic.
        visit(tree, (node) => {
            if (node.type !== "code" && node.type !== "inlineCode") return
            node.value = node.value.replace(
                /\{\{([A-Za-z0-9_.-]+)\}\}/g,
                (whole, key: string) =>
                    (Object.hasOwn(input.variables, key)
                        ? input.variables[key]
                        : undefined) ?? whole,
            )
        })
    }
}

/**
 * Validate internal links: root-relative targets (docs serve at the tenant
 * root) AND relative targets (./quickstart, ../guides/auth, and bare
 * quickstart or guides/auth.mdx, optionally with .mdx/.md extensions) must
 * resolve to a page in this version. Anchors, protocol-relative and external
 * URLs, and bare targets with another file extension pass through.
 */
export function validateInternalLinks(input: {
    pages: Array<{ path: string; url: string; links: string[] }>
    knownUrls: ReadonlySet<string>
    fallbackKnownUrls?: ReadonlySet<string>
    resolveFallbackTarget?: (target: string) => string
}): DocsViolation[] {
    const violations: DocsViolation[] = []
    for (const page of input.pages) {
        for (const link of page.links) {
            const bare = link.split("#")[0]?.split("?")[0] ?? ""
            if (!bare) continue
            let target: string
            if (bare.startsWith("/") && !bare.startsWith("//")) {
                target = bare
            } else if (
                /^\.\.?\//.test(bare) ||
                // Bare relative target (quickstart, guides/auth.mdx): no
                // scheme, not protocol-relative, and no file extension other
                // than .md/.mdx, so me@x.com and report.pdf pass through.
                (!/^[a-z][a-z0-9+.-]*:/i.test(bare) &&
                    !bare.startsWith("//") &&
                    !/\.(?!mdx?$)[^./]+$/i.test(bare))
            ) {
                // Resolve against the page's URL directory the way a browser
                // resolves a relative href from the served page.
                const baseSegments = page.url.split("/").slice(0, -1)
                const segments = [...baseSegments]
                for (const part of bare
                    .replace(/\.(mdx|md)$/i, "")
                    .split("/")) {
                    if (part === "" || part === ".") continue
                    if (part === "..") segments.pop()
                    else segments.push(part)
                }
                target = segments.join("/")
            } else {
                continue
            }
            target = target.replace(/\/$/, "")
            const fallbackTarget =
                input.resolveFallbackTarget?.(target) ?? target
            if (
                target &&
                !input.knownUrls.has(target) &&
                !input.fallbackKnownUrls?.has(fallbackTarget)
            ) {
                violations.push({
                    path: page.path,
                    message: `broken internal link: ${link}`,
                })
            }
        }
    }
    return violations
}
