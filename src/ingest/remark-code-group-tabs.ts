import type { Root } from "mdast"
import { visit } from "unist-util-visit"

/**
 * Normalize authored fence labels before fumadocs groups code tabs. Explicit
 * `tab=` wins, then `title=`, bare meta, and language; duplicate labels get
 * suffixes so tab triggers remain distinct. Standalone fences promote bare
 * labels to `title=`.
 */
export function remarkCodeGroupTabs() {
    return (tree: Root) => {
        visit(tree, "code", (node, _index, parent) => {
            if (
                parent?.type === "mdxJsxFlowElement" &&
                parent.name === "CodeGroup"
            )
                return
            if (!node.meta) return
            const tokens = tokenizeMeta(node.meta)
            if (
                tokens.some(
                    (token) =>
                        token.startsWith("title=") || token.startsWith("tab="),
                )
            )
                return
            // Brace tokens are shiki meta ({1,3} line ranges), not labels;
            // Fence modifier tokens (expandable, wrap, lines) are display
            // flags, not labels — they stay in the meta string so the rehype
            // transformers can read them from __raw.
            const bare = tokens.filter(
                (token) =>
                    !token.includes("=") &&
                    !/^\{.*\}$/.test(token) &&
                    !MODIFIER_TOKEN.test(token),
            )
            if (bare.length === 0) return
            const label = bare.join(" ")
            for (const token of bare) {
                tokens.splice(tokens.indexOf(token), 1)
            }
            tokens.push(`title="${label.replaceAll('"', "")}"`)
            // Keep the bare marker alongside the promoted title= — the
            // title token can be consumed before rehype, and the $-prompt
            // transformer keys on it (same guard as the CodeGroup path).
            if (/^terminal$/i.test(label)) tokens.push("terminal")
            node.meta = tokens.join(" ")
        })
        visit(tree, "mdxJsxFlowElement", (node) => {
            if (node.name !== "CodeGroup") return
            const used = new Map<string, number>()
            for (const child of node.children) {
                if (child.type !== "code") continue
                const tokens = tokenizeMeta(child.meta ?? "")
                const tabIndex = tokens.findIndex((token) =>
                    token.startsWith("tab="),
                )
                if (tabIndex >= 0) {
                    // Authored tab= values are kept, but duplicates within a
                    // group still get suffixed — tab triggers are keyed by
                    // value, so two identical values share one tab state.
                    const existing = readValue(tokens[tabIndex] ?? "")
                    const seen = used.get(existing) ?? 0
                    used.set(existing, seen + 1)
                    if (seen > 0) {
                        tokens[tabIndex] =
                            `tab="${`${existing} ${seen + 1}`.replaceAll('"', "")}"`
                        child.meta = tokens.join(" ")
                    }
                    continue
                }
                let label: string | null = null
                const titleIndex = tokens.findIndex((token) =>
                    token.startsWith("title="),
                )
                if (titleIndex >= 0) {
                    label = readValue(tokens[titleIndex] ?? "")
                    tokens.splice(titleIndex, 1)
                } else {
                    // A bare label can span several tokens
                    // ("Sample response") — join every non key=value token,
                    // skipping display-modifier flags (expandable, wrap…).
                    const bare = tokens.filter(
                        (token) =>
                            !token.includes("=") &&
                            !/^\{.*\}$/.test(token) &&
                            !MODIFIER_TOKEN.test(token),
                    )
                    if (bare.length > 0) {
                        label = bare.join(" ")
                        for (const token of bare) {
                            tokens.splice(tokens.indexOf(token), 1)
                        }
                    }
                }
                label = label || child.lang || "code"
                const seen = used.get(label) ?? 0
                used.set(label, seen + 1)
                if (seen > 0) label = `${label} ${seen + 1}`
                tokens.push(`tab="${label.replaceAll('"', "")}"`)
                // fumadocs' remarkCodeTab consumes the tab= token before
                // rehype, so a "terminal" label would vanish from __raw and
                // the $-prompt transformer would miss it — keep a bare marker.
                if (/^terminal$/i.test(label) && !tokens.includes("terminal"))
                    tokens.push("terminal")
                child.meta = tokens.join(" ")
            }
            // Page-wide (and per-session cross-page) tab sync: stamp a
            // deterministic tab-group derived from the label set so every
            // same-shaped group switches together — the code-language
            // choice is a page-level preference. remarkCodeTab reads tab-group= into data.tabGroup and
            // emits groupId on the generated CodeBlockTabs. Authored
            // tab-group= values win untouched.
            const groupId = [...used.keys()]
                .map((label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
                .sort()
                .join("+")
            if (groupId.length > 0) {
                for (const child of node.children) {
                    if (child.type !== "code") continue
                    const tokens = tokenizeMeta(child.meta ?? "")
                    if (tokens.some((token) => token.startsWith("tab-group=")))
                        continue
                    tokens.push(`tab-group="${groupId}"`)
                    child.meta = tokens.join(" ")
                }
            }
        })
    }
}

/**
 * Fence display modifiers — flags, never part of a title/tab label.
 * They stay in the meta string; the rehype transformers read them from __raw.
 */
const MODIFIER_TOKEN = /^(?:expandable|wrap|lines)$/i

/** Split a fence meta string into tokens, keeping quoted values intact. */
function tokenizeMeta(meta: string): string[] {
    return meta.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
}

/** `key="value"` / `key='value'` / `key=value` → value. */
function readValue(token: string): string {
    const raw = token.slice(token.indexOf("=") + 1)
    return raw.replace(/^["']|["']$/g, "")
}
