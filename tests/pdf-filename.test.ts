import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Content-Disposition hardening: HTTP header values must stay Latin-1
 * (undici throws on anything else — a unicode slug would 500 the route), so
 * the filename ships as an ASCII fallback plus an RFC 5987 `filename*`.
 * Resolution is mocked (spec-route.test.ts pattern) because no seeded
 * fixture carries a non-ASCII slug.
 */
const resolveDocsContext = vi.fn()
const sourceForActiveVersion = vi.fn()
const resolvePage = vi.fn()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveDocsContext: (...args: unknown[]) => resolveDocsContext(...args),
    sourceForActiveVersion: (...args: unknown[]) =>
        sourceForActiveVersion(...args),
    resolvePage: (...args: unknown[]) => resolvePage(...args),
}))

const slug = "günther-中文"
const ctxSentinel = {
    versionId: "v-1",
    site: { id: "t-1" },
    seo: { trailingSlash: false },
}
const page = {
    slugs: [slug],
    url: `/${slug}`,
    data: {
        pageTitle: "Günther 中文",
        sourcePath: `${slug}.mdx`,
        getText: async () => "Just a paragraph.",
    },
}

beforeEach(() => {
    resolveDocsContext.mockReset().mockResolvedValue(ctxSentinel)
    sourceForActiveVersion.mockReset().mockResolvedValue({})
    resolvePage.mockReset().mockResolvedValue(page)
})

// Cold imports dominate under parallel suite load. Load the route and its
// renderer with the test module; the test still performs a real PDF render.
const { getDocsPdf } = await import("../src/routes/{$}[.]pdf")
await import("@/lib/page-pdf")

describe("pdf filename encoding", () => {
    it("serves a unicode slug with an RFC 5987 disposition instead of a 500", async () => {
        const response = await getDocsPdf({
            request: new Request(
                `https://acme.docs.test/${encodeURIComponent(slug)}.pdf`,
                { headers: { host: "acme.docs.test" } },
            ),
            params: { _splat: slug },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-disposition")).toBe(
            "attachment; filename=\"g_nther-__.pdf\"; filename*=UTF-8''g%C3%BCnther-%E4%B8%AD%E6%96%87.pdf",
        )
        const bytes = new Uint8Array(await response.arrayBuffer())
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
    })
})
