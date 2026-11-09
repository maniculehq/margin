/**
 * The per-page PDF route end to end: a fixture ingested through the REAL
 * pipeline into a seeded Postgres, then `<page>.pdf` rendered in-process.
 * The PDF reads the human rendition ingest stores (docs_page.source), so
 * snippet bodies and docs.json variables arrive already resolved.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { db, schema } from "@/db"
import { siteScope } from "@/lib/base-path"
import { getDocsPdf } from "../src/routes/{$}[.]pdf"
import { hasDocsDb, pdfText, requestFor } from "./context"
import { siteHost } from "./site-hosts"

vi.mock("#docs-extensions", () => import("./site-hosts"))

const tenantId = randomUUID()
const slug = `pdf-${tenantId}`
const hostname = siteHost(slug)

describe.skipIf(!hasDocsDb)("page pdf route", () => {
    let text = ""

    beforeAll(async () => {
        const { compileDocs } = await import("../src/ingest/compile")
        const { persistDocsVersion } = await import("../src/ingest/persist")
        const { buildSearchCorpus } = await import("../src/ingest/assets")
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "PDF Route",
                    // A value that itself reads like a variable: the page
                    // resolves it once and shows `{{name}}`.
                    variables: { template: "{{name}}", name: "world" },
                    navigation: { pages: ["guide"] },
                }),
            },
            {
                path: "snippets/warning.mdx",
                kind: "text",
                content: "<Warning>Snippet body marker.</Warning>\n",
            },
            {
                path: "guide.mdx",
                kind: "text",
                content: [
                    "---",
                    "title: Guide",
                    "---",
                    "",
                    '<Snippet file="snippets/warning.mdx" />',
                    "",
                    "```bash",
                    "echo {{template}}",
                    "```",
                    "",
                ].join("\n"),
            },
        ])
        if (!compiled.ok) throw new Error("pdf fixture failed to compile")
        await db.insert(schema.docsSite).values({
            id: tenantId,
            slug,
            name: "PDF Route",
            analyticsMode: "off",
            status: "active",
        })
        const persisted = await persistDocsVersion({
            siteId: tenantId,
            commitSha: "pdf-route",
            kind: "production",
            seq: 1,
            headCommittedAt: new Date(),
            pages: compiled.pages,
            metas: compiled.metas,
            openapiDocuments: compiled.openapiDocuments,
            skills: compiled.skills,
            assets: compiled.assets,
            config: compiled.config,
            diagnostics: compiled.diagnostics,
            navSource: compiled.navSource,
            themeTokens: compiled.themeTokens,
            themeCss: compiled.themeCss,
            fontCss: "",
            fontInputs: compiled.fontInputs,
            layoutPreset: compiled.layoutPreset,
            versionsManifest: compiled.versionsManifest,
            localesManifest: compiled.localesManifest,
            redirects: compiled.redirects,
            seo: compiled.seo,
            integrations: compiled.integrations,
            searchCorpus: buildSearchCorpus(compiled.pages).gzipped,
            searchCorpusUrl: null,
        })
        if (persisted.outcome !== "flipped")
            throw new Error(`pdf fixture not served: ${persisted.outcome}`)
        const response = await getDocsPdf({
            request: requestFor(hostname, "/guide.pdf"),
            params: { _splat: "guide" },
        })
        expect(response.status).toBe(200)
        text = pdfText(new Uint8Array(await response.arrayBuffer()))
    }, 120_000)

    afterAll(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, tenantId))
    })

    it("prints a transcluded snippet's body", () => {
        expect(text).toContain("Snippet body marker.")
    })

    it("prints code variables as the page shows them, resolved once", () => {
        expect(text).toContain("echo {{name}}")
        expect(text).not.toContain("echo world")
    })

    // The document prints the page's address, which attaching a domain
    // moves without a new content version: a conditional request from
    // before the move gets the PDF again, not a 304.
    it("revalidates the download when the site's address changes", async () => {
        const fetchAt = (
            scope: { basePath: string; publicOrigin: string | null },
            etag?: string,
        ) =>
            siteScope().run({ ...scope, sharedClientAddress: false }, () => {
                const request = requestFor(hostname, "/guide.pdf")
                if (etag) request.headers.set("if-none-match", etag)
                return getDocsPdf({ request, params: { _splat: "guide" } })
            })
        const atPlatform = { basePath: "", publicOrigin: null }
        const first = await fetchAt(atPlatform)
        const etag = first.headers.get("etag") ?? ""
        expect(etag).not.toBe("")
        expect((await fetchAt(atPlatform, etag)).status).toBe(304)
        const moved = await fetchAt(
            { basePath: "/help", publicOrigin: "https://acme.example" },
            etag,
        )
        expect(moved.status).toBe(200)
        await moved.body?.cancel()
    }, 60_000)
})
