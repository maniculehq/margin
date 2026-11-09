import type { Root } from "mdast"
import { visit } from "unist-util-visit"
import { z } from "zod"
import type { DocsPageUpdates } from "../types/docs"
import {
    evaluateStaticMdxExpression,
    type StaticMdxValue,
} from "../types/docs-hast"

// Non-string or dynamic attribute values read as absent, as the rendered
// component would show nothing for them.
const text = z.string().nullable().catch(null)
const updateAttributesSchema = z.object({
    label: text,
    date: text,
    description: text,
    tags: z
        .array(z.unknown())
        .catch([])
        .transform((tags) => tags.filter((tag) => typeof tag === "string")),
    rss: z.object({ title: text, description: text }).nullable().catch(null),
})

/**
 * AST-native <Update> extraction over the fully-transformed page
 * MDAST, run ONCE at ingest and stored per page (docs_page.updates) for the
 * framework's Filters rail and RSS feed. A literal <Update> inside a code
 * fence, inline code or an MDX comment is a `code`/`inlineCode`/expression
 * node, never a JSX element, so documentation ABOUT the component cannot grow
 * changelog surfaces. Expression attributes (`tags={[...]}`,
 * `rss={{title}}`) are read through the static-data evaluator; anything
 * executable reads as absent.
 */
export function extractUpdatesFromMdast(mdast: Root): DocsPageUpdates | null {
    const updates: DocsPageUpdates = []
    visit(mdast, (node) => {
        if (
            (node.type !== "mdxJsxFlowElement" &&
                node.type !== "mdxJsxTextElement") ||
            node.name !== "Update"
        )
            return
        // Entries + fromEntries: an authored `__proto__` attribute becomes an
        // own key, never the bag's prototype.
        const attributes: [string, StaticMdxValue][] = []
        for (const attribute of node.attributes) {
            if (attribute.type !== "mdxJsxAttribute") continue
            if (typeof attribute.value === "string") {
                attributes.push([attribute.name, attribute.value])
                continue
            }
            const statement = attribute.value?.data?.estree?.body[0]
            if (statement?.type !== "ExpressionStatement") continue
            const evaluated = evaluateStaticMdxExpression(statement.expression)
            if (evaluated.ok) attributes.push([attribute.name, evaluated.value])
        }
        const parsed = updateAttributesSchema.parse(
            Object.fromEntries(attributes),
        )
        updates.push({
            // `date` fills in for a missing label — the rendered component
            // uses the same fallback for its pill and anchor id, and the RSS
            // pubDate parses either.
            label: parsed.label ?? parsed.date,
            description: parsed.description,
            tags: parsed.tags,
            rss:
                parsed.rss?.title || parsed.rss?.description
                    ? parsed.rss
                    : null,
        })
    })
    return updates.length > 0 ? updates : null
}
