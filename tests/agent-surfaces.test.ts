/**
 * The agent surfaces built from a version's rows: path-scoped and split
 * llms.txt indexes, the read-only docs filesystem and the rest of the MCP
 * server, and Agent Skills digests. Live against the seeded worktree
 * Postgres; each test seeds its own site and drops it.
 */
import { createHash, randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { eq } from "drizzle-orm"
import { describe, expect, test, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import {
    skillCatalog,
    skillFileResponse,
    skillsIndexBody,
} from "@/lib/agent-skills"
import {
    LLMS_INDEX_MAX_CHARS,
    llmsIndexResponse,
    scopedLlmsRequest,
} from "@/lib/llms-index"
import { buildMcpServer } from "@/lib/mcp-server"
import { resolveDocsContext } from "@/lib/source"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

// MCP assertions exercise filesystem behavior; load the interpreter before
// test deadlines begin rather than charging its cold import to the first call.
await import("just-bash")

const emptyNav = {
    language: null,
    tabs: [],
    anchors: [],
    dropdowns: [],
    versions: [],
    products: [],
    menu: [],
    global: null,
}

const localesManifest = [
    {
        locale: "en",
        default: true,
        directory: "",
        nav: emptyNav,
        versionsManifest: [],
    },
    {
        locale: "fr",
        default: false,
        directory: "fr",
        nav: emptyNav,
        versionsManifest: [],
    },
]

interface SeedPage {
    servedUrl: string
    title: string
    locale?: string | null
    description?: string
    body?: string
}

async function seedSite(
    pages: SeedPage[],
    config: Record<string, unknown> = { name: "Agent surfaces" },
): Promise<{ siteId: string; hostname: string }> {
    const siteId = randomUUID()
    const versionId = randomUUID()
    const slug = `as-${siteId}`
    await db.transaction(async (tx) => {
        await tx.insert(schema.docsSite).values({
            id: siteId,
            slug,
            name: "Agent surfaces",
            analyticsMode: "off",
            status: "active",
        })
        await tx.insert(schema.docsContentVersion).values({
            id: versionId,
            siteId: siteId,
            commitSha: "agent-surfaces",
            kind: "production",
            seq: 1,
            status: "ready",
            searchCorpus: new Uint8Array(0),
            config,
            localesManifest,
        })
        await tx.insert(schema.docsPage).values(
            pages.map((page) => {
                const body = page.body ?? `# ${page.title}\n`
                return {
                    id: randomUUID(),
                    versionId,
                    siteId: siteId,
                    path: `${page.servedUrl.slice(1) || "index"}.mdx`,
                    url: page.servedUrl,
                    servedUrl: page.servedUrl,
                    slugs: page.servedUrl.split("/").filter(Boolean),
                    localeLabel: page.locale ?? null,
                    hidden: false,
                    title: page.title,
                    description: page.description ?? null,
                    frontmatter: {},
                    source: body,
                    processedMarkdown: body,
                    hast: { type: "root", children: [] },
                    structuredData: { headings: [], contents: [] },
                    toc: [],
                    lastModified: new Date("2026-09-01T00:00:00.000Z"),
                }
            }),
        )
        await tx
            .update(schema.docsSite)
            .set({ currentVersionId: versionId })
            .where(eq(schema.docsSite.id, siteId))
    })
    return {
        siteId,
        hostname: siteHost(slug),
    }
}

async function dropSite(siteId: string) {
    await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
}

const basePages: SeedPage[] = [
    { servedUrl: "/", title: "Home" },
    {
        servedUrl: "/guide",
        title: "Guide",
        body: "# Guide\n\nConfigure the widget with `WIDGET_TOKEN`.\n",
    },
    { servedUrl: "/fr", title: "Accueil", locale: "fr" },
    { servedUrl: "/fr/guide", title: "Guide FR", locale: "fr" },
]

const mdLinks = (body: string) =>
    [...body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1] ?? "")

async function connect(hostname: string) {
    const client = new Client({ name: "agent-surfaces", version: "1.0.0" })
    const server = await buildMcpServer(requestFor(hostname, "/api/mcp"))
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ])
    return client
}

