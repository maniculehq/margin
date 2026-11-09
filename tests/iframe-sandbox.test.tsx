import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"

const Iframe = getMDXComponents().iframe

describe("MDX iframe sandbox", () => {
    it("grants allow-same-origin to known video-player hosts", () => {
        const html = renderToStaticMarkup(
            <Iframe src="https://www.youtube.com/embed/4KzFe50RQkQ" />,
        )
        expect(html).toContain(
            'sandbox="allow-scripts allow-same-origin allow-popups"',
        )
    })

    it("keeps the strict sandbox for every other host", () => {
        const html = renderToStaticMarkup(
            <Iframe src="https://example.com/embed" />,
        )
        expect(html).toContain('sandbox="allow-scripts allow-popups"')
        expect(html).not.toContain("allow-same-origin")
    })

    it.for([
        "https://evil.example\\@www.youtube.com/embed/4KzFe50RQkQ",
        "https://evil.example@www.youtube.com/embed/4KzFe50RQkQ",
        "https://www.youtube.com%2eevil.example/embed",
    ])("keeps the strict sandbox for an ambiguous authority: %s", (src) => {
        const html = renderToStaticMarkup(<Iframe src={src} />)
        expect(html).toContain('sandbox="allow-scripts allow-popups"')
        expect(html).not.toContain("allow-same-origin")
    })

    // Safari rejects the token and logs a console error for every embed.
    it("never sets the allow-presentation flag Safari rejects", () => {
        const html = renderToStaticMarkup(
            <>
                <Iframe src="https://www.youtube.com/embed/4KzFe50RQkQ" />
                <Iframe src="https://example.com/embed" />
            </>,
        )
        expect(html.match(/<iframe /g)).toHaveLength(2)
        expect(html).not.toContain("allow-presentation")
    })

    it("refuses non-https sources", () => {
        expect(renderToStaticMarkup(<Iframe src="http://example.com" />)).toBe(
            "",
        )
    })
})
