import type { Root, RootContent } from "mdast"
import { visit } from "unist-util-visit"

// The mdx node shapes come from the mdast augmentation fumadocs' compiler
// already loads — extract them from the union instead of adding a dep.
type MdxJsxFlowElement = Extract<RootContent, { type: "mdxJsxFlowElement" }>
type MdxJsxTextElement = Extract<RootContent, { type: "mdxJsxTextElement" }>

/** Flow and text elements carry differently-typed children — keep them apart. */
type AgentBlockStash = {
    flow: Map<MdxJsxFlowElement, MdxJsxFlowElement["children"]>
    text: Map<MdxJsxTextElement, MdxJsxTextElement["children"]>
}

/**
 * The audience a JSX element addresses. `<Visibility for="…">` is the
 * canonical Mintlify spelling; `<Agent>`/`<Human>` stay as aliases. A
 * Visibility without a recognized `for` value addresses everyone (null).
 */
function audienceOf(jsx: {
    name?: string | null
    attributes?: Array<{ type: string; name?: string; value?: unknown }>
}): "agents" | "humans" | null {
    if (jsx.name === "Agent") return "agents"
    if (jsx.name === "Human") return "humans"
    if (jsx.name !== "Visibility") return null
    const audience = (jsx.attributes ?? []).find(
        (attribute) =>
            attribute.type === "mdxJsxAttribute" && attribute.name === "for",
    )?.value
    return audience === "agents" || audience === "humans" ? audience : null
}

/**
 * Tags visibility directives for the agent Markdown renderer while preserving
 * nodes for the framework's separate human component map. Both outputs
 * derive from one AST; the plugin now runs during API ingest.
 */
export function remarkAgentBlocks() {
    return (tree: Root) => {
        visit(tree, (node) => {
            if (
                node.type !== "mdxJsxFlowElement" &&
                node.type !== "mdxJsxTextElement"
            )
                return
            const audience = audienceOf(node)
            if (audience === null) return
            // `_stringify` is read by the agent Markdown stringifier; mdast's
            // data types do not declare it, so it is merged in, not typed.
            node.data ??= {}
            Object.assign(node.data, {
                _stringify:
                    audience === "agents" ? "children-only" : { text: "" },
            })
        })
    }
}

/**
 * Detach agent-only children while TOC/search plugins scan the human tree, then
 * restore them before agent Markdown generation. Otherwise hidden headings
 * create dead TOC anchors and search links.
 */
export function createAgentBlockStash(): AgentBlockStash {
    return { flow: new Map(), text: new Map() }
}

export function remarkDetachAgentBlocks(stash: AgentBlockStash) {
    return () => (tree: Root) => {
        visit(tree, (node) => {
            if (
                node.type === "mdxJsxFlowElement" &&
                audienceOf(node) === "agents"
            ) {
                stash.flow.set(node, node.children)
                node.children = []
                return "skip"
            }
            if (
                node.type === "mdxJsxTextElement" &&
                audienceOf(node) === "agents"
            ) {
                stash.text.set(node, node.children)
                node.children = []
                return "skip"
            }
            return
        })
    }
}

export function remarkReattachAgentBlocks(stash: AgentBlockStash) {
    return () => (tree: Root) => {
        if (stash.flow.size === 0 && stash.text.size === 0) return
        visit(tree, (node) => {
            if (node.type === "mdxJsxFlowElement") {
                const original = stash.flow.get(node)
                if (original !== undefined) node.children = original
            } else if (node.type === "mdxJsxTextElement") {
                const original = stash.text.get(node)
                if (original !== undefined) node.children = original
            }
        })
    }
}
