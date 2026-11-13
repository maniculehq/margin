import { describe, expect, it } from "vitest"
import { compileDocs } from "@/ingest/compile"

describe("mid-document frontmatter warning", () => {
    it("warns about stray frontmatter in the page body", async () => {
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "Frontmatter",
                    navigation: { pages: ["page"] },
                }),
            },
            {
                path: "page.mdx",
                kind: "text",
                content:
                    "---\ntitle: Page\n---\n\nBody.\n\n---\ntitle: Stray\n---\n",
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const suspects = compiled.diagnostics.filter(
            (diagnostic) => diagnostic.code === "content_suspect",
        )
        expect(suspects).toHaveLength(1)
        expect(suspects[0]?.path).toBe("page.mdx")
    })

    it.each(["\n", "\r\n"])(
        "ignores frontmatter examples inside backtick and tilde fences with %j line endings",
        async (newline) => {
            const compiled = await compileDocs([
                {
                    path: "docs.json",
                    kind: "text",
                    content: JSON.stringify({
                        name: "Frontmatter",
                        navigation: { pages: ["page"] },
                    }),
                },
                {
                    path: "page.mdx",
                    kind: "text",
                    content: [
                        "---",
                        "title: Page",
                        "---",
                        "",
                        "```mdx",
                        "---",
                        "title: Example",
                        "---",
                        "```",
                        "",
                        "~~~yaml",
                        "---",
                        "title: Example",
                        "---",
                        "~~~",
                        "",
                    ].join(newline),
                },
            ])
            if (!compiled.ok)
                throw new Error(JSON.stringify(compiled.violations))
            const suspects = compiled.diagnostics.filter(
                (diagnostic) => diagnostic.code === "content_suspect",
            )
            expect(suspects).toEqual([])
        },
    )
})
