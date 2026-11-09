import type { Root } from "hast"
import { type Evaluater, toJsxRuntime } from "hast-util-to-jsx-runtime"
import type { MDXComponents } from "mdx/types"
import { useMemo } from "react"
import { Fragment, jsx, jsxs } from "react/jsx-runtime"
import { custom } from "zod/mini"
import { getMDXComponents } from "@/components/mdx"
import { evaluateStaticMdxExpression } from "@/types/docs-hast"

type EstreeExpression = Parameters<Evaluater["evaluateExpression"]>[0]

/** Render only the static expressions admitted by the ingest classifier. Component names resolve through the same allowlist, including
 * capitalized and dotted JSX names; anything else signals a classifier bug. */
function createDocsEvaluater(components: MDXComponents): Evaluater {
    const evaluateExpression = (expression: EstreeExpression): unknown => {
        const staticValue = evaluateStaticMdxExpression(expression)
        if (staticValue.ok) return staticValue.value
        if (expression.type === "Identifier") {
            const component = components[expression.name]
            if (component === undefined)
                throw new Error(
                    `SSR hast renderer: unknown component <${expression.name}>`,
                )
            return component
        }
        if (expression.type === "MemberExpression") {
            const chain: string[] = []
            let current: (typeof expression)["object"] = expression
            while (current.type === "MemberExpression") {
                if (current.computed || current.property.type !== "Identifier")
                    throw new Error(
                        "SSR hast renderer: unsupported member expression",
                    )
                chain.unshift(current.property.name)
                current = current.object
            }
            if (current.type !== "Identifier")
                throw new Error(
                    "SSR hast renderer: unsupported member expression root",
                )
            let resolved: unknown = components[current.name]
            for (const key of chain) {
                if (
                    resolved === null ||
                    (typeof resolved !== "object" &&
                        typeof resolved !== "function")
                )
                    throw new Error(
                        `SSR hast renderer: unknown component <${[current.name, ...chain].join(".")}>`,
                    )
                resolved = Reflect.get(resolved, key)
            }
            if (resolved === undefined)
                throw new Error(
                    `SSR hast renderer: unknown component <${[current.name, ...chain].join(".")}>`,
                )
            return resolved
        }
        throw new Error(
            "SSR hast renderer: non-static MDX expression reached the server — ingest classification bug",
        )
    }
    return {
        evaluateExpression,
        evaluateProgram: () => {
            throw new Error(
                "SSR hast renderer: MDX ESM reached the server — ingest classification bug",
            )
        },
    }
}

// The allowlist is static (sandbox/render.tsx builds it the same way), so
// one components object and evaluater serve every render.
const components = getMDXComponents()
const evaluater = createDocsEvaluater(components)

// Ingest output from our own pipeline (prepareHastArtifact); root-shape
// check + typed accessor, same pattern as source.ts's mdastRootSchema.
const hastRootSchema = custom<Root>(
    (value) =>
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "root",
)

export function HastBody(props: { hastJson: string }) {
    // The tree crosses the loader boundary as a JSON string (see
    // source.ts/DocsPageBody); parse and convert once per body identity so a
    // parent re-render (assistant open, locale strings) reuses the elements.
    return useMemo(
        () =>
            toJsxRuntime(hastRootSchema.parse(JSON.parse(props.hastJson)), {
                Fragment,
                jsx,
                jsxs,
                components,
                createEvaluater: () => evaluater,
            }),
        [props.hastJson],
    )
}
