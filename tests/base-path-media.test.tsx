/** Media URLs an article renders under a base path (lib/base-path.ts). The
 * article components read the base through BasePathContext, the way the
 * SSR isolate (sandbox/render.tsx) provides it. */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getMDXComponents } from "@/components/mdx"
import { BasePathContext } from "@/lib/base-path"

const { img: ArticleImage, video: DocsVideo } = getMDXComponents()
const hash = "c".repeat(64)

describe("article media under a base path", () => {
    it("prefixes the root-relative candidates of an authored srcset", () => {
        const html = renderToStaticMarkup(
            <BasePathContext value="/docs">
                <ArticleImage
                    src="/images/chart.png"
                    srcSet="/images/chart.png 1x, /images/chart@2x.png 2x, https://cdn.test/chart.png 3x, data:image/jpeg;base64,/9j/4AAQ 4x"
                    alt=""
                />
            </BasePathContext>,
        )
        expect(html).toContain(
            'srcSet="/docs/images/chart.png 1x, /docs/images/chart@2x.png 2x, https://cdn.test/chart.png 3x, data:image/jpeg;base64,/9j/4AAQ 4x"',
        )
    })

    it("prefixes the sources of a video", () => {
        const html = renderToStaticMarkup(
            <BasePathContext value="/docs">
                <DocsVideo>
                    <source src={`/_assets/${hash}`} type="video/mp4" />
                    <source
                        src="https://cdn.test/demo.webm"
                        type="video/webm"
                    />
                </DocsVideo>
            </BasePathContext>,
        )
        expect(html).toContain(
            `<source src="/docs/_assets/${hash}" type="video/mp4"/>`,
        )
        expect(html).toContain(
            '<source src="https://cdn.test/demo.webm" type="video/webm"/>',
        )
    })
})
