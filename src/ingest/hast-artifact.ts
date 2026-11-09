import type { Root as HastRoot } from "hast"
import { EXIT, visit } from "unist-util-visit"
import {
    ALLOWED_MDX_COMPONENT_MEMBERS,
    ALLOWED_MDX_COMPONENTS,
} from "../types/docs"
import {
    evaluateStaticMdxExpression,
    staticMdxValueToEstree,
} from "../types/docs-hast"

/**
 * Classifies the compiled tree as safe, data-only HAST or client-executed JS.
 * Server rendering and validation share expression evaluation so eligibility
 * cannot drift. The walk also strips parser positions and dangerous attributes.
 */
export type HastFallbackReason =
    | "js-snippet-import"
    | "unknown-component"
    | "expression"
    | "spread-attribute"
    | "dynamic-attribute"

export type PrepareHastResult =
    | { ok: true; hast: HastRoot }
    | { ok: false; fallback: HastFallbackReason }

/** Elements whose adjacent whitespace never renders (block formatting). */
const BLOCK_LEVEL_SIBLINGS = new Set([
    "div",
    "section",
    "article",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "blockquote",
    "details",
    "figure",
    "dl",
    "dt",
    "dd",
    "pre",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
])

const BLOCK_ONLY_CONTAINERS = new Set([
    "div",
    "section",
    "article",
    "ul",
    "ol",
    "table",
    "thead",
    "tbody",
    "tr",
    "blockquote",
    "details",
    "figure",
    "dl",
])

export function prepareHastArtifact(input: {
    /** MUTATED in place (scrubbed) — pass an owned clone, not a live tree. */
    tree: HastRoot
    hasJsSnippetBindings: boolean
}): PrepareHastResult {
    if (input.hasJsSnippetBindings)
        return { ok: false, fallback: "js-snippet-import" }
    const tree = input.tree
    let fallback: HastFallbackReason | null = null
    visit(tree, (node, index, parent) => {
        delete node.position
        // Inter-block formatting whitespace ("\n" between sibling blocks
        // under root/div/ul/table…) is layout-inert and costs ~80 nodes per
        // page in the stored artifact. Only block-only containers are
        // scrubbed: whitespace inside <pre>/<code> and phrasing parents
        // (p, span, li, td, headings) is content and stays.
        if (
            node.type === "text" &&
            /^\s*$/.test(node.value) &&
            parent &&
            typeof index === "number" &&
            (parent.type === "root" ||
                (parent.type === "element" &&
                    BLOCK_ONLY_CONTAINERS.has(parent.tagName))) &&
            // A div may still hold inline siblings (<span>one</span>
            // <span>two</span>): only whitespace whose neighbours are both
            // block-level (or absent) is layout-inert.
            [parent.children[index - 1], parent.children[index + 1]].every(
                (sibling) =>
                    sibling === undefined ||
                    (sibling.type === "element" &&
                        BLOCK_LEVEL_SIBLINGS.has(sibling.tagName)),
            )
        ) {
            parent.children.splice(index, 1)
            return index
        }
        // Shiki notation-transformer bookkeeping duplicates whole line
        // subtrees under data — ingest-internal, never read at serve.
        if (node.data) Reflect.deleteProperty(node.data, "_shiki_notation")
        if (node.type === "mdxjsEsm") {
            // COMPILER-generated exports (frontmatter, structured data) —
            // never tenant code: remarkDocsAllowList strips every
            // tenant-authored import/export (esm_stripped) long before the
            // tree reaches rehype. The executable path needs these exports;
            // the hast path reads the same values from page columns, so
            // they are dropped from the stored tree.
            if (parent && typeof index === "number") {
                parent.children.splice(index, 1)
                return index
            }
            return
        }
        if (
            node.type === "mdxFlowExpression" ||
            node.type === "mdxTextExpression"
        ) {
            // Comment-only expressions (`{/* vale off */}`) have an empty
            // estree body and render nothing — drop them instead of
            // forfeiting SSR for the whole page.
            const body = node.data?.estree?.body
            if (body?.length === 0 && parent && typeof index === "number") {
                parent.children.splice(index, 1)
                return index
            }
            fallback = "expression"
            return EXIT
        }
        if (node.type === "element") {
            for (const key of Object.keys(node.properties)) {
                if (/^on/i.test(key) || key === "dangerouslySetInnerHTML")
                    delete node.properties[key]
            }
            return
        }
        if (
            node.type !== "mdxJsxFlowElement" &&
            node.type !== "mdxJsxTextElement"
        )
            return
        if (node.name && /^[A-Z]|\./.test(node.name)) {
            const [root, ...members] = node.name.split(".")
            const available =
                [
                    "CodeBlockTab",
                    "CodeBlockTabs",
                    "CodeBlockTabsList",
                    "CodeBlockTabsTrigger",
                    "ViewGroup",
                ].includes(node.name) ||
                ALLOWED_MDX_COMPONENTS.some(
                    (component) =>
                        component === root &&
                        (members.length === 0 ||
                            (members.length === 1 &&
                                ALLOWED_MDX_COMPONENT_MEMBERS[
                                    component
                                ]?.includes(members[0] ?? ""))),
                )
            if (!available) {
                fallback = "unknown-component"
                return EXIT
            }
        }
        for (const attribute of [...node.attributes]) {
            // Attribute nodes are not unist children — the visit above never
            // reaches them, so their positions are scrubbed here.
            delete attribute.position
            if (attribute.type === "mdxJsxExpressionAttribute") {
                fallback = "spread-attribute"
                return EXIT
            }
            if (
                /^on/i.test(attribute.name) ||
                attribute.name === "dangerouslySetInnerHTML"
            ) {
                node.attributes.splice(node.attributes.indexOf(attribute), 1)
                continue
            }
            if (
                attribute.value === null ||
                attribute.value === undefined ||
                typeof attribute.value === "string"
            )
                continue
            // MdxJsxAttributeValueExpression — admit only the static subset
            // (literals, undefined, and arrays/objects of them), and re-emit
            // it as a minimal estree so the stored tree carries no acorn
            // position junk and the serve evaluater only ever sees data.
            const statement = attribute.value.data?.estree?.body[0]
            const evaluated =
                statement?.type === "ExpressionStatement"
                    ? evaluateStaticMdxExpression(statement.expression)
                    : { ok: false as const }
            if (!evaluated.ok) {
                fallback = "dynamic-attribute"
                return EXIT
            }
            attribute.value = {
                type: "mdxJsxAttributeValueExpression",
                value: JSON.stringify(evaluated.value) ?? "undefined",
                data: {
                    estree: {
                        type: "Program",
                        sourceType: "module",
                        body: [
                            {
                                type: "ExpressionStatement",
                                expression: staticMdxValueToEstree(
                                    evaluated.value,
                                ),
                            },
                        ],
                    },
                },
            }
        }
    })
    if (fallback !== null) return { ok: false, fallback }
    return { ok: true, hast: tree }
}
