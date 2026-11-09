import type { Paragraph, Root, RootContent } from "mdast"
import { visit } from "unist-util-visit"
import { z } from "zod"
import type { Diagnostic } from "../types/docs"

// mdast parent children arrays are typed per-parent (PhrasingContent[] vs
// RootContent[] vs flow unions), which defeats splicing a synthesized group
// through the visitor's parent union. A View child only ever appears in a
// flow-content parent, so a structural accessor is safe — same shape-check
// idiom as the framework's hastRootSchema.
const flowParentSchema = z.custom<{ children: RootContent[] }>(
    (value) =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray(Reflect.get(value, "children")),
)

// Extracted from the union the compiler's mdast augmentation provides —
// same no-new-dep trick as remark-agent-blocks.ts.
type MdxJsxFlowElement = Extract<RootContent, { type: "mdxJsxFlowElement" }>
type FlowChild = MdxJsxFlowElement["children"][number]

/**
 * Groups consecutive `<View>` siblings into the synthetic
 * `<ViewGroup>` rendered by the framework source. The allowlist strips authored
 * groups, so only this plugin creates them. Injected title labels appear only
 * in agent Markdown; the human selector hides them, and their pipeline order
 * keeps them out of search and the TOC. Missing titles get a deterministic
 * fallback and diagnostic.
 */
export function remarkViewGroups(input: {
    path: string
    diagnostics: Diagnostic[]
    /** Page-local component names (imports/exports) — a page shipping its
     * OWN `View` component owns the name; grouping must not wrap it. */
    moduleScopeNames?: ReadonlySet<string>
}) {
    const titleOf = (view: MdxJsxFlowElement, ordinal: number): string => {
        const attribute = view.attributes.find(
            (candidate) =>
                candidate.type === "mdxJsxAttribute" &&
                candidate.name === "title",
        )
        if (
            attribute?.type === "mdxJsxAttribute" &&
            typeof attribute.value === "string" &&
            attribute.value.trim().length > 0
        )
            return attribute.value
        const fallback = `View ${ordinal}`
        input.diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `<View> requires a literal string "title" attribute; using "${fallback}".`,
            path: input.path,
        })
        // Stamp the fallback (replacing any non-literal title) so the
        // runtime selector and the markdown label stay in lockstep.
        view.attributes = view.attributes.filter(
            (candidate) =>
                candidate.type !== "mdxJsxAttribute" ||
                candidate.name !== "title",
        )
        view.attributes.push({
            type: "mdxJsxAttribute",
            name: "title",
            value: fallback,
        })
        return fallback
    }

    const buildGroup = (views: MdxJsxFlowElement[]): MdxJsxFlowElement => {
        const children: FlowChild[] = []
        for (const [index, view] of views.entries()) {
            const label: Paragraph = {
                type: "paragraph",
                children: [
                    {
                        type: "strong",
                        children: [
                            { type: "text", value: titleOf(view, index + 1) },
                        ],
                    },
                ],
            }
            children.push(label, view)
        }
        return {
            type: "mdxJsxFlowElement",
            name: "ViewGroup",
            attributes: [],
            children,
        }
    }

    return () => (tree: Root) => {
        if (input.moduleScopeNames?.has("View")) return
        // Inline Views (`Choose <View title="A">…</View>` inside prose)
        // parse as mdxJsxTextElement — the grouping below only sees flow
        // elements, so an inline View would reach the runtime ungrouped and
        // render View's block <div> inside a paragraph (invalid nesting,
        // hydration repair). Unwrap it to its children with a warn, the
        // same graceful treatment unknown components get.
        visit(tree, "mdxJsxTextElement", (node, index, parentNode) => {
            if (node.name !== "View") return
            const parent = flowParentSchema.safeParse(parentNode)
            if (!parent.success || typeof index !== "number") return
            input.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    "Inline <View> is not supported and was rendered as its children — author each <View> as its own block to form a selector group.",
                path: input.path,
            })
            parent.data.children.splice(index, 1, ...node.children)
            return index
        })
        visit(tree, (node) => {
            const parent = flowParentSchema.safeParse(node)
            if (!parent.success) return
            // Never regroup inside a group this pass just synthesized — its
            // View children are already exactly one run.
            if (node.type === "mdxJsxFlowElement" && node.name === "ViewGroup")
                return
            const children = parent.data.children
            const hasViewChild = children.some(
                (child) =>
                    child.type === "mdxJsxFlowElement" && child.name === "View",
            )
            if (!hasViewChild) return
            const grouped: RootContent[] = []
            let run: MdxJsxFlowElement[] = []
            let pendingWhitespace: RootContent[] = []
            const flush = () => {
                if (run.length > 0) grouped.push(buildGroup(run))
                run = []
            }
            for (const child of children) {
                if (
                    child.type === "mdxJsxFlowElement" &&
                    child.name === "View"
                ) {
                    // Whitespace between two views belongs to the group's
                    // seam — drop it with the wrap.
                    pendingWhitespace = []
                    run.push(child)
                    continue
                }
                if (
                    run.length > 0 &&
                    child.type === "text" &&
                    child.value.trim() === ""
                ) {
                    // Might sit between two views (kept out of the group) or
                    // trail the run (restored after the flush).
                    pendingWhitespace.push(child)
                    continue
                }
                flush()
                grouped.push(...pendingWhitespace, child)
                pendingWhitespace = []
            }
            flush()
            grouped.push(...pendingWhitespace)
            // The synthetic groups are flow elements; every grouped child
            // came out of this parent's own children array, so the parent's
            // content model still holds.
            children.splice(0, children.length, ...grouped)
        })
    }
}
