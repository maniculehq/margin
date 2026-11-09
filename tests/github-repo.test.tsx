import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"

const { GitHub } = getMDXComponents()

describe("MDX GitHub.Repo", () => {
    it("server-renders a plain repository link before the client fetch", () => {
        const html = renderToStaticMarkup(<GitHub.Repo repo="acme/docs" />)
        expect(html).toContain('href="https://github.com/acme/docs"')
        expect(html).toContain("acme/docs")
        expect(html).toContain("border")
    })

    it("accepts a full GitHub URL and the flat variant", () => {
        const html = renderToStaticMarkup(
            <GitHub.Repo repo="https://github.com/acme/docs" variant="flat" />,
        )
        expect(html).toContain('href="https://github.com/acme/docs"')
        expect(html).not.toContain("border ")
    })

    it("renders nothing for an unparseable repo", () => {
        expect(renderToStaticMarkup(<GitHub.Repo repo="not a repo" />)).toBe("")
    })
})