describe.skipIf(!hasDocsDb)("path-scoped llms.txt", () => {
    test("a locale-scoped index lists only that locale's pages", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        try {
            const response = scopedLlmsRequest(
                requestFor(hostname, "/fr/llms.txt"),
            )
            expect(response).not.toBeNull()
            const resolved = await response
            expect(resolved?.status).toBe(200)
            const links = mdLinks((await resolved?.text()) ?? "")
            expect(links.some((link) => link.endsWith("/fr/guide.md"))).toBe(
                true,
            )
            expect(
                links.filter(
                    (link) =>
                        /\/guide\.md$/.test(link) && !link.includes("/fr/"),
                ),
            ).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("the root index carries the config $schema when markdown.schema is true", async () => {
        const { siteId, hostname } = await seedSite(basePages, {
            name: "Agent surfaces",
            $schema: "https://schema.example/docs.json",
            markdown: { schema: true },
        })
        try {
            const body = await (
                await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
            ).text()
            expect(body).toContain("$schema: https://schema.example/docs.json")
        } finally {
            await dropSite(siteId)
        }
    })

    test("a path with no pages beneath it is a 404, not an empty index", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        try {
            const response = await scopedLlmsRequest(
                requestFor(hostname, "/nowhere/llms.txt"),
            )
            expect(response?.status).toBe(404)
        } finally {
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("split llms.txt", () => {
    // Enough long-described pages in two sections to pass the index cap.
    const description =
        "Describes one endpoint of the service in enough words to make the index long. ".repeat(
            4,
        )
    const sectionPages = (section: string) =>
        Array.from(
            {
                length:
                    Math.ceil(LLMS_INDEX_MAX_CHARS / 2 / description.length) +
                    20,
            },
            (_, i) => ({
                servedUrl: `/${section}/page-${i}`,
                title: `${section} page ${i}`,
                description,
            }),
        )
    const pages = [
        { servedUrl: "/", title: "Home" },
        ...sectionPages("alpha"),
        ...sectionPages("beta"),
    ]

    test("past the cap the root index becomes a directory of sub-indexes", async () => {
        const { siteId, hostname } = await seedSite(pages)
        try {
            const body = await (
                await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
            ).text()
            expect(body.length).toBeLessThanOrEqual(LLMS_INDEX_MAX_CHARS)
            expect(body).toContain("## Indexes")
            const subIndexes = mdLinks(body).filter((link) =>
                link.includes("/_llms/"),
            )
            expect(subIndexes).toHaveLength(2)
        } finally {
            await dropSite(siteId)
        }
    })

    test("each sub-index lists exactly its own section's pages", async () => {
        const { siteId, hostname } = await seedSite(pages)
        try {
            const root = await (
                await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
            ).text()
            const alpha = mdLinks(root).find((link) =>
                /\/_llms\/[^)]*alpha[^)]*\.txt$/.test(link),
            )
            expect(alpha).toBeDefined()
            const response = await scopedLlmsRequest(
                requestFor(hostname, new URL(alpha ?? "").pathname),
            )
            expect(response?.status).toBe(200)
            const links = mdLinks((await response?.text()) ?? "")
            expect(links).toHaveLength(sectionPages("alpha").length)
            expect(links.every((link) => link.includes("/alpha/"))).toBe(true)
        } finally {
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("split llms.txt without sections", () => {
    const description =
        "Describes one endpoint of the service in enough words to make the index long. ".repeat(
            4,
        )
    // A flat tree: no breadcrumb sections to split by, yet past the cap.
    const flatPages = Array.from(
        {
            length:
                Math.ceil((LLMS_INDEX_MAX_CHARS * 1.5) / description.length) +
                20,
        },
        (_, i) => ({
            servedUrl: `/page-${i}`,
            title: `Flat page ${i}`,
            description,
        }),
    )

    test("a flat index past the cap splits into parts that cover every page once", async () => {
        const { siteId, hostname } = await seedSite([
            { servedUrl: "/", title: "Home" },
            ...flatPages,
        ])
        try {
            const root = await (
                await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
            ).text()
            expect(root.length).toBeLessThanOrEqual(LLMS_INDEX_MAX_CHARS)
            const parts = mdLinks(root).filter((link) =>
                /\/_llms\/part-\d+\.txt$/.test(link),
            )
            expect(parts.length).toBeGreaterThan(1)
            const listed: string[] = []
            for (const part of parts) {
                const response = await scopedLlmsRequest(
                    requestFor(hostname, new URL(part).pathname),
                )
                expect(response?.status).toBe(200)
                const body = (await response?.text()) ?? ""
                expect(body.length).toBeLessThanOrEqual(LLMS_INDEX_MAX_CHARS)
                listed.push(
                    ...mdLinks(body).filter((link) =>
                        /\/page-\d+\.md$/.test(link),
                    ),
                )
            }
            expect(listed).toHaveLength(flatPages.length)
            expect(new Set(listed).size).toBe(flatPages.length)
        } finally {
            await dropSite(siteId)
        }
    })

    test("a malformed scoped path is no agent file", async () => {
        expect(
            scopedLlmsRequest(requestFor("any.invalid", "/%E0%A4%A/llms.txt")),
        ).toBeNull()
    })
})

describe.skipIf(!hasDocsDb)("MCP server", () => {
    const toolText = z.object({
        structuredContent: z.object({
            stdout: z.string(),
            exitCode: z.number(),
        }),
    })

    test("query_docs_filesystem greps page bodies at their .md paths", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        const client = await connect(hostname)
        try {
            const result = toolText.parse(
                await client.callTool({
                    name: "query_docs_filesystem",
                    arguments: { command: "rg -l WIDGET_TOKEN /" },
                }),
            )
            expect(result.structuredContent.exitCode).toBe(0)
            expect(result.structuredContent.stdout.trim()).toBe("/guide.md")
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })

    test("query_docs_filesystem refuses commands outside the read-only set", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        const client = await connect(hostname)
        try {
            const listed = toolText.parse(
                await client.callTool({
                    name: "query_docs_filesystem",
                    arguments: { command: "ls /guide.md" },
                }),
            )
            expect(listed.structuredContent.exitCode).toBe(0)
            const removed = toolText.parse(
                await client.callTool({
                    name: "query_docs_filesystem",
                    arguments: { command: "rm /guide.md" },
                }),
            )
            expect(removed.structuredContent.exitCode).not.toBe(0)
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })

    test("initialize carries generated and site instructions", async () => {
        const { siteId, hostname } = await seedSite(basePages, {
            name: "Agent surfaces",
            "x-margin": {
                agents: { mcpInstructions: "Always quote the API version." },
            },
        })
        const client = await connect(hostname)
        try {
            const instructions = client.getInstructions() ?? ""
            expect(instructions).toContain("submit_feedback")
            expect(instructions).toContain("Always quote the API version.")
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })

    test("every page is a readable resource", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        const client = await connect(hostname)
        try {
            const { resources } = await client.listResources()
            expect(resources.map((r) => r.uri)).toContain("docs://page/guide")
            const read = await client.readResource({ uri: "docs://page/guide" })
            const content = z
                .tuple([z.object({ text: z.string() })])
                .parse(read.contents)
            expect(content[0].text).toContain("WIDGET_TOKEN")
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })

    test("prompts are listed and render the question", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        const client = await connect(hostname)
        try {
            const { prompts } = await client.listPrompts()
            expect(prompts.map((p) => p.name).sort()).toEqual([
                "answer_from_docs",
                "implement_with_docs",
            ])
            const prompt = await client.getPrompt({
                name: "answer_from_docs",
                arguments: { question: "How do I rotate keys?" },
            })
            expect(JSON.stringify(prompt.messages)).toContain(
                "How do I rotate keys?",
            )
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("Agent Skills", () => {
    test("the generated skill's index digest matches the bytes its URL serves", async () => {
        const { siteId, hostname } = await seedSite(basePages)
        try {
            const request = requestFor(
                hostname,
                "/.well-known/agent-skills/index.json",
            )
            const ctx = await resolveDocsContext(request)
            const origin = `http://${hostname}`
            const skills = await skillCatalog(ctx, origin)
            const index = z
                .object({
                    skills: z.tuple([
                        z.object({ name: z.string(), digest: z.string() }),
                    ]),
                })
                .parse(skillsIndexBody(skills, origin, "v0.2.0"))
            const served = await skillFileResponse(
                skills,
                index.skills[0].name,
                "SKILL.md",
                agentConfig.cache.header,
            ).text()
            expect(served.startsWith("---\nname: ")).toBe(true)
            expect(index.skills[0].digest).toBe(
                `sha256:${createHash("sha256").update(served, "utf8").digest("hex")}`,
            )
        } finally {
            await dropSite(siteId)
        }
    })
})
