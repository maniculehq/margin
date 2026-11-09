/** The serve-time pass that puts a site's base path on the root-relative
 * destinations of stored markdown (lib/base-path.ts withBaseInMarkdown).
 * The built-server suite (base-path-e2e) proves a served .md carries it;
 * this table covers the destination forms and the code it must not touch. */

import { describe, expect, it } from "vitest"
import { withBaseInMarkdown } from "@/lib/base-path"

describe("withBaseInMarkdown", () => {
    it.each([
        [
            "an inline link",
            "See [setup](/guides/setup).",
            "See [setup](/docs/guides/setup).",
        ],
        ["an image", "![chart](/_assets/abc)", "![chart](/docs/_assets/abc)"],
        [
            "an angle-bracketed link",
            "[a](</guides/a b>)",
            "[a](</docs/guides/a b>)",
        ],
        ["the site root", "[home](/)", "[home](/docs)"],
        [
            "a reference definition",
            "[setup]: /guides/setup",
            "[setup]: /docs/guides/setup",
        ],
        [
            "an HTML attribute",
            '<img src="/_assets/abc" />',
            '<img src="/docs/_assets/abc" />',
        ],
        ["a protocol-relative URL", "[x](//cdn.test/a)", "[x](//cdn.test/a)"],
        [
            "an absolute URL",
            "[x](https://acme.test/a)",
            "[x](https://acme.test/a)",
        ],
        ["a relative path", "[x](guides/a)", "[x](guides/a)"],
        [
            "inline code",
            "Write `[x](/guides/a)` there.",
            "Write `[x](/guides/a)` there.",
        ],
    ])("handles %s", (_name, markdown, expected) => {
        expect(withBaseInMarkdown(markdown, "/docs")).toBe(expected)
    })

    it("leaves fenced code alone and resumes after the fence", () => {
        const markdown = [
            "````md",
            "```",
            "[inside](/a)",
            "```",
            "````",
            "[after](/b)",
        ].join("\n")
        expect(withBaseInMarkdown(markdown, "/docs")).toBe(
            markdown.replace("[after](/b)", "[after](/docs/b)"),
        )
    })

    it.each([
        ["a blockquote", ["> ~~~md", "> [x](/guide)", "> ~~~"]],
        ["a nested blockquote", ["> > ```md", "> > [x](/guide)", "> > ```"]],
        ["a list item", ["1. ```md", "   [x](/guide)", "   ```"]],
        [
            "a nested list item",
            ["- a", "  - b", "", "    ```md", "    [x](/guide)", "    ```"],
        ],
    ])("leaves a fence inside %s alone", (_name, fenced) => {
        const markdown = [...fenced, "", "[after](/b)"].join("\n")
        expect(withBaseInMarkdown(markdown, "/docs")).toBe(
            markdown.replace("[after](/b)", "[after](/docs/b)"),
        )
    })

    it("ends a fence with the blockquote that holds it", () => {
        expect(
            withBaseInMarkdown(
                ["> ```md", "> [x](/guide)", "", "[after](/b)"].join("\n"),
                "/docs",
            ),
        ).toBe(["> ```md", "> [x](/guide)", "", "[after](/docs/b)"].join("\n"))
    })

    it("returns markdown unchanged at the domain root", () => {
        expect(withBaseInMarkdown("[x](/a)", "")).toBe("[x](/a)")
    })
})
