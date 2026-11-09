import { executeMdxSync } from "@fumadocs/mdx-remote/client"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { HastBody } from "@/components/hast-body"
import { getMDXComponents } from "@/components/mdx"
import { compileDocs } from "@/ingest/compile"
import { prepareHastArtifact } from "@/ingest/hast-artifact"

describe.concurrent("MDX artifact renderability", () => {
    it.for([
        "DownloadPDFButton",
        "ThemeCard",
        "Counter",
        "Tree.Missing",
        "Color.Item.Nested",
        "CodeBlockTab.Missing",
        "CodeBlockTabs.Missing",
        "CodeBlockTabsList.Missing",
        "CodeBlockTabsTrigger.Missing",
        "ViewGroup.Missing",
    ])("rejects unresolvable registry components: %s", (name) => {
        expect(
            prepareHastArtifact({
                tree: {
                    type: "root",
                    children: [
                        {
                            type: "mdxJsxFlowElement",
                            name,
                            attributes: [],
                            children: [],
                        },
                    ],
                },
                hasJsSnippetBindings: false,
            }),
        ).toEqual({ ok: false, fallback: "unknown-component" })
    })

    it("still server-renders allow-listed components", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content: "# Static page\n\n<Note>Available component</Note>",
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.hast) throw new Error("Expected server-renderable artifact")
        expect(
            renderToStaticMarkup(
                createElement(HastBody, {
                    hastJson: JSON.stringify(page.hast),
                }),
            ),
        ).toContain("Available component")
    })

    it("still server-renders registered member components", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content: '<Tree><Tree.File name="registry-member.ts" /></Tree>',
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.hast) throw new Error("Expected server-renderable artifact")
        expect(
            renderToStaticMarkup(
                createElement(HastBody, {
                    hastJson: JSON.stringify(page.hast),
                }),
            ),
        ).toContain("registry-member.ts")
    })

    it("still server-renders compiler-generated view groups", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content:
                    '<View title="First">Default view content</View>\n\n<View title="Second">Alternate content</View>',
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.hast) throw new Error("Expected server-renderable artifact")
        expect(
            renderToStaticMarkup(
                createElement(HastBody, {
                    hastJson: JSON.stringify(page.hast),
                }),
            ),
        ).toContain("Default view content")
    })

    it("preserves the browser evaluator path for successfully compiled local components", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content:
                    "export const HeroCard = () => <div>Local component content</div>;\n\n<HeroCard />",
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.compiledJs) throw new Error("Expected browser artifact")
        expect(page.hast).toBeNull()
        const component = executeMdxSync(page.compiledJs).default
        expect(renderToStaticMarkup(createElement(component))).toContain(
            "Local component content",
        )
    })

    it.for([
        "CodeBlockTab",
        "CodeBlockTabs",
        "CodeBlockTabsList",
        "CodeBlockTabsTrigger",
        "ViewGroup",
        "UnknownAuthoredComponent",
        "Tree.Missing",
    ])(
        "does not admit authored pipeline or unknown components: %s",
        async (name) => {
            const compiled = await compileDocs([
                {
                    path: "index.mdx",
                    kind: "text",
                    content: `<${name}>Unwrapped authored content</${name}>`,
                },
            ])
            if (!compiled.ok)
                throw new Error(JSON.stringify(compiled.violations))
            expect(compiled.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ code: "component_unknown" }),
                ]),
            )
            const page = compiled.pages[0]
            if (!page?.hast)
                throw new Error("Expected sanitized server artifact")
            expect(
                renderToStaticMarkup(
                    createElement(HastBody, {
                        hastJson: JSON.stringify(page.hast),
                    }),
                ),
            ).toBe("\nUnwrapped authored content")
        },
    )

    it("preserves successfully compiled local overrides of built-ins", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content:
                    "export const Note = () => <div>Local override content</div>;\n\n<Note>Ignored built-in fallback</Note>",
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.compiledJs) throw new Error("Expected browser artifact")
        expect(page.hast).toBeNull()
        const component = executeMdxSync(page.compiledJs).default
        expect(
            renderToStaticMarkup(
                createElement(component, { components: getMDXComponents() }),
            ),
        ).toBe("<div>Local override content</div>")
    })

    it("keeps unused executable local exports out of static HAST", async () => {
        const compiled = await compileDocs([
            {
                path: "index.mdx",
                kind: "text",
                content:
                    "export const Note = () => <div>Unused export</div>;\n\nStatic-looking content",
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        if (!page?.compiledJs) throw new Error("Expected browser artifact")
        expect(page.hast).toBeNull()
        const component = executeMdxSync(page.compiledJs).default
        expect(
            renderToStaticMarkup(
                createElement(component, { components: getMDXComponents() }),
            ),
        ).toBe("<p>Static-looking content</p>")
    })
})
