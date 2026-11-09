/**
 * Resolve icons during ingest so compiled browser content needs no icon
 * dataset. Sidebar names resolve through the same map in the serving app.
 */

import type { RehypeCodeOptions } from "fumadocs-core/mdx-plugins"
import type { Root } from "mdast"
import { visit } from "unist-util-visit"
import type { Diagnostic, IconLibrary } from "../types/docs"
import { DOCS_DEFAULT_ICON_SVG, resolveDocsIconSvg } from "../types/docs-icons"

/** Shiki transformer shape, taken from the options we already pass. */
type CodeTransformer = NonNullable<RehypeCodeOptions["transformers"]>[number]

/**
 * Rewrite literal `icon="name"` JSX attributes (Card, CardGroup, …) to the
 * resolved SVG. Asset paths and URLs pass through untouched — the asset
 * rewriter has already hashed repo-relative ones, and components render those
 * as images. Unknown names get the default glyph + a warn diagnostic (spec
 * §icons: never silently nothing).
 */
export function remarkResolveIconAttributes(input: {
    path: string
    library: IconLibrary
    diagnostics: Diagnostic[]
}) {
    return () => (tree: Root) => {
        visit(tree, (node) => {
            if (
                node.type !== "mdxJsxFlowElement" &&
                node.type !== "mdxJsxTextElement"
            )
                return
            for (const attribute of node.attributes) {
                if (
                    attribute.type !== "mdxJsxAttribute" ||
                    attribute.name !== "icon" ||
                    typeof attribute.value !== "string"
                )
                    continue
                const value = attribute.value.trim()
                // Inline markup is never an authorable icon (names, asset
                // paths, and URLs are the only forms) — passing it through
                // would flow tenant markup into the runtime's trusted-SVG
                // sink (dangerouslySetInnerHTML). Within this single pass a
                // "<"-leading value can only be authored: resolution below
                // sets-and-continues, never revisits.
                if (value.startsWith("<")) {
                    attribute.value = DOCS_DEFAULT_ICON_SVG
                    input.diagnostics.push({
                        code: "icon_unresolved",
                        severity: "warn",
                        message:
                            "Inline markup is not a valid icon value; the default glyph was used.",
                        path: input.path,
                    })
                    continue
                }
                if (value.startsWith("/") || /^https?:\/\//i.test(value))
                    continue
                const svg = resolveDocsIconSvg(value)
                if (svg) {
                    attribute.value = svg
                    continue
                }
                attribute.value = DOCS_DEFAULT_ICON_SVG
                input.diagnostics.push({
                    code: "icon_unresolved",
                    severity: "warn",
                    message: `Icon "${value}" is not a known ${input.library} icon name; the default glyph was used.`,
                    path: input.path,
                })
            }
        })
    }
}

/**
 * Honor authored code-fence `icon="…"` meta, which fumadocs' attribute
 * allowlist drops: named icons resolve to Hugeicons SVG; asset paths resolve
 * through the snapshot's content hashes and render as an image. Runs after
 * fumadocs' transformerIcon, overriding its language-derived brand icon.
 */
export function transformerAuthoredIcon(input: {
    assetHashes: ReadonlyMap<string, string>
}): CodeTransformer {
    return {
        name: "docs:authored-icon",
        // `root`, not `pre`: rehypeCode appends its language-derived
        // transformerIcon AFTER user transformers, and `pre` hooks run in
        // array order — root hooks run after every pre hook, so the authored
        // icon reliably wins.
        root(root) {
            const raw = this.options.meta?.__raw
            const match = raw ? /\bicon="([^"]+)"/.exec(raw) : null
            if (!match?.[1]) return root
            const value = match[1].trim()
            // Image icons need explicit dimensions: the CodeBlock icon slot
            // sizes only `svg` children ([&_svg]:size-3.5), so a bare <img>
            // renders at intrinsic size — 512px logos painted over the code.
            const img = (src: string) =>
                `<img src="${src}" alt="" width="14" height="14" style="width:14px;height:14px;object-fit:contain"/>`
            let icon: string | null = null
            if (value.startsWith("/_assets/")) {
                icon = img(value)
            } else if (value.startsWith("/")) {
                const hash = input.assetHashes.get(value.replace(/^\//, ""))
                if (hash) icon = img(`/_assets/${hash}`)
            } else {
                icon = resolveDocsIconSvg(value)
            }
            if (!icon) return root
            for (const node of root.children) {
                if (
                    node.type === "element" &&
                    node.tagName === "pre" &&
                    node.properties
                ) {
                    node.properties.icon = icon
                }
            }
            return root
        },
    }
}

/**
 * Flag terminal fences with data-terminal for the dimmed $ prompt.
 * Only an explicit terminal label qualifies: bare meta, title=/tab=, or the
 * bare marker remarkCodeGroupTabs restores after tab promotion. Plain sh/bash
 * fences must keep their authored commands without an added prompt.
 */
export function transformerTerminalPrompt(): CodeTransformer {
    return {
        name: "docs:terminal-prompt",
        root(root) {
            const raw = this.options.meta?.__raw ?? ""
            const labeled = /(?:^|\s|=")terminal(?:"|\s|$)/i.test(raw)
            if (!labeled) return root
            for (const node of root.children) {
                if (
                    node.type === "element" &&
                    node.tagName === "pre" &&
                    node.properties
                ) {
                    node.properties["data-terminal"] = ""
                }
            }
            return root
        },
    }
}

/**
 * Fence brace metadata (` ```ts {1,3-5}`) maps to shiki highlighted line
 * classes. fumadocs' default transformers read only [!code highlight] comments,
 * so parse authored ranges too. remarkCodeGroupTabs keeps the brace token.
 */
export function transformerMetaHighlight(): CodeTransformer {
    return {
        name: "docs:meta-highlight",
        line(node, line) {
            const raw = this.options.meta?.__raw ?? ""
            const match = /(?:^|\s)\{([\d,\s-]+)\}(?=\s|$)/.exec(raw)
            if (!match?.[1]) return
            for (const part of match[1].split(",")) {
                const range = part.trim()
                if (!range) continue
                const [startRaw, endRaw] = range.split("-")
                const start = Number(startRaw)
                if (!Number.isFinite(start)) continue
                const end = endRaw === undefined ? start : Number(endRaw)
                if (Number.isFinite(end) && line >= start && line <= end) {
                    this.addClassToHast(node, "highlighted")
                    return
                }
            }
        },
    }
}

/**
 * The `wrap` fence modifier (kept as a bare meta token by
 * remarkCodeGroupTabs) → `data-wrap` on the pre; app.css soft-wraps the
 * lines instead of horizontal scrolling.
 */
export function transformerWrapCode(): CodeTransformer {
    return {
        name: "docs:wrap",
        root(root) {
            const raw = this.options.meta?.__raw ?? ""
            if (!/(?:^|\s)wrap(?:\s|$)/i.test(raw)) return root
            for (const node of root.children) {
                if (
                    node.type === "element" &&
                    node.tagName === "pre" &&
                    node.properties
                ) {
                    node.properties["data-wrap"] = ""
                }
            }
            return root
        },
    }
}

/**
 * The `lines` fence modifier → `data-line-numbers` on the pre;
 * fumadocs' shiki.css renders the CSS-counter line numbers.
 */
export function transformerLineNumbers(): CodeTransformer {
    return {
        name: "docs:line-numbers",
        root(root) {
            const raw = this.options.meta?.__raw ?? ""
            if (!/(?:^|\s)lines(?:\s|$)/i.test(raw)) return root
            for (const node of root.children) {
                if (
                    node.type === "element" &&
                    node.tagName === "pre" &&
                    node.properties
                ) {
                    node.properties["data-line-numbers"] = ""
                }
            }
            return root
        },
    }
}

/**
 * Flag fences carrying the `expandable` modifier (kept as a bare meta
 * token by remarkCodeGroupTabs) with `data-expandable` so the framework can
 * render the collapsed "Show all N lines" treatment instead of leaking the
 * word into the title.
 */
export function transformerExpandableCode(): CodeTransformer {
    return {
        name: "docs:expandable",
        root(root) {
            const raw = this.options.meta?.__raw ?? ""
            if (!/(?:^|\s)expandable(?:\s|$)/i.test(raw)) return root
            for (const node of root.children) {
                if (
                    node.type === "element" &&
                    node.tagName === "pre" &&
                    node.properties
                ) {
                    node.properties["data-expandable"] = ""
                }
            }
            return root
        },
    }
}
