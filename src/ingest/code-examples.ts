import type { Root, RootContent } from "mdast"
import type { DocsCodeExample } from "../types/docs"

// JSX containers whose child code blocks are alternatives, not a sequence.
// ViewGroup is the ingest-synthesized wrapper around consecutive <View>
// variations (remark-view-groups.ts) — an agent should follow ONE view, so
// its code blocks group like a Tabs group rather than reading as a sequence.
const ALT_CONTAINERS = new Set([
    "CodeBlockTabs",
    "Tabs",
    "CodeGroup",
    "CodeTabs",
    "ViewGroup",
])

function parseTitle(meta: string | null | undefined): string | undefined {
    if (!meta) return undefined
    const quoted =
        meta.match(/title="([^"]+)"/) ?? meta.match(/title='([^']+)'/)
    if (quoted) return quoted[1]
    const bare = meta.match(/(?:^|\s)title=([^\s]+)/)
    return bare ? bare[1] : undefined
}

/**
 * AST-native code-example extraction over the fully-transformed page MDAST —
 * never a line scanner, so a stray fence in prose can't desync it. Runs ONCE
 * at ingest; the result is stored per page (docs_page.code_examples) and
 * read verbatim by the framework's MCP get_code_examples tool and agent
 * context bundle. `runnable` is deliberately NOT emitted (it would be an
 * unvalidated author claim).
 */
export function extractCodeExamplesFromMdast(mdast: Root): DocsCodeExample[] {
    const out: DocsCodeExample[] = []
    let nextGroup = 0

    const walk = (node: Root | RootContent, group: number | undefined) => {
        let currentGroup = group
        const isAltContainer =
            (node.type === "mdxJsxFlowElement" ||
                node.type === "mdxJsxTextElement") &&
            typeof node.name === "string" &&
            ALT_CONTAINERS.has(node.name)
        if (isAltContainer && currentGroup === undefined)
            currentGroup = nextGroup++

        if (node.type === "code") {
            out.push({
                language: node.lang ?? "text",
                title: parseTitle(node.meta),
                meta: node.meta ?? undefined,
                code: node.value,
                alternativesGroup: currentGroup,
            })
            return
        }

        if ("children" in node)
            for (const child of node.children) walk(child, currentGroup)
    }

    walk(mdast, undefined)
    return out
}
