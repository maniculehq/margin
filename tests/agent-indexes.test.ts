/**
 * Agent indexes against a real seeded Postgres: one site whose docs.json
 * navigation orders pages against the alphabet, with a non-default product
 * version, an external-pointer page, a redirect and a paragraph of inline
 * markdown. Every surface runs its real route handler or MCP tool in-process.
 */
import { randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { htmlPageEtag } from "@/lib/agent-content"
import { buildSitemapMarkdown, buildSitemapXml } from "@/lib/agent-surface"
import { siteScope } from "@/lib/base-path"
import { llmsIndexResponse } from "@/lib/llms-index"
import { buildMcpServer } from "@/lib/mcp-server"
import { alternateTrees, resolveDocsContext, resolvePage } from "@/lib/source"
import { getDocsMarkdown } from "../src/routes/{$}[.]md"
import { getUpdatesRss } from "../src/routes/{$}[.]rss[.]xml"
import { getAgentContext } from "../src/routes/api.agent.context.$"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

// Parentheses end a Markdown link destination: the agent surfaces must
// write the pointer percent-encoded.
const FORUM = "https://forum.example.com/a(b)c"
const FORUM_LINK = "https://forum.example.com/a%28b%29c"

const pages = [
    // Changed after every other page, which keep the seed's 2026-09-01.
    {
        path: "zeta.mdx",
        servedUrl: "/zeta",
        title: "Zeta first",
        lastModified: new Date("2026-10-01T00:00:00.000Z"),
    },
    { path: "alpha.mdx", servedUrl: "/alpha", title: "Alpha second" },
    {
        path: "notes.mdx",
        servedUrl: "/notes",
        title: "Notes",
        contents: [{ content: "Use **bold** and `code` here." }],
    },
    {
        path: "forum.mdx",
        servedUrl: "/forum",
        title: "Forum",
        frontmatter: { url: FORUM },
    },
    { path: "api/beta.mdx", servedUrl: "/api/beta", title: "Beta endpoint" },
    // A page still served at a redirect's source.
    { path: "stale.mdx", servedUrl: "/stale", title: "Stale copy" },
    // Filed under an authored tab whose name matches a version section.
    { path: "upgrade.mdx", servedUrl: "/upgrade", title: "Upgrade notes" },
    {
        path: "changelog.mdx",
        servedUrl: "/changelog",
        title: "Changelog",
        updates: [
            {
                label: "2026-09-01",
                description: "Node 20 support",
                tags: [],
                rss: null,
            },
            {
                label: "1.4.0",
                description: "Semver release",
                tags: [],
                rss: null,
            },
            {
                label: "2026-01-01T01:00:00+05:00",
                description: "Offset timestamp",
                tags: [],
                rss: null,
            },
        ],
    },
    {
        path: "v1/old.mdx",
        servedUrl: "/v1/old",
        title: "Legacy page",
        versionLabel: "v1",
    },
    {
        path: "es/index.mdx",
        servedUrl: "/es",
        title: "Inicio",
        localeLabel: "es",
    },
    {
        path: "es/v1/old.mdx",
        servedUrl: "/es/v1/old",
        title: "Página antigua",
        localeLabel: "es",
        versionLabel: "v1",
    },
]

const versionsManifest = [
    { label: "v2", directory: "", default: true, seq: 0 },
    { label: "v1", directory: "v1", default: false, seq: 1 },
]
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
// Languages nest outermost: Spanish carries its own v2 (default) and v1.
const localesManifest = [
    {
        locale: "en",
        default: true,
        directory: "",
        nav: emptyNav,
        versionsManifest,
    },
    {
        locale: "es",
        default: false,
        directory: "es",
        nav: emptyNav,
        versionsManifest: [
            { label: "v2", directory: "", default: true, seq: 0 },
            { label: "v1", directory: "es/v1", default: false, seq: 1 },
        ],
    },
]

const tab = (
    title: string,
    resolvedPages: string[],
    resolvedGroups: unknown[],
) => ({
    tab: title,
    resolvedHref: `/${resolvedPages[0]?.replace(/\.mdx$/, "")}`,
    resolvedPages,
    resolvedGroups,
})

const config = {
    name: "Nav order",
    __resolvedNav: {
        language: null,
        tabs: [
            tab(
                "Guides",
                ["zeta.mdx", "alpha.mdx", "notes.mdx", "forum.mdx"],
                [
                    {
                        title: "Start",
                        entries: [
                            { page: "zeta.mdx" },
                            { page: "alpha.mdx" },
                            { page: "notes.mdx" },
                        ],
                    },
                    {
                        title: "Community",
                        // Ingest resolves an external pointer to an href entry.
                        entries: [{ href: FORUM, label: "Forum" }],
                    },
                ],
            ),
            // An OpenAPI-only tab: membership without structure.
            tab("API", ["api/beta.mdx"], []),
            tab(
                "Version: v1",
                ["upgrade.mdx"],
                [{ entries: [{ page: "upgrade.mdx" }] }],
            ),
            tab(
                "Changelog",
                ["changelog.mdx"],
                [{ entries: [{ page: "changelog.mdx" }] }],
            ),
        ],
        anchors: [],
        dropdowns: [],
        versions: [],
        products: [],
        menu: [],
        global: null,
    },
}

const searchCorpusUrl = `data:application/gzip;base64,${gzipSync(
    JSON.stringify({
        formatVersion: 1,
        entries: pages.map((page) => ({
            path: page.path,
            structuredData: { headings: [], contents: page.contents ?? [] },
        })),
    }),
).toString("base64")}`

const siteId = randomUUID()
const versionId = randomUUID()
const hostname = siteHost(`ai-${siteId}`)

const mcpText = z.object({
    content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
})

async function callTool(name: string, args: Record<string, unknown>) {
    const client = new Client({ name: "agent-indexes", version: "1.0.0" })
    const server = await buildMcpServer(requestFor(hostname, "/api/mcp"))
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ])
    try {
        return mcpText.parse(await client.callTool({ name, arguments: args }))
            .content[0].text
    } finally {
        await Promise.all([client.close(), server.close()])
    }
}

