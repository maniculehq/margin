import { describe, expect, it } from "vitest"
import { sanitizeCss } from "@/ingest/theme"

const sanitize = (...sheets: string[]) =>
    sanitizeCss(
        sheets.map((content, index) => ({ path: `${index}.css`, content })),
        [],
    )

describe("site stylesheet hooks", () => {
    it("rewrites an ID hook to the regions it names, at ID weight", async () => {
        const { css } = await sanitize("#sidebar a { color: red }")
        expect(css).toContain(
            ":where(#nd-sidebar, #nd-sidebar-mobile):not(#css\\:hook) a",
        )
        expect(css).not.toContain("#sidebar")
    })

    it("keeps a class hook at class weight, below an ID hook", async () => {
        const { css } = await sanitize(".toc { color: red }")
        expect(css).toContain(":where(#nd-toc):not(.css\\:hook)")
    })

    it("rewrites hooks nested in :has() and :not()", async () => {
        const { css } = await sanitize(
            "main:has(#table-of-contents):not(.toc-item) { color: red }",
        )
        expect(css).toContain(
            "main:has(:where(#nd-toc):not(#css\\:hook)):not(:where(#nd-toc a):not(.css\\:hook))",
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

    it("leaves names every object inherits alone", async () => {
        const { css, diagnostics } = await sanitize(
            "#constructor .toString { color: red }",
        )
        expect(css).toContain("#constructor .toString")
        expect(diagnostics).toEqual([])
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

    it("drops a rule whose :is() can match the body", async () => {
        const { css } = await sanitize(
            ".card { color: red }",
            "html > :is(body, .shell) { display: none }",
        )
        expect(css).toContain(".card")
        expect(css).not.toContain("display")
    })

    it("keeps a path-scoped rule on a translated hook", async () => {
        const { css } = await sanitize(
            'html[data-current-path^="/api"] #banner { display: none }',
        )
        expect(css).toContain("display: none")
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
