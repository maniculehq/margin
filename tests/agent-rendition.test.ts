/**
 * A page's `<page>.agent.md` sibling is its agent rendition: ingested through
 * the REAL pipeline into a seeded Postgres, then read from every agent
 * surface in-process. A page with a sibling serves it; a page without one
 * serves the Markdown derived from the page; the sibling is never a page;
 * a sibling beside no page raises a diagnostic.
 */
import { randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import type { CompileDocsResult } from "@/ingest/compile"
import { llmsFullResponse, llmsIndexResponse } from "@/lib/llms-index"
import { buildMcpServer } from "@/lib/mcp-server"
import { getDocsMarkdown } from "../src/routes/{$}[.]md"
import { getAgentContext } from "../src/routes/api.agent.context.$"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

vi.mock("#docs-extensions", () => import("./site-hosts"))

const siteId = randomUUID()
const slug = `rendition-${siteId}`
const hostname = siteHost(slug)

const RENDITION = "RENDITION_BODY_MARKER"
const DERIVED = "DERIVED_BODY_MARKER"

const files = [
    {
        path: "docs.json",
        kind: "text" as const,
        content: JSON.stringify({
            name: "Agent Rendition",
            "x-margin": { agents: { markdownFrontmatter: true } },
        }),
    },
    {
        path: "index.mdx",
        kind: "text" as const,
        content: "---\ntitle: Home\n---\n\nWelcome.\n",
    },
    {
        path: "guide.mdx",
        kind: "text" as const,
        content: `---\ntitle: Guide\ndescription: Set it up.\n---\n\n${DERIVED} for guide.\n`,
    },
    {
        path: "guide.agent.md",
        kind: "text" as const,
        content: `# Set it up\n\n## Do this\n\n1. ${RENDITION} for guide.\n`,
    },
    {
        path: "plain.mdx",
        kind: "text" as const,
        content: `---\ntitle: Plain\ndescription: A page with no rendition.\n---\n\n${DERIVED} for plain.\n`,
    },
    {
        path: "orphan.agent.md",
        kind: "text" as const,
        content: "# Nothing beside me\n",
    },
]

const markdownOf = async (splat: string) => {
    const response = await getDocsMarkdown({
        request: requestFor(hostname, `/${splat}.md`),
        params: { _splat: splat },
    })
    expect(response.status).toBe(200)
    return response.text()
}

describe.skipIf(!hasDocsDb)("agent renditions", () => {
    let compiled: Extract<CompileDocsResult, { ok: true }>

    beforeAll(async () => {
        const { compileDocs } = await import("../src/ingest/compile")
        const { persistDocsVersion } = await import("../src/ingest/persist")
        const { buildSearchCorpus } = await import("../src/ingest/assets")
        const result = await compileDocs(files)
        if (!result.ok) throw new Error("rendition fixture failed to compile")
        compiled = result
        await db.insert(schema.docsSite).values({
            id: siteId,
            slug,
            name: "Agent Rendition",
            analyticsMode: "off",
            status: "active",
        })
        const persisted = await persistDocsVersion({
            siteId,
            commitSha: "agent-rendition",
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
            throw new Error(
                `rendition fixture not served: ${persisted.outcome}`,
            )
    }, 120_000)

    afterAll(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
    })

    it("serves the rendition from <page>.md under the frontmatter and index preamble", async () => {
        const body = await markdownOf("guide")
        expect(body).toContain(RENDITION)
        expect(body).not.toContain(DERIVED)
        expect(body.startsWith('---\ntitle: "Guide"\n')).toBe(true)
        expect(body).toContain("> ## Documentation Index")
        expect(body.indexOf("> ## Documentation Index")).toBeLessThan(
            body.indexOf(RENDITION),
        )
    })

    it("serves the derived Markdown from <page>.md for a page without a rendition", async () => {
        const body = await markdownOf("plain")
        expect(body).toContain(`${DERIVED} for plain.`)
        expect(body).not.toContain(RENDITION)
    })

    it("never serves a rendition as a page or lists it in the index", async () => {
        expect(compiled.pages.map((page) => page.path).sort()).toEqual([
            "guide.mdx",
            "index.mdx",
            "plain.mdx",
        ])
        const index = await (
            await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
        ).text()
        expect(index).toContain("/guide.md")
        expect(index).not.toContain(".agent")
    })

    it("reports a rendition with no page beside it", () => {
        expect(
            compiled.diagnostics.filter(
                (diagnostic) => diagnostic.code === "agent_rendition_orphaned",
            ),
        ).toEqual([expect.objectContaining({ path: "orphan.agent.md" })])
    })

    const toolText = z.object({
        content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
        ),
    })
    it.each([
        [
            "llms-full.txt",
            async () =>
                (
                    await llmsFullResponse(
                        requestFor(hostname, "/llms-full.txt"),
                        [],
                    )
                ).text(),
        ],
        [
            "MCP read_page",
            async () => {
                const client = new Client({ name: "rendition", version: "1" })
                const server = await buildMcpServer(
                    requestFor(hostname, "/api/mcp"),
                )
                const [clientTransport, serverTransport] =
                    InMemoryTransport.createLinkedPair()
                await Promise.all([
                    server.connect(serverTransport),
                    client.connect(clientTransport),
                ])
                try {
                    const result = toolText.parse(
                        await client.callTool({
                            name: "read_page",
                            arguments: { url: "/guide" },
                        }),
                    )
                    return result.content.map((part) => part.text).join("\n")
                } finally {
                    await client.close()
                }
            },
        ],
        [
            "the context bundle",
            async () => {
                const response = await getAgentContext({
                    request: requestFor(hostname, "/api/agent/context/guide"),
                    params: { _splat: "guide" },
                })
                return z
                    .object({ markdown: z.string() })
                    .parse(await response.json()).markdown
            },
        ],
    ])("serves the rendition from %s", async (_surface, read) => {
        const body = await read()
        expect(body).toContain(`${RENDITION} for guide.`)
        expect(body).not.toContain(`${DERIVED} for guide.`)
    })
})
