import { visit } from "unist-util-visit"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    imageUrls,
    parsePageMarkdown,
    renderPagePdf,
    stripAgentBlocks,
} from "@/lib/page-pdf"
import { pdfText } from "./context"

/**
 * Pure mdast → react-pdf mapping (lib/page-pdf.tsx): no DB, no network.
 * The route's DB work (asset embedding) is covered live in
 * pdf-route.test.ts against the seeded fixtures.
 */

const PAGE_URL = "https://acme.docs.test/guides/webhooks"

afterEach(() => {
    vi.unstubAllGlobals()
})

describe.concurrent("audience filter (human rendition)", () => {
    it("keeps human-only content and drops agent-only content", () => {
        const filtered = stripAgentBlocks(
            [
                "Shared intro.",
                "",
                "<Agent>",
                "Agent-only steering, never printed.",
                "</Agent>",
                "",
                "<Human>",
                "Human-only aside.",
                "</Human>",
                "",
                '<Visibility for="agents">',
                "More agent-only text.",
                "</Visibility>",
                "",
                '<Visibility for="humans">',
                "Human visibility text.",
                "</Visibility>",
                "",
                "Shared outro.",
            ].join("\n"),
        )
        expect(filtered).toContain("Shared intro.")
        expect(filtered).toContain("Shared outro.")
        expect(filtered).toContain("Human-only aside.")
        expect(filtered).toContain("Human visibility text.")
        expect(filtered).not.toContain("Agent-only steering")
        expect(filtered).not.toContain("More agent-only text")
        expect(filtered).not.toContain("<Human>")
        expect(filtered).not.toContain("<Visibility")
    })

    it("ignores audience tags inside code fences and inline code", () => {
        const markdown = [
            "```md",
            "<Agent>documented example</Agent>",
            "```",
            "",
            "Inline `<Agent>` mention.",
        ].join("\n")
        expect(stripAgentBlocks(markdown)).toBe(markdown)
    })

    it("masks 4-backtick fences and indented code blocks (CommonMark-aware)", () => {
        const markdown = [
            "````md",
            "```",
            "<Agent>fenced example</Agent>",
            "```",
            "````",
            "",
            "Prose between.",
            "",
            "    <Agent>indented code example</Agent>",
            "",
            "Trailing prose.",
        ].join("\n")
        expect(stripAgentBlocks(markdown)).toBe(markdown)
    })

    it("drops an unclosed agent block to end of document (fail closed)", () => {
        const filtered = stripAgentBlocks(
            ["Visible.", "", "<Agent>", "Leaks forever without a close."].join(
                "\n",
            ),
        )
        expect(filtered).toContain("Visible.")
        expect(filtered).not.toContain("Leaks forever")
    })

    it("handles nested audience blocks", () => {
        const filtered = stripAgentBlocks(
            [
                "<Human>",
                "Outer human.",
                "<Agent>",
                "Inner agent secret.",
                "</Agent>",
                "Still human.",
                "</Human>",
            ].join("\n"),
        )
        expect(filtered).toContain("Outer human.")
        expect(filtered).toContain("Still human.")
        expect(filtered).not.toContain("Inner agent secret")
    })
})

