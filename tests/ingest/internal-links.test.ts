import { describe, expect, it } from "vitest"
import { compileDocs } from "@/ingest/compile"

describe("internal link validation", () => {
    it("warns about a broken bare relative link and leaves non-page targets alone", async () => {
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "Links",
                    navigation: { pages: ["guides/a", "guides/real"] },
                }),
            },
            {
                path: "guides/real.mdx",
                kind: "text",
                content: "# Real\n\nBody.\n",
            },
            {
                path: "guides/a.mdx",
                kind: "text",
                content: [
                    "# A",
                    "",
                    "[x](nope) [y](guides/ghost.mdx)",
                    "",
                    '<Card title="Card" href="nope-card">Body</Card>',
                    "",
                    "[ok](real) [ext](https://x.dev) [m](mailto:a@b.c) [f](#frag)",
                    "[cdn](//cdn.x/y) [pdf](report.pdf) [mail](me@x.com) [ide](vscode:mcp/install)",
                    "",
                ].join("\n"),
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const broken = compiled.diagnostics
            .filter(
                (diagnostic) =>
                    diagnostic.code === "link_broken" &&
                    diagnostic.path === "guides/a.mdx",
            )
            .map((diagnostic) => diagnostic.message)
            .sort()
        expect(broken).toEqual([
            "broken internal link: guides/ghost.mdx",
            "broken internal link: nope",
            "broken internal link: nope-card",
        ])
    })
})
