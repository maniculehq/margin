import { describe, expect, it } from "vitest"
import { sanitizeCss } from "@/ingest/theme"

const sanitize = (...sheets: string[]) =>
    sanitizeCss(
        sheets.map((content, index) => ({ path: `${index}.css`, content })),
        [],
    )

describe("site stylesheet hooks", () => {
    it("rewrites an ID hook to the region it names, at ID specificity", async () => {
        const { css } = await sanitize("#sidebar a { color: red }")
        expect(css).toContain(":is(#nd-sidebar, #css\\:hook) a")
        expect(css).not.toContain("#sidebar")
    })

    it("rewrites hooks nested in :has() and :not()", async () => {
        const { css } = await sanitize(
            "main:has(#table-of-contents):not(.toc-item) { color: red }",
        )
        expect(css).toContain(
            "main:has(:is(#nd-toc, #css\\:hook)):not(:is(#nd-toc a))",
        )
    })

    it("narrows a bare state attribute to the active value", async () => {
        const { css } = await sanitize(
            ".nav-tabs-item[data-active] { color: red }",
        )
        expect(css).toContain('.nav-tabs-item[data-active="true"]')
    })

    it("leaves a site's own IDs and classes alone", async () => {
        const { css } = await sanitize("#pricing .plan { color: red }")
        expect(css).toContain("#pricing .plan")
    })
})

describe("global layout rules", () => {
    it("keeps a rule that reads the root's state and styles a descendant", async () => {
        const { css, diagnostics } = await sanitize(
            'html[data-current-path^="/api"] .card { display: none }',
        )
        expect(css).toContain('html[data-current-path^="/api"] .card')
        expect(diagnostics).toEqual([])
    })

    it("drops a rule that reaches every child of the root", async () => {
        const { css } = await sanitize(
            ".card { color: red }",
            "html > * { display: none }",
        )
        expect(css).toContain(".card")
        expect(css).not.toContain("display")
    })

    it("still moves a layout rule on the root itself to the docs layout", async () => {
        const { css } = await sanitize("body { display: grid }")
        expect(css).toContain("#nd-docs-layout")
        expect(css).not.toMatch(/body\s*\{/)
    })
})

describe("font imports", () => {
    it("collects an import that leads a later file", async () => {
        const href =
            "https://fonts.googleapis.com/css2?family=Geist+Mono&display=swap"
        const { css, diagnostics, fontImports } = await sanitize(
            "h1 { color: red }",
            `@import url("${href}");\nh2 { color: blue }`,
        )
        expect(fontImports).toEqual([href])
        expect(css).toContain("h2")
        expect(diagnostics).toEqual([])
    })
})
