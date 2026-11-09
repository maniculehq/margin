import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { expect, test, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { compileDocs } from "@/ingest/compile"
import { persistDocsVersion } from "@/ingest/persist"
import { resolveDocsContext, resolvePage } from "@/lib/source"
import { getDocsOgImage } from "@/routes/og/docs/$"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

vi.mock("#docs-extensions", () => import("./site-hosts"))
// Observe the real renderer without replacing its SVG or raster output.
vi.mock("satori", { spy: true })

test.skipIf(!hasDocsDb)(
    "OG cards use registry descriptions when page and config omit them",
    async () => {
        const id = randomUUID()
        const slug = `og-${id}`
        await db.insert(schema.docsSite).values({
            id,
            slug,
            name: "Registry brand",
            description: "Registry description",
            status: "active",
            analyticsMode: "tenant",
        })
        try {
            const compiled = await compileDocs([
                { path: "docs.json", kind: "text", content: "{}" },
                {
                    path: "index.mdx",
                    kind: "text",
                    content: "---\ntitle: OG fixture\n---\n",
                },
            ])
            if (!compiled.ok)
                throw new Error(JSON.stringify(compiled.violations))
            await persistDocsVersion({
                ...compiled,
                siteId: id,
                commitSha: "6".repeat(40),
                kind: "production",
                seq: 1,
                headCommittedAt: null,
                assets: [],
                fontCss: "",
                searchCorpus: new Uint8Array(0),
                searchCorpusUrl: null,
            })
            const request = requestFor(siteHost(slug))
            const ctx = await resolveDocsContext(request)
            expect(ctx.identity.description).toBe("Registry description")
            expect(ctx.config?.description).toBeUndefined()
            expect(ctx.seo.description).toBeUndefined()
            const page = await resolvePage(ctx, ctx.source, [])
            if (!page) throw new Error("ingested OG fixture did not resolve")
            expect(page.data.description).toBeUndefined()

            const render = vi.mocked((await import("satori")).default)
            const image = await getDocsOgImage({ request, params: {} })
            expect(image.status).toBe(200)
            expect(render).toHaveBeenCalledOnce()
            const elements: unknown[] = [render.mock.calls[0]?.[0]]
            const text: string[] = []
            while (elements.length) {
                const value = elements.pop()
                const literal = z.string().safeParse(value)
                const children = z.array(z.unknown()).safeParse(value)
                if (literal.success) text.push(literal.data)
                else if (children.success) elements.push(...children.data)
                else {
                    const node = z
                        .object({ props: z.object({ children: z.unknown() }) })
                        .safeParse(value)
                    if (node.success) elements.push(node.data.props.children)
                }
            }
            expect(text).toContain("Registry brand")
            expect(text).toContain("Registry description")
        } finally {
            await db.delete(schema.docsSite).where(eq(schema.docsSite.id, id))
            vi.clearAllMocks()
        }
    },
    60_000,
)
