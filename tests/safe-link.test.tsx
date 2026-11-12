import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"

const Link = getMDXComponents().a

describe("MDX link href guard", () => {
    it("keeps a scheme-less relative path as a same-tab link", () => {
        expect(renderToStaticMarkup(<Link href="guide">Guide</Link>)).toBe(
            '<a href="guide" class="link">Guide</a>',
        )
    })

    // Browsers strip leading/trailing spaces and C0 controls and drop tabs
    // and newlines before parsing, and read "\" like "/" in http(s) URLs:
    // each of these resolves to another host, never a relative path.
    it.for([
        " //example.com/marker",
        "\t//example.com/marker",
        "/\t/example.com/marker",
        "\\\\example.com/marker",
        "/\\example.com/marker",
        "\u0001//example.com/marker",
    ])("refuses a protocol-relative href in disguise: %j", (href) => {
        const html = renderToStaticMarkup(<Link href={href}>Marker</Link>)
        expect(html).toBe("<span>Marker</span>")
    })

    it("refuses a scheme hidden behind leading whitespace", () => {
        expect(
            renderToStaticMarkup(<Link href={" data:,marker"}>Marker</Link>),
        ).toBe("<span>Marker</span>")
    })
})
