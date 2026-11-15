import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"

const { Prompt, a: Link } = getMDXComponents()

/** The hrefs of the Open in links in a server render, by their hook. */
function openInHrefs(html: string) {
    return Object.fromEntries(
        [
            ...html.matchAll(
                /<a href="([^"]*)"[^>]*data-component-part="prompt-action-([a-z-]+)-button"/g,
            ),
        ].map(([, href, action]) => [action, href]),
    )
}

// Before hydration (and with JavaScript off) the links are all a reader has,
// so the server render must already carry the prompt.
describe("MDX Prompt server render", () => {
    it("puts the URL-encoded prompt in the Claude and ChatGPT links", () => {
        const html = renderToStaticMarkup(
            <Prompt actions={["copy", "claude-web", "chatgpt"]}>
                <p>
                    Fix the build & run{" "}
                    <Link href="https://example.com/a.md">
                        https://example.com/a.md
                    </Link>
                </p>
            </Prompt>,
        )
        const encoded =
            "Fix%20the%20build%20%26%20run%20https%3A%2F%2Fexample.com%2Fa.md"
        expect(openInHrefs(html)).toEqual({
            "claude-web": `https://claude.ai/new?q=${encoded}`,
            chatgpt: `https://chatgpt.com/?q=${encoded}`,
        })
    })

    it("offers only Copy when the actions array holds an unknown entry", () => {
        const known = renderToStaticMarkup(
            <Prompt actions={["copy", "cursor"]}>Fix the build</Prompt>,
        )
        expect(Object.keys(openInHrefs(known))).toEqual(["cursor"])

        const unknown = renderToStaticMarkup(
            <Prompt actions={["copy", "cursor", "telepathy"]}>
                Fix the build
            </Prompt>,
        )
        expect(openInHrefs(unknown)).toEqual({})
        expect(unknown).toContain(
            'data-component-part="prompt-action-copy-button"',
        )
    })
})
