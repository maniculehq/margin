import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"

const { Image } = getMDXComponents()
const hash = "b".repeat(64)

describe("responsive srcset for stored assets", () => {
    it("offers resized candidates below the intrinsic width plus the original", () => {
        const html = renderToStaticMarkup(
            <Image
                src={`/_assets/${hash}`}
                width={3024}
                height={1372}
                alt=""
            />,
        )
        expect(html).toContain(`/_assets/${hash}?w=640&amp;f=webp 640w`)
        expect(html).toContain(`/_assets/${hash}?w=1920&amp;f=webp 1920w`)
        expect(html).toContain(`/_assets/${hash} 3024w`)
        // Width descriptors need a sizes hint or browsers assume 100vw.
        expect(html).toMatch(/sizes="[^"]*vw/)
    })

    it("never upscales small images", () => {
        const html = renderToStaticMarkup(
            <Image src={`/_assets/${hash}`} width={600} height={300} alt="" />,
        )
        expect(html).not.toContain("srcSet")
    })

    it("leaves external and unsized images alone", () => {
        expect(
            renderToStaticMarkup(
                <Image src="https://example.com/a.png" width={3000} alt="" />,
            ),
        ).not.toContain("srcSet")
        expect(
            renderToStaticMarkup(<Image src={`/_assets/${hash}`} alt="" />),
        ).not.toContain("srcSet")
    })
})
