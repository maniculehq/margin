/** biome-ignore-all lint/suspicious/noArrayIndexKey: one-shot server render of a static mdast tree — nodes never reorder and carry no ids. */

import { posix } from "node:path"
import {
    Document,
    Image,
    Link,
    Page,
    renderToBuffer,
    StyleSheet,
    Text,
    View,
} from "@react-pdf/renderer"
import type { PhrasingContent, Root, RootContent } from "mdast"
import type { ReactNode } from "react"
import { remark } from "remark"
import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import { visit } from "unist-util-visit"
import { evaluateStaticMdxExpression } from "../types/docs-hast"
import { stripMarkdocTags } from "../types/docs-shared"
import { withBase } from "./base-path"

/** Render authored human-facing Markdown to PDF. The route resolves database
 * data and images; missing images fall back to alt text. Avoid explicit
 * `lineHeight`: @react-pdf miscalculates when text crosses a page break. */

const INK = "#141414"
const MUTED = "#6b6b6b"
const LINE = "#d9d9d9"
const CODE_BG = "#f6f6f6"

const styles = StyleSheet.create({
    page: {
        paddingTop: 56,
        paddingBottom: 72,
        paddingHorizontal: 60,
        fontFamily: "Helvetica",
        fontSize: 9.5,
        color: INK,
    },
    title: {
        fontFamily: "Helvetica-Bold",
        fontSize: 16,
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 8,
        color: MUTED,
    },
    titleRule: {
        borderBottomWidth: 1,
        borderBottomColor: LINE,
        marginTop: 10,
        marginBottom: 12,
    },
    paragraph: {
        marginBottom: 8,
    },
    heading: {
        fontFamily: "Helvetica-Bold",
        marginTop: 10,
        marginBottom: 6,
    },
    listRow: {
        flexDirection: "row",
        marginBottom: 3,
    },
    listMarker: {
        width: 18,
        flexShrink: 0,
    },
    listBody: {
        flex: 1,
    },
    blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: LINE,
        paddingLeft: 10,
        marginBottom: 7,
        color: MUTED,
    },
    codeBlock: {
        fontFamily: "Courier",
        fontSize: 8.5,
        backgroundColor: CODE_BG,
        borderWidth: 1,
        borderColor: LINE,
        padding: 8,
        marginBottom: 7,
    },
    rule: {
        borderBottomWidth: 1,
        borderBottomColor: LINE,
        marginVertical: 10,
    },
    tableRow: {
        flexDirection: "row",
        borderBottomWidth: 0.5,
        borderBottomColor: LINE,
    },
    tableCell: {
        flex: 1,
        paddingVertical: 3,
        paddingRight: 8,
    },
    image: {
        marginBottom: 8,
        maxWidth: "100%",
        objectFit: "contain",
    },
    imageFallback: {
        fontSize: 8.5,
        color: MUTED,
        marginBottom: 7,
    },
    footer: {
        position: "absolute",
        bottom: 36,
        left: 60,
        right: 60,
        flexDirection: "row",
        justifyContent: "space-between",
        borderTopWidth: 0.5,
        borderTopColor: LINE,
        paddingTop: 6,
    },
    footerText: {
        fontSize: 7.5,
        color: MUTED,
    },
})

const HEADING_SIZE: Record<number, number> = {
    1: 14,
    2: 12,
    3: 10.5,
    4: 10,
    5: 9.5,
    6: 9,
}

/** Filter authored Markdown for the human PDF: remove agent-only blocks and
 * unwrap human blocks. Mask CommonMark code before scanning tags so examples
 * remain intact; unclosed agent blocks fail closed to prevent content leaks. */