describe.concurrent("page pdf markdown mapping", () => {
    it("renders the block vocabulary to a PDF (magic bytes)", async () => {
        const root = parsePageMarkdown(
            [
                "# Heading one",
                "",
                "A paragraph with **bold**, *italic*, `inline code`, and a [link](https://example.com/docs).",
                "",
                "> A blockquote line.",
                "",
                "```ts",
                "const answer = 42",
                "console.log(answer)",
                "```",
                "",
                "- unordered item",
                "  1. nested ordered item",
                "- ~~struck~~ item",
                "",
                "| Column A | Column B |",
                "| --- | --- |",
                "| a1 | b1 |",
                "",
                "---",
            ].join("\n"),
        )
        const bytes = await renderPagePdf({
            title: "Webhooks",
            url: PAGE_URL,
            root,
            images: new Map(),
        })
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
    })

    it("collects distinct authored image URLs", () => {
        const root = parsePageMarkdown(
            [
                `![Diagram](/_assets/${"a".repeat(64)})`,
                "",
                "![External](https://cdn.example.com/pic.png)",
                "",
                `![Diagram again](/_assets/${"a".repeat(64)})`,
            ].join("\n"),
        )
        expect(imageUrls(root).sort()).toEqual([
            `/_assets/${"a".repeat(64)}`,
            "https://cdn.example.com/pic.png",
        ])
    })

    it("never fetches unresolved image URLs — alt text instead", async () => {
        const fetchSpy = vi.fn(() => {
            throw new Error("network fetch attempted")
        })
        vi.stubGlobal("fetch", fetchSpy)
        const bytes = await renderPagePdf({
            title: "External image",
            url: PAGE_URL,
            root: parsePageMarkdown(
                [
                    "![Site diagram](https://site.example.com/diagram.svg)",
                    "",
                    `![Missing asset](/_assets/${"c".repeat(64)})`,
                ].join("\n"),
            ),
            images: new Map(),
        })
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("surfaces MDX/HTML <img> elements as embeddable images", () => {
        const root = parsePageMarkdown(
            [
                '<img src="/images/diagram.png" alt="Diagram" />',
                "",
                'Inline <img src="/images/dot.png" alt="Dot"> here.',
            ].join("\n"),
        )
        expect(imageUrls(root).sort()).toEqual([
            "/images/diagram.png",
            "/images/dot.png",
        ])
    })

    it("strips authored .mdx/.md extensions from internal links only", () => {
        const root = parsePageMarkdown(
            [
                "[guide](/guide.mdx#setup) and [raw](/raw.md)",
                "and [external](https://example.com/file.md).",
            ].join(" "),
        )
        const urls = JSON.stringify(root)
        expect(urls).toContain('"/guide#setup"')
        expect(urls).toContain('"/raw"')
        expect(urls).toContain('"https://example.com/file.md"')
    })

    it("collects imageReference URLs through their definitions", () => {
        const root = parsePageMarkdown(
            ["![Diagram][ref]", "", "[ref]: /images/diagram.png"].join("\n"),
        )
        expect(imageUrls(root)).toEqual(["/images/diagram.png"])
    })
})

describe("review round 5 hardening", () => {
    it("ignores agent tokens inside frontmatter", async () => {
        const { stripAgentBlocks } = await import("@/lib/page-pdf")
        const out = stripAgentBlocks(
            '---\ndescription: "documents the <Agent> component"\n---\n\nBody stays.\n',
        )
        expect(out).toContain("Body stays.")
    })

    it("strips MDX comments outside code", async () => {
        const { stripAgentBlocks } = await import("@/lib/page-pdf")
        const out = stripAgentBlocks(
            "Before.\n\n{/* internal-only note */}\n\nAfter.\n\n`{/* keep-in-code */}`\n",
        )
        expect(out).not.toContain("internal-only note")
        expect(out).toContain("keep-in-code")
        expect(out).toContain("Before.")
        expect(out).toContain("After.")
    })

    it("resolves relative links source-relative and rooted", async () => {
        const { parsePageMarkdown } = await import("@/lib/page-pdf")
        const root = parsePageMarkdown(
            "[cfg](./configure)\n\n[up](../top?tab=a)\n",
            "guide/install.mdx",
        )
        const urls: string[] = []
        const walk = (node: {
            type?: string
            url?: string
            children?: unknown
        }) => {
            if (node.type === "link" && typeof node.url === "string")
                urls.push(node.url)
            if (Array.isArray(node.children))
                for (const child of node.children)
                    if (typeof child === "object" && child !== null) walk(child)
        }
        walk(root)
        expect(urls).toEqual(["/guide/configure", "/top?tab=a"])
    })
})

describe("MDX component bodies (QA finding 110)", () => {
    const source = [
        "<Steps>",
        '  <Step title="Log in">',
        "    ```bash terminal",
        "    orbit login --host api.orbit.example",
        "    ```",
        "",
        "    <Check>Done. See [auth](/authentication).</Check>",
        "  </Step>",
        "</Steps>",
        "",
        "Version 2.4.1.",
    ].join("\n")

    it("parses component children as Markdown instead of raw html", () => {
        const root = parsePageMarkdown(source, "quickstart.mdx")
        const nodes: Array<{ type: string; value?: string; url?: string }> = []
        const walk = (node: {
            type: string
            value?: unknown
            url?: unknown
            children?: unknown
        }) => {
            nodes.push({
                type: node.type,
                ...(typeof node.value === "string"
                    ? { value: node.value }
                    : {}),
                ...(typeof node.url === "string" ? { url: node.url } : {}),
            })
            if (Array.isArray(node.children))
                for (const child of node.children) walk(child)
        }
        walk(root)
        expect(nodes).toContainEqual({
            type: "code",
            value: "orbit login --host api.orbit.example",
        })
        expect(nodes).toContainEqual({ type: "link", url: "/authentication" })
        expect(nodes).toContainEqual({ type: "text", value: "Version 2.4.1." })
        expect(nodes.some((node) => node.type === "html")).toBe(false)
    })

    it("keeps heading-anchor syntax inside fenced code byte-for-byte", () => {
        const root = parsePageMarkdown(
            [
                "## Real heading {#real}",
                "",
                "```md",
                "## Example {#example}",
                "```",
            ].join("\n"),
        )
        const codes: string[] = []
        visit(root, "code", (node) => {
            codes.push(node.value)
        })
        expect(codes).toEqual(["## Example {#example}"])
    })

    it("leaves inherited object keys literal when no variable declares them", () => {
        const root = parsePageMarkdown("`{{constructor}}` and {{toString}}.")
        expect(JSON.stringify(root)).toContain('"value":"{{constructor}}"')
        expect(JSON.stringify(root)).toContain('"value":"{{toString}}"')
    })

    it("prints static expression values the human page displays", () => {
        const root = parsePageMarkdown('Version {"2.4.1"} ships {3} regions.')
        const text: string[] = []
        visit(root, "text", (node) => {
            text.push(node.value)
        })
        expect(text.join("")).toBe("Version 2.4.1 ships 3 regions.")
    })

    it("never closes a fence on a backtick line that carries an info string", () => {
        const root = parsePageMarkdown(
            ["```md", "```bash", "## Example {#example}", "```"].join("\n"),
        )
        const codes: string[] = []
        visit(root, "code", (node) => {
            codes.push(node.value)
        })
        expect(codes).toEqual(["```bash\n## Example {#example}"])
    })

    // The human page's MDX parser has no indented code, so a bare closing
    // delimiter closes the fence at any indentation (spaces or tabs, opener
    // indented or not): the next line is the page's `#example` heading, and
    // the PDF must read it the same way rather than as code.
    it.each([
        ["four columns deeper than its opener", "```md\n    ```"],
        ["indented by a tab", "```md\n\t```"],
        ["deeper than an indented opener", " ```md\n    ```"],
    ])(
        "closes a fence where the page does: a bare delimiter %s",
        (_, fence) => {
            const root = parsePageMarkdown(
                [fence, "## Example {#example}", "```"].join("\n"),
            )
            const headings: string[] = []
            visit(root, "heading", (node) => {
                headings.push(JSON.stringify(node.children))
            })
            const codes: string[] = []
            visit(root, "code", (node) => {
                codes.push(node.value)
            })
            expect(headings).toHaveLength(1)
            expect(headings[0]).toContain("Example [#example]")
            expect(codes.join("\n")).not.toContain("Example")
        },
    )

    it("labels a field with ParamField's own precedence (path before name)", async () => {
        const bytes = await renderPagePdf({
            title: "Fields",
            url: PAGE_URL,
            root: parsePageMarkdown(
                '<ParamField name="project" path="project_id" type="string">\nThe project.\n</ParamField>',
            ),
            images: new Map(),
        })
        const text = pdfText(bytes)
        expect(text).toContain("project_id")
        expect(text).not.toContain("project ·")
    })

    it("strips Markdoc tags from a page that is not valid MDX as authored", () => {
        // Ingest stores pages already rescued; an authored-source fallback
        // row can still carry the tags.
        const root = parsePageMarkdown(
            [
                '{% callout type="info" %}',
                "Point the CLI at **api.orbit.example**.",
                "{% /callout %}",
            ].join("\n"),
            "routing.mdx",
        )
        const text: string[] = []
        visit(root, "text", (node) => {
            text.push(node.value)
        })
        expect(text.join("")).toContain("Point the CLI at api.orbit.example.")
        expect(text.join("")).not.toContain("{%")
    })
})