describe.skipIf(!hasDocsDb)("agent indexes", () => {
    beforeAll(async () => {
        await db.transaction(async (transaction) => {
            await transaction.insert(schema.docsSite).values({
                id: siteId,
                slug: `ai-${siteId}`,
                name: "Nav order",
                analyticsMode: "off",
                status: "active",
            })
            await transaction.insert(schema.docsContentVersion).values({
                id: versionId,
                siteId: siteId,
                commitSha: "agent-indexes",
                kind: "production",
                seq: 1,
                status: "ready",
                config,
                versionsManifest,
                localesManifest,
                redirects: [
                    { source: "/start", destination: "/alpha" },
                    // The source still has a page; the redirect wins.
                    { source: "/stale", destination: "/alpha" },
                    // A chain: /old → /moved → /alpha.
                    { source: "/old", destination: "/moved" },
                    { source: "/moved", destination: "/alpha" },
                ],
                searchCorpusUrl,
            })
            await transaction.insert(schema.docsPage).values(
                pages.map((page) => ({
                    id: randomUUID(),
                    versionId,
                    siteId: siteId,
                    path: page.path,
                    url: page.servedUrl,
                    servedUrl: page.servedUrl,
                    slugs: page.servedUrl.split("/").filter(Boolean),
                    versionLabel: page.versionLabel ?? null,
                    localeLabel: page.localeLabel ?? null,
                    updates: page.updates ?? null,
                    title: page.title,
                    frontmatter: page.frontmatter ?? {},
                    source: `# ${page.title}\n`,
                    processedMarkdown: `# ${page.title}\n`,
                    hast: { type: "root", children: [] },
                    structuredData: {
                        headings: [],
                        contents: page.contents ?? [],
                    },
                    toc: [],
                    lastModified:
                        page.lastModified ??
                        new Date("2026-09-01T00:00:00.000Z"),
                })),
            )
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: versionId })
                .where(eq(schema.docsSite.id, siteId))
        })
    })

    afterAll(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
    })

    test("llms.txt sections follow docs.json tabs", async () => {
        const body = await (
            await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
        ).text()
        // Release history sits under llmstxt.org's `Optional` section.
        expect(body.match(/^## .+$/gm)).toEqual([
            "## Guides",
            "## API",
            "## Version: v1",
            "## Other versions",
            "## Other languages",
            "## Optional",
        ])
    })

    test("llms.txt lists a group's pages in authored order, not alphabetically", async () => {
        const body = await (
            await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
        ).text()
        expect(body.indexOf("/zeta.md")).toBeGreaterThan(-1)
        expect(body.indexOf("/zeta.md")).toBeLessThan(body.indexOf("/alpha.md"))
    })

    test("llms.txt points at the non-default version", async () => {
        const body = await (
            await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
        ).text()
        expect(body).toContain(`[v1](http://${hostname}/v1/llms.txt)`)
    })

    test("sitemap.xml lists other versions and drops external pointers", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const xml = buildSitemapXml(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        expect(xml).toContain(`<loc>http://${hostname}/alpha</loc>`)
        expect(xml).toContain(`<loc>http://${hostname}/v1/old</loc>`)
        expect(xml).not.toContain(`<loc>http://${hostname}/forum</loc>`)
    })

    test("sitemap.xml lists another language's non-default version", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const xml = buildSitemapXml(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        expect(xml).toContain(`<loc>http://${hostname}/es</loc>`)
        expect(xml).toContain(`<loc>http://${hostname}/es/v1/old</loc>`)
    })

    test("sitemap.md gives the non-default version its own section", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const markdown = buildSitemapMarkdown(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        expect(markdown).toContain(
            `## Version: v1\n\n- [Legacy page](http://${hostname}/v1/old.md)`,
        )
    })

    test("sitemap.md keeps an authored section beside a same-named version section", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const markdown = buildSitemapMarkdown(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        expect(markdown).toContain(
            `## Version: v1\n\n- [Upgrade notes](http://${hostname}/upgrade.md)`,
        )
        expect(markdown).toContain(
            `## Version: v1\n\n- [Legacy page](http://${hostname}/v1/old.md)`,
        )
    })

    test("MCP get_navigation returns navigation sections, not the loader tree", async () => {
        const navigation = z
            .object({
                sections: z.array(
                    z.object({
                        section: z.string(),
                        pages: z.array(z.object({ url: z.string() })),
                    }),
                ),
                otherScopes: z.array(z.object({ url: z.string() })),
            })
            .parse(JSON.parse(await callTool("get_navigation", {})))
        expect(navigation.sections[0]).toEqual({
            section: "Guides › Start",
            pages: [
                expect.objectContaining({ url: "/zeta" }),
                expect.objectContaining({ url: "/alpha" }),
                expect.objectContaining({ url: "/notes" }),
            ],
        })
        expect(navigation.otherScopes).toEqual([
            expect.objectContaining({ url: "/v1" }),
            expect.objectContaining({ url: "/es" }),
            expect.objectContaining({ url: "/es/v1" }),
        ])
    })

    test("MCP list_docs lists pages in navigation order", async () => {
        const listing = z
            .object({ pages: z.array(z.object({ url: z.string() })) })
            .parse(JSON.parse(await callTool("list_docs", {})))
        expect(listing.pages.map((page) => page.url)).toEqual([
            "/zeta",
            "/alpha",
            "/notes",
            "/forum",
            "/api/beta",
            "/upgrade",
            "/changelog",
            "/stale",
        ])
    })

    test("MCP search_docs returns plain text, without markdown or <mark>", async () => {
        const { results } = z
            .object({
                results: z.array(
                    z.object({ type: z.string(), content: z.string() }),
                ),
            })
            .parse(JSON.parse(await callTool("search_docs", { query: "bold" })))
        expect(results.filter((row) => row.type === "text")).toEqual([
            expect.objectContaining({ content: "Use bold and code here." }),
        ])
    })

    test("MCP read_page follows a configured redirect", async () => {
        expect(await callTool("read_page", { url: "/start" })).toMatch(
            /^# Alpha second \(\/alpha\)/,
        )
    })

    test("MCP read_page follows a redirect chain", async () => {
        expect(await callTool("read_page", { url: "/old" })).toMatch(
            /^# Alpha second \(\/alpha\)/,
        )
    })

    test("MCP read_page prefers a configured redirect over a page at its source", async () => {
        expect(await callTool("read_page", { url: "/stale" })).toMatch(
            /^# Alpha second \(\/alpha\)/,
        )
    })

    test("the .md twin prefers a configured redirect over a page at its source", async () => {
        const response = await getDocsMarkdown({
            request: requestFor(hostname, "/stale.md"),
            params: { _splat: "stale" },
        }).catch((thrown: unknown) => thrown)
        expect(
            z
                .object({
                    options: z.object({
                        href: z.string(),
                        statusCode: z.number(),
                    }),
                })
                .parse(response).options,
        ).toEqual({ href: "/alpha.md", statusCode: 308 })
    })

    test("MCP read_page follows the case-insensitive fallback", async () => {
        expect(await callTool("read_page", { url: "/ALPHA" })).toMatch(
            /^# Alpha second \(\/alpha\)/,
        )
    })

    test("the .md twin redirects a miscased path to the canonical spelling", async () => {
        const response = await getDocsMarkdown({
            request: requestFor(hostname, "/ALPHA.md"),
            params: { _splat: "ALPHA" },
        }).catch((thrown: unknown) => thrown)
        expect(
            z
                .object({
                    options: z.object({
                        href: z.string(),
                        statusCode: z.number(),
                    }),
                })
                .parse(response).options,
        ).toEqual({ href: "/alpha.md", statusCode: 308 })
    })

    test("llms.txt links an external pointer's destination, not its stub twin", async () => {
        const body = await (
            await llmsIndexResponse(requestFor(hostname, "/llms.txt"), [])
        ).text()
        expect(body).toContain(`- [Forum](${FORUM_LINK})`)
        expect(body).not.toContain("/forum.md")
    })

    test("an external pointer keeps its authored navigation group", async () => {
        // The pointer's URL carries parentheses, which the agent surfaces
        // escape when writing links; matching the nav entry uses the raw URL.
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const markdown = buildSitemapMarkdown(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        const start = markdown.indexOf("## Guides › Community")
        expect(start).toBeGreaterThan(-1)
        const section = markdown.slice(
            start,
            markdown.indexOf("\n## ", start + 1),
        )
        expect(section).toContain(`- [Forum](${FORUM_LINK})`)
    })

    test("sitemap.md links an external pointer's destination, not its stub twin", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/"))
        const markdown = buildSitemapMarkdown(
            `http://${hostname}`,
            ctx,
            await alternateTrees(ctx),
        )
        expect(markdown).toContain(`- [Forum](${FORUM_LINK})`)
        expect(markdown).not.toContain("/forum.md")
    })

    test("related-page links point an external pointer at its destination", async () => {
        // zeta, alpha, notes and forum share a navigation group, so forum is
        // one of alpha's related pages.
        const response = await getDocsMarkdown({
            request: requestFor(hostname, "/alpha.md"),
            params: { _splat: "alpha" },
        })
        const related = (await response.text()).match(/^Related: .*$/m)?.[0]
        expect(related).toContain(`[Forum](${FORUM_LINK})`)
        expect(related).not.toContain("/forum.md")
    })

    test("an external pointer's markdown names its destination", async () => {
        const response = await getDocsMarkdown({
            request: requestFor(hostname, "/forum.md"),
            params: { _splat: "forum" },
        })
        expect(await response.text()).toContain(
            `This page points to an external site: <${FORUM_LINK}>`,
        )
    })

    test("the RSS twin serves a changelog feed", async () => {
        const response = await getUpdatesRss({
            request: requestFor(hostname, "/changelog.rss.xml"),
            params: { _splat: "changelog" },
        })
        expect(response.status).toBe(200)
    })

    // V8 dates '1.4.0' to 4 January 2000, so a parse alone is no evidence
    // that a label is a date.
    test("the RSS twin dates no entry whose label lacks its year", async () => {
        const response = await getUpdatesRss({
            request: requestFor(hostname, "/changelog.rss.xml"),
            params: { _splat: "changelog" },
        })
        const text = await response.text()
        expect(text).toContain("<pubDate>Tue, 01 Sep 2026")
        expect(text).toMatch(
            /<title>Semver release<\/title><link>[^<]*<\/link><guid[^>]*>[^<]*<\/guid><\/item>/,
        )
    })

    // The +05:00 offset puts this label's UTC instant in 2025.
    test("the RSS twin dates a timestamp whose offset changes its year", async () => {
        const response = await getUpdatesRss({
            request: requestFor(hostname, "/changelog.rss.xml"),
            params: { _splat: "changelog" },
        })
        const text = await response.text()
        expect(text).toMatch(
            /<title>Offset timestamp<\/title><link>[^<]*<\/link><guid[^>]*>[^<]*<\/guid><pubDate>Wed, 31 Dec 2025 20:00:00 GMT<\/pubDate>/,
        )
    })

    test("the RSS twin 404s a page without updates", async () => {
        const response = await getUpdatesRss({
            request: requestFor(hostname, "/alpha.rss.xml"),
            params: { _splat: "alpha" },
        })
        expect(response.status).toBe(404)
    })

    // Attaching a domain moves the site's address (public origin and base
    // path) without a new content version, and every link a page carries
    // names it: a browser's conditional request from before the move must
    // get the page again, not a 304.
    const atPlatform = { basePath: "", publicOrigin: null }
    const atDomain = { basePath: "/help", publicOrigin: "https://acme.example" }

    test.each([
        {
            surface: "a page's markdown",
            path: "/alpha.md",
            serve: getDocsMarkdown,
        },
        {
            surface: "the context bundle",
            path: "/api/agent/context/alpha",
            serve: getAgentContext,
        },
    ])(
        "$surface revalidates when the site's address changes",
        async ({ path, serve }) => {
            const fetchAt = (
                scope: { basePath: string; publicOrigin: string | null },
                etag?: string,
            ) =>
                siteScope().run(
                    { ...scope, sharedClientAddress: false },
                    () => {
                        const request = requestFor(hostname, path)
                        if (etag) request.headers.set("if-none-match", etag)
                        return serve({ request, params: { _splat: "alpha" } })
                    },
                )
            const first = await fetchAt(atPlatform)
            const etag = first.headers.get("etag") ?? ""
            expect(etag).not.toBe("")
            expect((await fetchAt(atPlatform, etag)).status).toBe(304)
            const moved = await fetchAt(atDomain, etag)
            expect(moved.status).toBe(200)
            expect(await moved.text()).toContain("(/help/alpha)")
        },
    )

    describe("/changes.md", () => {
        async function changesSince(since: string): Promise<Response> {
            const { Route } = await import("../src/routes/changes[.]md")
            const handlers = Route.options.server?.handlers
            if (!handlers || typeof handlers === "function")
                throw new Error("/changes.md declares no handler map")
            const get = handlers.GET
            if (typeof get !== "function")
                throw new Error("/changes.md declares no GET handler")
            const result = await get({
                request: requestFor(
                    hostname,
                    `/changes.md?since=${encodeURIComponent(since)}`,
                ),
                params: {},
                context: undefined,
                pathname: "/changes.md",
                next: () => {
                    throw new Error("/changes.md must answer itself")
                },
            })
            if (!(result instanceof Response))
                throw new Error("/changes.md did not answer with a Response")
            return result
        }

        test("answers 400 for a since that is not a date", async () => {
            const response = await changesSince("not-a-date")
            expect(response.status).toBe(400)
            expect(await response.text()).toContain("ISO 8601")
        })

        test("lists only pages changed after since", async () => {
            const response = await changesSince("2026-09-15T00:00:00Z")
            expect(response.status).toBe(200)
            const body = await response.text()
            expect(body).toContain("[Zeta first](")
            expect(body).not.toContain("[Alpha second](")
        })

        test("says no pages changed when since is after every change", async () => {
            const response = await changesSince("2999-01-01T00:00:00Z")
            expect(response.status).toBe(200)
            const body = await response.text()
            expect(body).toBe(
                "# Changes\n\nNo pages changed since 2999-01-01T00:00:00.000Z.\n\n",
            )
        })
    })

    test("the document's validator names the site's address", async () => {
        const ctx = await resolveDocsContext(requestFor(hostname, "/alpha"), [
            "alpha",
        ])
        const page = await resolvePage(ctx, ctx.source, ["alpha"])
        if (!page) throw new Error("/alpha did not resolve")
        expect(
            htmlPageEtag(ctx, page, null, "https://acme.example/help"),
        ).not.toBe(htmlPageEtag(ctx, page, null, `http://${hostname}`))
    })
})