export function stripAgentBlocks(source: string): string {
    // Frontmatter is metadata, not body: a literal <Agent> token inside a
    // YAML description must not trip the fail-closed audience scan.
    const markdown = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    const masked: Array<[number, number]> = []
    visit(remark().use(remarkGfm).parse(markdown), (node) => {
        if (node.type !== "code" && node.type !== "inlineCode") return
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined) masked.push([start, end])
    })
    const inMask = (i: number) =>
        masked.some(([start, end]) => i >= start && i < end)
    const audienceIn = (
        name: string,
        attrs: string,
    ): "agents" | "humans" | null => {
        if (name === "Agent") return "agents"
        if (name === "Human") return "humans"
        if (/for\s*=\s*["']agents["']/.test(attrs)) return "agents"
        if (/for\s*=\s*["']humans["']/.test(attrs)) return "humans"
        return null
    }
    let out = ""
    let cursor = 0
    let agentDepth = 0
    const stack: Array<{
        name: string
        audience: "agents" | "humans" | null
    }> = []
    for (const match of markdown.matchAll(
        /<(\/?)(Agent|Human|Visibility)\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g,
    )) {
        if (inMask(match.index)) continue
        const [full, closing, name, attrs, selfClosing] = match
        const audience = audienceIn(name ?? "", attrs ?? "")
        const tagEnd = match.index + full.length
        if (!closing && selfClosing) {
            // Childless element — only its tag text goes.
            if (agentDepth === 0 && audience !== null) {
                out += markdown.slice(cursor, match.index)
                cursor = tagEnd
            }
            continue
        }
        if (!closing) {
            if (agentDepth === 0 && audience !== null) {
                // agents: emit up to here, then drop until the close.
                // humans: unwrap — drop just the tag.
                out += markdown.slice(cursor, match.index)
                if (audience === "humans") cursor = tagEnd
            }
            stack.push({ name: name ?? "", audience })
            if (audience === "agents") agentDepth++
            continue
        }
        // Closing tag: pop the nearest same-name open (and any unclosed
        // inner tags above it).
        let openIndex = -1
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]?.name === name) {
                openIndex = i
                break
            }
        }
        if (openIndex === -1) {
            // Stray close: drop the tag text.
            if (agentDepth === 0) {
                out += markdown.slice(cursor, match.index)
                cursor = tagEnd
            }
            continue
        }
        const entries = stack.splice(openIndex)
        const wasDropping = agentDepth > 0
        for (const entry of entries)
            if (entry.audience === "agents") agentDepth--
        if (wasDropping && agentDepth === 0) {
            cursor = tagEnd
        } else if (agentDepth === 0 && entries[0]?.audience === "humans") {
            out += markdown.slice(cursor, match.index)
            cursor = tagEnd
        }
        // null-audience Visibility keeps its tags — textOf strips them.
    }
    if (agentDepth === 0) out += markdown.slice(cursor)
    // MDX comments ({/* … */}) never render for humans, but plain remark
    // prints them as paragraph text — author-internal notes must not leak
    // into a directly-fetchable export. Same code-masking discipline, on
    // the post-filter text (offsets shifted above).
    const commentMask: Array<[number, number]> = []
    visit(remark().use(remarkGfm).parse(out), (node) => {
        if (node.type !== "code" && node.type !== "inlineCode") return
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined)
            commentMask.push([start, end])
    })
    let cleaned = ""
    let commentCursor = 0
    for (const match of out.matchAll(/\{\/\*[\s\S]*?\*\/\}/g)) {
        if (
            commentMask.some(
                ([start, end]) => match.index >= start && match.index < end,
            )
        )
            continue
        cleaned += out.slice(commentCursor, match.index)
        commentCursor = match.index + match[0].length
    }
    cleaned += out.slice(commentCursor)
    return cleaned
}

/**
 * Parse page markdown into mdast (GFM tables/strikethrough/task lists on).
 * Strips a leading frontmatter block (authored source keeps it) and
 * resolves reference-style links/images against their definitions so the
 * mapper and the route's image resolver only ever see direct nodes.
 */
/**
 * Joins the PDF ETag: bump whenever this renderer's OUTPUT changes for the
 * same stored page (fonts, layout, filtering, component mapping) so cached
 * downloads revalidate — site cache-tag purges only fire on content flips.
 */
export const PDF_RENDERER_VERSION = 6

export function parsePageMarkdown(markdown: string, sourcePath?: string): Root {
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    // Parse as MDX so component children parse as Markdown (step bodies,
    // indented fences, links inside <Check>) instead of one raw html blob.
    // An authored `## Heading {#id}` gets ingest's `[#id]` rewrite first (raw,
    // it is a broken expression). Like ingest, a page that fails as authored
    // retries with its Markdoc tags (`{% callout %}`) stripped; sources that
    // are still not valid MDX fall back to plain Markdown.
    const parseMdx = (text: string): Root | null => {
        for (const markdoc of [false, true]) {
            try {
                return remark()
                    .use(remarkMdx)
                    .use(remarkGfm)
                    .parse(markdoc ? stripMarkdocTags(text) : text)
            } catch {
                // next attempt
            }
        }
        return null
    }
    const authored = body.split("\n")
    const lines = authored.map((line) =>
        line.replace(/^(#{1,6}[^\n]*?)\s*\{#([^}\s]+)\}[ \t]*$/, "$1 [#$2]"),
    )
    // Code (a Markdown example showing the `{#id}` syntax) stays
    // byte-for-byte. Its lines come from the same MDX parse that builds the
    // tree, so fence nesting, indentation and tabs follow that parser
    // exactly. Rewriting an anchor inside a code block never changes the
    // block structure, so those lines just get their authored bytes back
    // before the final parse.
    const probe = parseMdx(lines.join("\n"))
    let root: Root
    if (probe) {
        visit(probe, "code", (node) => {
            const start = node.position?.start.line ?? 0
            const end = node.position?.end.line ?? 0
            for (let line = start; line >= 1 && line <= end; line++)
                lines[line - 1] = authored[line - 1] ?? ""
        })
        root = parseMdx(lines.join("\n")) ?? probe
    } else {
        root = remark().use(remarkGfm).parse(body)
    }
    const definitions = new Map<string, { url: string; title?: string }>()
    visit(root, "definition", (node) => {
        if (!definitions.has(node.identifier)) {
            definitions.set(node.identifier, {
                url: node.url,
                ...(node.title != null ? { title: node.title } : {}),
            })
        }
    })
    visit(root, (node, index, parent) => {
        if (node.type === "link") {
            // Authored internal links keep their .mdx/.md source extension —
            // the ingest pipeline's remarkRebaseRootLinks strips it for the
            // human render; mirror that so PDF links hit the human page
            // instead of a dead .mdx slug or the agent .md response.
            if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(node.url)) {
                node.url = node.url.replace(/\.mdx?(?=$|[?#])/i, "")
                // Relative links resolve SOURCE-relative (the repo's
                // canonical file-system semantics, same as ingest's rebase)
                // and root themselves so the exported link is unambiguous
                // regardless of the served URL's trailing-slash spelling.
                if (
                    sourcePath &&
                    !node.url.startsWith("/") &&
                    !node.url.startsWith("#")
                ) {
                    const suffixIndex = node.url.search(/[?#]/)
                    const pathPart =
                        suffixIndex === -1
                            ? node.url
                            : node.url.slice(0, suffixIndex)
                    const suffix =
                        suffixIndex === -1 ? "" : node.url.slice(suffixIndex)
                    const joined = posix.normalize(
                        posix.join(posix.dirname(sourcePath), pathPart),
                    )
                    if (joined !== "" && !joined.startsWith("../"))
                        node.url = `/${joined === "." ? "" : joined}${suffix}`
                }
            }
            return
        }
        // docs.json variables were resolved at ingest, once, in prose and
        // code (docs_page.source is the resolved rendition); resolving again
        // here would expand a value that itself reads `{{name}}`.
        if (parent === undefined || index === undefined) return
        // A one-line component (<ParamField … required>The id.</ParamField>)
        // parses as a paragraph holding a text element; lift it to a block
        // so it gets the same bold label as its multi-line spelling.
        const [only] = node.type === "paragraph" ? node.children : []
        if (
            node.type === "paragraph" &&
            node.children.length === 1 &&
            only?.type === "mdxJsxTextElement" &&
            only.name !== null &&
            !["br", "img", "Snippet"].includes(only.name)
        ) {
            parent.children.splice(index, 1, {
                type: "mdxJsxFlowElement",
                name: only.name,
                attributes: only.attributes,
                children: [{ type: "paragraph", children: only.children }],
            })
            return index
        }
        // `{{name}}` is a docs variable; a static literal (`{"2.4.1"}`,
        // `{3}`) prints its value as the human page does; every other
        // expression (comments, JS, values React renders as nothing) and
        // ESM import/export drops.
        if (
            node.type === "mdxjsEsm" ||
            node.type === "mdxFlowExpression" ||
            node.type === "mdxTextExpression"
        ) {
            const variable =
                node.type === "mdxjsEsm"
                    ? null
                    : /^\{([A-Za-z0-9_.-]+)\}$/.exec(node.value.trim())?.[1]
            const [statement, ...rest] =
                node.type === "mdxjsEsm" ? [] : (node.data?.estree?.body ?? [])
            const literal =
                statement?.type === "ExpressionStatement" && rest.length === 0
                    ? evaluateStaticMdxExpression(statement.expression)
                    : null
            const text = variable
                ? `{{${variable}}}`
                : literal?.ok &&
                    (typeof literal.value === "string" ||
                        typeof literal.value === "number")
                  ? String(literal.value)
                  : null
            if (text === null) {
                parent.children.splice(index, 1)
                return index
            }
            parent.children.splice(
                index,
                1,
                node.type === "mdxFlowExpression"
                    ? {
                          type: "paragraph",
                          children: [{ type: "text", value: text }],
                      }
                    : { type: "text", value: text },
            )
            return
        }
        if (
            (node.type === "mdxJsxFlowElement" ||
                node.type === "mdxJsxTextElement") &&
            (node.name === "Snippet" || node.name === "img")
        ) {
            const attribute = (name: string) => {
                const value = node.attributes.find(
                    (entry) =>
                        entry.type === "mdxJsxAttribute" && entry.name === name,
                )?.value
                return typeof value === "string" ? value : null
            }
            const src = attribute("src")
            const inline: PhrasingContent =
                node.name === "Snippet"
                    ? {
                          type: "emphasis",
                          children: [
                              {
                                  type: "text",
                                  value: `[transcluded snippet omitted: ${attribute("file") ?? "snippet"}]`,
                              },
                          ],
                      }
                    : src
                      ? { type: "image", url: src, alt: attribute("alt") }
                      : { type: "text", value: attribute("alt") ?? "" }
            parent.children.splice(
                index,
                1,
                node.type === "mdxJsxFlowElement"
                    ? { type: "paragraph", children: [inline] }
                    : inline,
            )
            return
        }
        // <Snippet file> transclusion expands at ingest for the human page,
        // but the authored source keeps only the directive — until PDFs can
        // read an ingest-stored human rendition, mark the omission visibly
        // instead of silently dropping the section with its tag.
        if (node.type === "html" && /<Snippet\b/i.test(node.value)) {
            const file = /\bfile\s*=\s*["']([^"']+)["']/i.exec(node.value)?.[1]
            parent.children.splice(index, 1, {
                type: "emphasis",
                children: [
                    {
                        type: "text",
                        value: `[transcluded snippet omitted: ${file ?? "snippet"}]`,
                    },
                ],
            })
            return
        }
        // MDX/HTML-authored images (<img src="…" alt="…"/>) arrive as raw
        // html nodes under plain remark — surface them as real image nodes
        // so they embed (and collect in imageUrls) instead of being
        // stripped with their tag.
        if (node.type === "html" && /<img\b/i.test(node.value)) {
            const parts: Array<
                | { kind: "text"; value: string }
                | { kind: "image"; url: string; alt: string | null }
            > = []
            let last = 0
            for (const match of node.value.matchAll(/<img\b[^>]*>/gi)) {
                const before = node.value.slice(last, match.index)
                if (before.trim()) parts.push({ kind: "text", value: before })
                const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1]
                const alt =
                    /\balt\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? null
                if (src) parts.push({ kind: "image", url: src, alt })
                last = match.index + match[0].length
            }
            const tail = node.value.slice(last)
            if (tail.trim()) parts.push({ kind: "text", value: tail })
            if (!parts.some((part) => part.kind === "image")) return
            if (
                parent.type === "root" ||
                parent.type === "blockquote" ||
                parent.type === "listItem"
            ) {
                parent.children.splice(
                    index,
                    1,
                    ...parts.map(
                        (part): RootContent =>
                            part.kind === "image"
                                ? {
                                      type: "paragraph",
                                      children: [
                                          {
                                              type: "image",
                                              url: part.url,
                                              alt: part.alt,
                                          },
                                      ],
                                  }
                                : { type: "html", value: part.value },
                    ),
                )
                return index + parts.length
            }
            if (parent.type === "paragraph") {
                parent.children.splice(
                    index,
                    1,
                    ...parts.map(
                        (part): PhrasingContent =>
                            part.kind === "image"
                                ? {
                                      type: "image",
                                      url: part.url,
                                      alt: part.alt,
                                  }
                                : { type: "html", value: part.value },
                    ),
                )
                return index + parts.length
            }
            return
        }
        if (node.type === "imageReference") {
            const definition = definitions.get(node.identifier)
            parent.children.splice(
                index,
                1,
                definition
                    ? {
                          type: "image",
                          url: definition.url,
                          alt: node.alt ?? null,
                      }
                    : { type: "text", value: node.alt ?? "" },
            )
            return
        }
        if (node.type === "linkReference") {
            const definition = definitions.get(node.identifier)
            if (definition) {
                parent.children.splice(index, 1, {
                    type: "link",
                    // The inserted node is not revisited — apply the same
                    // internal-link extension strip direct links get above.
                    url: /^[a-z][a-z0-9+.-]*:|^\/\//i.test(definition.url)
                        ? definition.url
                        : definition.url.replace(/\.mdx?(?=$|[?#])/i, ""),
                    children: node.children,
                })
            } else {
                // No definition — keep the visible text, drop the ref.
                parent.children.splice(index, 1, ...node.children)
            }
        }
    })
    return root
}

/**
 * The standard 14 PDF fonts cover WinAnsi (cp1252) only — pdfkit renders
 * anything else as MOJIBAKE (wrong glyphs, not blanks; verified: "Привет" →
 * "@825B"). Substitute unrenderable codepoints with a visible '·' marker so
 * exotic text degrades honestly instead of misleadingly. Newline/tab pass
 * through (code blocks); NBSP is Latin-1 and survives (indentation).
 */
const CP1252_EXTRAS = new Set(
    "\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178",
)
function sanitizeWinAnsi(value: string): string {
    let out = ""
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0
        out +=
            (code >= 0x20 && code <= 0x7e) ||
            code === 0x0a ||
            code === 0x09 ||
            (code >= 0xa0 && code <= 0xff) ||
            CP1252_EXTRAS.has(char)
                ? char
                : "·"
    }
    return out
}

/** Every distinct image URL authored in the tree — the route resolves these
 * against version-scoped docs_asset rows before rendering. */
export function imageUrls(root: Root): string[] {
    const urls = new Set<string>()
    visit(root, "image", (node) => {
        urls.add(node.url)
    })
    return [...urls]
}

/**
 * Split a page's image references for the route's asset lookups: ingest-
 * rewritten /_assets hashes resolve directly; authored local paths resolve
 * with ingest's resolveAssetReference math (root-relative strips the slash,
 * page-relative resolves against the source file's directory); externals
 * are excluded entirely — the PDF path never fetches a site URL.
 */
export function splitImageReferences(
    root: Root,
    sourcePath: string,
): { hashByUrl: Map<string, string>; pathByUrl: Map<string, string> } {
    const hashByUrl = new Map<string, string>()
    const pathByUrl = new Map<string, string>()
    for (const url of imageUrls(root)) {
        const hash = /^\/_assets\/([a-f\d]{64})/i.exec(url)?.[1]
        if (hash) {
            hashByUrl.set(url, hash.toLowerCase())
            continue
        }
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) continue // external
        const pathname = url.split(/[?#]/)[0] ?? ""
        pathByUrl.set(
            url,
            posix.normalize(
                pathname.startsWith("/")
                    ? pathname.slice(1)
                    : posix.join(posix.dirname(sourcePath), pathname),
            ),
        )
    }
    return { hashByUrl, pathByUrl }
}

/** fumadocs custom-anchor suffix on processed headings ("Title [#id]") —
 * an agent affordance the human PDF strips. */
const HEADING_ANCHOR = /\s*(?:\[#[^\]]+\]|\{#[^}]+\})\s*$/

function stripHeadingAnchor(nodes: PhrasingContent[]): PhrasingContent[] {
    const last = nodes[nodes.length - 1]
    if (last?.type !== "text" || !HEADING_ANCHOR.test(last.value)) return nodes
    const value = last.value.replace(HEADING_ANCHOR, "")
    return [...nodes.slice(0, -1), ...(value ? [{ ...last, value }] : [])]
}

function inlineFont(bold: boolean, italic: boolean): string {
    if (bold && italic) return "Helvetica-BoldOblique"
    if (bold) return "Helvetica-Bold"
    if (italic) return "Helvetica-Oblique"
    return "Helvetica"
}

/** Plain-text fallback for node types without a dedicated mapping. */
function textOf(node: {
    value?: unknown
    children?: unknown
    type?: string
}): string {
    if (node.type === "html" && typeof node.value === "string") {
        // Attribute-driven components (<Card title description/>) carry
        // their only human-visible data IN the attributes — surface those
        // before dropping the tags.
        const attributeText = [
            ...node.value.matchAll(
                /\b(?:title|description|alt|label)\s*=\s*["']([^"']+)["']/gi,
            ),
        ]
            .map((match) => match[1])
            .join(" — ")
        const bodyText = node.value
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        return [attributeText, bodyText].filter(Boolean).join(" ")
    }
    if (typeof node.value === "string") return node.value
    if (Array.isArray(node.children)) {
        return node.children
            .map((child) =>
                typeof child === "object" && child !== null
                    ? textOf(child)
                    : "",
            )
            .join("")
    }
    return ""
}

/** Alt text (+ URL for external references) — the never-fetch degradation. */
function ImageFallback({
    alt,
    url,
    index,
}: {
    alt: string | null | undefined
    url: string
    index: number
}) {
    const external = /^(?:https?:)?\/\//i.test(url)
    const label = alt?.trim() ? alt.trim() : "Image"
    return (
        <Text key={index} style={styles.imageFallback}>
            {sanitizeWinAnsi(
                `[${label}${external ? `: ${url.startsWith("//") ? `https:${url}` : url}` : ""}]`,
            )}
        </Text>
    )
}

function InlineNodes({
    nodes,
    images,
    baseUrl,
    bold = false,
    italic = false,
}: {
    nodes: PhrasingContent[]
    images: ReadonlyMap<string, string>
    baseUrl: string
    bold?: boolean
    italic?: boolean
}) {
    return (
        <>
            {nodes.map((node, index): ReactNode => {
                switch (node.type) {
                    case "text":
                        return (
                            <Text
                                key={index}
                                style={{ fontFamily: inlineFont(bold, italic) }}
                            >
                                {sanitizeWinAnsi(node.value)}
                            </Text>
                        )
                    case "strong":
                        return (
                            <InlineNodes
                                key={index}
                                nodes={node.children}
                                images={images}
                                baseUrl={baseUrl}
                                bold
                                italic={italic}
                            />
                        )
                    case "emphasis":
                        return (
                            <InlineNodes
                                key={index}
                                nodes={node.children}
                                images={images}
                                baseUrl={baseUrl}
                                bold={bold}
                                italic
                            />
                        )
                    case "delete":
                        return (
                            <Text
                                key={index}
                                style={{ textDecoration: "line-through" }}
                            >
                                <InlineNodes
                                    nodes={node.children}
                                    images={images}
                                    baseUrl={baseUrl}
                                    bold={bold}
                                    italic={italic}
                                />
                            </Text>
                        )
                    case "link": {
                        // Relative docs links resolve against the canonical
                        // page URL so they stay clickable outside the site;
                        // external links additionally SHOW their target (a
                        // printed page has no hover).
                        const external = /^https?:\/\//i.test(node.url)
                        const href = (() => {
                            try {
                                // Stored links are root-relative: under a
                                // base path they get it first.
                                return new URL(withBase(node.url), baseUrl).href
                            } catch {
                                return node.url
                            }
                        })()
                        return (
                            <Text key={index}>
                                <Link
                                    src={href}
                                    style={{
                                        color: INK,
                                        textDecoration: "underline",
                                    }}
                                >
                                    <InlineNodes
                                        nodes={node.children}
                                        images={images}
                                        baseUrl={baseUrl}
                                        bold={bold}
                                        italic={italic}
                                    />
                                </Link>
                                {external ? (
                                    <Text
                                        style={{
                                            color: MUTED,
                                            fontSize: 8,
                                        }}
                                    >
                                        {sanitizeWinAnsi(` (${node.url})`)}
                                    </Text>
                                ) : null}
                            </Text>
                        )
                    }
                    case "inlineCode":
                        return (
                            <Text
                                key={index}
                                style={{ fontFamily: "Courier", fontSize: 8.5 }}
                            >
                                {sanitizeWinAnsi(node.value)}
                            </Text>
                        )
                    case "break":
                        return "\n"
                    case "mdxJsxTextElement":
                        // Inline components (<Badge>, <Tooltip>, <br />)
                        // print their content, never their tags.
                        return node.name === "br" ? (
                            "\n"
                        ) : (
                            <InlineNodes
                                key={index}
                                nodes={node.children}
                                images={images}
                                baseUrl={baseUrl}
                                bold={bold}
                                italic={italic}
                            />
                        )
                    case "image":
                        // Inline (text-adjacent) images can't nest an Image
                        // inside Text — degrade to the alt-text fallback.
                        // Standalone images render as blocks in BlockNodes.
                        return (
                            <Text key={index} style={{ color: MUTED }}>
                                {node.alt?.trim()
                                    ? sanitizeWinAnsi(`[${node.alt.trim()}]`)
                                    : ""}
                            </Text>
                        )
                    default: {
                        const text = textOf(node)
                        return text ? (
                            <Text key={index}>{sanitizeWinAnsi(text)}</Text>
                        ) : null
                    }
                }
            })}
        </>
    )
}

function BlockNodes({
    nodes,
    images,
    baseUrl,
    depth = 0,
}: {
    nodes: RootContent[]
    images: ReadonlyMap<string, string>
    baseUrl: string
    depth?: number
}) {
    return (
        <>
            {nodes.map((node, index): ReactNode => {
                switch (node.type) {
                    case "heading":
                        return (
                            <View key={index} minPresenceAhead={48}>
                                <Text
                                    style={[
                                        styles.heading,
                                        {
                                            fontSize:
                                                HEADING_SIZE[node.depth] ?? 9.5,
                                        },
                                    ]}
                                >
                                    <InlineNodes
                                        nodes={stripHeadingAnchor(
                                            node.children,
                                        )}
                                        images={images}
                                        baseUrl={baseUrl}
                                        bold
                                    />
                                </Text>
                            </View>
                        )
                    case "paragraph": {
                        // A standalone image paragraph renders as a block
                        // image (embedded when the route resolved it) —
                        // everything else stays a text paragraph.
                        const only =
                            node.children.length === 1 ? node.children[0] : null
                        if (only?.type === "image") {
                            const src = images.get(only.url)
                            return src ? (
                                <Image
                                    key={index}
                                    src={src}
                                    style={styles.image}
                                />
                            ) : (
                                <ImageFallback
                                    key={index}
                                    alt={only.alt}
                                    url={only.url}
                                    index={index}
                                />
                            )
                        }
                        return (
                            <Text key={index} style={styles.paragraph}>
                                <InlineNodes
                                    nodes={node.children}
                                    images={images}
                                    baseUrl={baseUrl}
                                />
                            </Text>
                        )
                    }
                    case "list": {
                        const start = node.start ?? 1
                        return (
                            <View
                                key={index}
                                style={{
                                    marginBottom: depth === 0 ? 7 : 0,
                                    marginTop: 2,
                                }}
                            >
                                {node.children.map((item, itemIndex) => (
                                    <View
                                        key={itemIndex}
                                        style={styles.listRow}
                                    >
                                        <Text style={styles.listMarker}>
                                            {/* GFM task-list items surface
                                                their checked state. */}
                                            {item.checked === true
                                                ? "[x]"
                                                : item.checked === false
                                                  ? "[ ]"
                                                  : node.ordered
                                                    ? `${start + itemIndex}.`
                                                    : "•"}
                                        </Text>
                                        <View style={styles.listBody}>
                                            <BlockNodes
                                                nodes={item.children}
                                                images={images}
                                                baseUrl={baseUrl}
                                                depth={depth + 1}
                                            />
                                        </View>
                                    </View>
                                ))}
                            </View>
                        )
                    }
                    case "blockquote":
                        return (
                            <View key={index} style={styles.blockquote}>
                                <BlockNodes
                                    nodes={node.children}
                                    images={images}
                                    baseUrl={baseUrl}
                                    depth={depth}
                                />
                            </View>
                        )
                    case "code":
                        return (
                            <View key={index} style={styles.codeBlock}>
                                {/* react-pdf collapses space runs inside Text,
                                    flattening indentation — pin each line's
                                    LEADING whitespace with no-break spaces
                                    (interior spaces stay wrappable). */}
                                <Text>
                                    {sanitizeWinAnsi(node.value)
                                        .split("\n")
                                        .map((line) =>
                                            line.replace(/^[\t ]+/, (lead) =>
                                                " ".repeat(
                                                    lead.replace(/\t/g, "    ")
                                                        .length,
                                                ),
                                            ),
                                        )
                                        .join("\n")}
                                </Text>
                            </View>
                        )
                    case "thematicBreak":
                        return <View key={index} style={styles.rule} />
                    case "mdxJsxFlowElement": {
                        // Components print as their content: the visible
                        // label (Step/Tab/Accordion/Card title, Update
                        // label, a field's name and type) as a bold lead
                        // line, then the children as ordinary blocks.
                        const attributes = new Map<string, string | true>()
                        for (const attribute of node.attributes) {
                            if (attribute.type !== "mdxJsxAttribute") continue
                            if (typeof attribute.value === "string")
                                attributes.set(attribute.name, attribute.value)
                            else if (
                                attribute.value === null ||
                                attribute.value === undefined
                            )
                                attributes.set(attribute.name, true)
                            else {
                                // Literal expressions ingest admits
                                // (title={"Log in"}, required={true}) render
                                // on the HTML page — read them the same way.
                                const statement =
                                    attribute.value.data?.estree?.body[0]
                                const evaluated =
                                    statement?.type === "ExpressionStatement"
                                        ? evaluateStaticMdxExpression(
                                              statement.expression,
                                          )
                                        : null
                                if (
                                    evaluated?.ok &&
                                    (typeof evaluated.value === "string" ||
                                        typeof evaluated.value === "number")
                                )
                                    attributes.set(
                                        attribute.name,
                                        String(evaluated.value),
                                    )
                                else if (
                                    evaluated?.ok &&
                                    evaluated.value === true
                                )
                                    attributes.set(attribute.name, true)
                            }
                        }
                        const text = (name: string) => {
                            const value = attributes.get(name)
                            return typeof value === "string" ? value : null
                        }
                        // ParamField's own precedence (components/mdx.tsx).
                        const field = [
                            "path",
                            "query",
                            "body",
                            "header",
                            "name",
                            "cookie",
                        ]
                            .map(text)
                            .find((value) => value !== null)
                        const label =
                            text("title") ??
                            text("label") ??
                            (field
                                ? [
                                      field,
                                      text("type"),
                                      attributes.has("required")
                                          ? "required"
                                          : null,
                                      attributes.has("deprecated")
                                          ? "deprecated"
                                          : null,
                                  ]
                                      .filter(Boolean)
                                      .join(" · ")
                                : null)
                        const description = text("description")
                        return (
                            <View key={index}>
                                {label ? (
                                    <Text
                                        style={[
                                            styles.paragraph,
                                            { fontFamily: "Helvetica-Bold" },
                                        ]}
                                    >
                                        {sanitizeWinAnsi(label)}
                                    </Text>
                                ) : null}
                                {description ? (
                                    <Text style={styles.paragraph}>
                                        {sanitizeWinAnsi(description)}
                                    </Text>
                                ) : null}
                                <BlockNodes
                                    nodes={node.children}
                                    images={images}
                                    baseUrl={baseUrl}
                                    depth={depth}
                                />
                            </View>
                        )
                    }
                    case "table":
                        return (
                            <View key={index} style={{ marginBottom: 7 }}>
                                {node.children.map((row, rowIndex) => (
                                    <View
                                        key={rowIndex}
                                        style={[
                                            styles.tableRow,
                                            rowIndex === 0
                                                ? {
                                                      borderBottomWidth: 1,
                                                      borderBottomColor: INK,
                                                  }
                                                : {},
                                        ]}
                                    >
                                        {row.children.map((cell, cellIndex) => (
                                            <Text
                                                key={cellIndex}
                                                style={styles.tableCell}
                                            >
                                                <InlineNodes
                                                    nodes={cell.children}
                                                    images={images}
                                                    baseUrl={baseUrl}
                                                    bold={rowIndex === 0}
                                                />
                                            </Text>
                                        ))}
                                    </View>
                                ))}
                            </View>
                        )
                    default: {
                        // Unknown/JSX-ish nodes (raw html, definitions, …)
                        // render their text content, never their markup.
                        const text = textOf(node)
                        return text ? (
                            <Text key={index} style={styles.paragraph}>
                                {sanitizeWinAnsi(text)}
                            </Text>
                        ) : null
                    }
                }
            })}
        </>
    )
}

/**
 * Render one docs page as a letter-sized PDF: title, canonical-URL subtitle,
 * then the mapped body, paginating naturally with a fixed footer.
 */
export async function renderPagePdf(input: {
    /** Page H1 / PDF metadata title. */
    title: string
    /** Canonical absolute page URL — subtitle line + relative-link base. */
    url: string
    root: Root
    /** Authored image URL → embeddable src (data URI of a version-scoped
     * asset row's inline bytes, or our own blob-store URL). URLs missing
     * from the map render as alt text — nothing else is ever fetched. */
    images: ReadonlyMap<string, string>
}): Promise<Uint8Array<ArrayBuffer>> {
    // Some pages author their own leading H1 (the processed markdown keeps
    // it) — the PDF header already renders the title, so an identical
    // opening heading would print twice.
    const first = input.root.children[0]
    const blocks =
        first?.type === "heading" &&
        first.depth === 1 &&
        textOf(first).replace(HEADING_ANCHOR, "").trim() === input.title.trim()
            ? input.root.children.slice(1)
            : input.root.children
    const title = sanitizeWinAnsi(input.title)
    const buffer = await renderToBuffer(
        <Document title={input.title}>
            <Page size="LETTER" style={styles.page}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.subtitle}>
                    {sanitizeWinAnsi(input.url)}
                </Text>
                <View style={styles.titleRule} />
                <BlockNodes
                    nodes={blocks}
                    images={input.images}
                    baseUrl={input.url}
                />
                <View style={styles.footer} fixed>
                    <Text style={styles.footerText}>{title}</Text>
                    <Text
                        style={styles.footerText}
                        render={({ pageNumber, totalPages }) =>
                            `Page ${pageNumber} of ${totalPages}`
                        }
                    />
                </View>
            </Page>
        </Document>,
    )
    // Copy into a fresh ArrayBuffer-backed view: Buffer is typed over
    // ArrayBufferLike, which BodyInit refuses.
    const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength))
    bytes.set(buffer)
    return bytes
}
