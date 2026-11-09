/**
 * Statement budgets for request resolution, captured at Drizzle's pg Pool
 * during each request. Tests run sequentially: the spy
 * sees every statement this worker issues.
 */
import { randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import {
    Client,
    InMemoryTransport,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { and, eq, like } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { htmlPageEtag, searchServerFor } from "@/lib/agent-content"
import { siteScope, siteUrlFromRequest } from "@/lib/base-path"
import { buildMcpServer, MCP_TOOL_NAMES } from "@/lib/mcp-server"
import {
    pageBodyFor,
    resolveDocsContext,
    resolvePage,
    resolvePageCaseInsensitive,
    resolveSiteVersion,
    servedUrlsPresent,
    structuredDataFor,
} from "@/lib/source"
import { handleMcp } from "@/routes/api/mcp"
import { getDocsOgImage } from "@/routes/og/docs/$"
import { getDocsMarkdown } from "../src/routes/{$}[.]md"
import { getDocsPdf } from "../src/routes/{$}[.]pdf"
import { getUpdatesRss } from "../src/routes/{$}[.]rss[.]xml"
import { getAgentContext } from "../src/routes/api.agent.context.$"
import { hasDocsDb, requestFor } from "./context"
import { previewHost, siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

// The billed model is the one external boundary the chat gate tests mock.
// The conversion ahead of it stays real; its inputs are recorded.
const streamText = vi.hoisted(() =>
    vi.fn(() => ({
        toUIMessageStreamResponse: () => new Response("streamed"),
    })),
)
const modelInputs = vi.hoisted((): unknown[][] => [])
vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>()
    return {
        ...actual,
        streamText: () => streamText(),
        convertToModelMessages: (
            ...args: Parameters<typeof actual.convertToModelMessages>
        ) => {
            modelInputs.push(args[0])
            return actual.convertToModelMessages(...args)
        },
    }
})

const queryTextSchema = z.union([
    z.string(),
    z.object({ text: z.string() }).transform((query) => query.text),
])

/** Run `run` and return every SQL statement the pool saw meanwhile. */
async function capture<T>(
    run: () => Promise<T>,
): Promise<{ result: T; statements: string[] }> {
    const spy = vi.spyOn(db.$client, "query")
    try {
        const result = await run()
        const statements = spy.mock.calls.flatMap((call) => {
            const parsed = queryTextSchema.safeParse(call[0])
            return parsed.success ? [parsed.data] : []
        })
        return { result, statements }
    } finally {
        spy.mockRestore()
    }
}

const isPointerJoin = (statement: string) =>
    statement.includes('"docs_site"."current_version_id"')
const readsServedUrl = (statement: string) => statement.includes("served_url")
const readsDocsPage = (statement: string) =>
    statement.includes('from "docs_page"')

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

const pages = [
    { path: "index.mdx", servedUrl: "/", title: "Home", locale: null },
    { path: "guide.mdx", servedUrl: "/guide", title: "Guide", locale: null },
    {
        path: "secret.mdx",
        servedUrl: "/Secret-Page",
        title: "Secret",
        locale: null,
        hidden: true,
    },
    { path: "fr/index.mdx", servedUrl: "/fr", title: "Accueil", locale: "fr" },
    {
        path: "fr/guide.mdx",
        servedUrl: "/fr/guide",
        title: "Guide FR",
        locale: "fr",
    },
    {
        path: "changelog.mdx",
        servedUrl: "/changelog",
        title: "Changelog",
        locale: null,
        updates: [
            {
                label: "2026-09-01",
                description: "Node 20 support",
                tags: ["SDK"],
                rss: null,
            },
        ],
    },
]

const structuredData = {
    headings: [{ id: "setup", content: "Setup" }],
    contents: [],
}

/** The ingest-shaped search corpus blob, inlined as a data: URL. */
const searchCorpusUrl = `data:application/gzip;base64,${gzipSync(
    JSON.stringify({
        formatVersion: 1,
        entries: pages.map((page) => ({ path: page.path, structuredData })),
    }),
).toString("base64")}`

/** One ready multi-locale version (production, or a preview by commit). */
async function seedSite(
    input: {
        preview?: string
        config?: Record<string, unknown>
        seo?: Record<string, unknown>
    } = {},
): Promise<{ siteId: string; versionId: string; hostname: string }> {
    const siteId = randomUUID()
    const versionId = randomUUID()
    const slug = `qc-${siteId}`
    await db.transaction(async (transaction) => {
        await transaction.insert(schema.docsSite).values({
            id: siteId,
            slug,
            name: "Query counts",
            analyticsMode: "off",
            status: "active",
        })
        await transaction.insert(schema.docsContentVersion).values({
            id: versionId,
            siteId: siteId,
            commitSha: input.preview ?? "counts",
            kind: input.preview ? "preview" : "production",
            seq: 1,
            status: "ready",
            config: input.config ?? { name: "Query counts" },
            ...(input.seo ? { seo: input.seo } : {}),
            localesManifest,
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
                localeLabel: page.locale,
                hidden: page.hidden ?? false,
                updates: page.updates ?? null,
                title: page.title,
                frontmatter: {},
                source: `# ${page.title}\n`,
                processedMarkdown: `# ${page.title}\n`,
                hast: { type: "root", children: [] },
                structuredData,
                toc: [],
                lastModified: new Date("2026-09-01T00:00:00.000Z"),
            })),
        )
        if (!input.preview)
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: versionId })
                .where(eq(schema.docsSite.id, siteId))
    })
    return {
        siteId,
        versionId,
        hostname: input.preview
            ? previewHost(input.preview, slug)
            : siteHost(slug),
    }
}

async function dropSite(siteId: string) {
    await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
}

/** The server work of one SSR document for `path`: the root loader's context
 * and home probe, then the page loader's context, page, body and
 * language-selector probe — all on one Request, as Start runs them. */
async function renderDocument(hostname: string, path: string) {
    const request = requestFor(hostname, path)
    const slugs = path.split("/").filter(Boolean)
    const root = await resolveDocsContext(request)
    await servedUrlsPresent(root, ["/fr"])
    const ctx = await resolveDocsContext(request, slugs)
    const page = await resolvePage(ctx, ctx.source, slugs)
    if (!page) throw new Error(`${path} did not resolve`)
    await pageBodyFor(ctx, page.data.sourcePath)
    return servedUrlsPresent(ctx, ["/guide", "/fr/guide", "/", "/fr"])
}

describe.skipIf(!hasDocsDb)("docs request resolution statements", () => {
    test("a warm SSR document reads the pointer once and never queries served_url", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            await renderDocument(hostname, "/guide")
            const { result, statements } = await capture(() =>
                renderDocument(hostname, "/guide"),
            )
            expect([...result].sort()).toEqual([
                "/",
                "/fr",
                "/fr/guide",
                "/guide",
            ])
            expect(statements.filter(isPointerJoin)).toHaveLength(1)
            expect(statements.filter(readsServedUrl)).toEqual([])
            // Pointer gate + page body.
            expect(statements).toHaveLength(2)
        } finally {
            await dropSite(siteId)
        }
    })

    test("a 404 probe issues no served_url query", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            await renderDocument(hostname, "/guide")
            const { result, statements } = await capture(async () => {
                const request = requestFor(hostname, "/missing")
                const ctx = await resolveDocsContext(request, ["missing"])
                return {
                    page: await resolvePage(ctx, ctx.source, ["missing"]),
                    canonical: await resolvePageCaseInsensitive(ctx, [
                        "missing",
                    ]),
                }
            })
            expect(result).toEqual({ page: null, canonical: null })
            expect(statements.filter(readsServedUrl)).toEqual([])
            expect(statements).toHaveLength(1)
        } finally {
            await dropSite(siteId)
        }
    })

    test("hidden rows and case-insensitive spellings resolve from the version's memoized rows", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const ctx = await resolveDocsContext(
                requestFor(hostname, "/Secret-Page"),
                ["Secret-Page"],
            )
            const { result, statements } = await capture(async () => ({
                hidden: await resolvePage(ctx, ctx.source, ["Secret-Page"]),
                canonical: await resolvePageCaseInsensitive(ctx, [
                    "secret-page",
                ]),
            }))
            expect(result.hidden?.data.title).toBe("Secret")
            expect(result.canonical).toBe("/Secret-Page")
            expect(statements).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("a head-only surface never reads docs_page", async () => {
        const { siteId, versionId, hostname } = await seedSite()
        try {
            const { result, statements } = await capture(() =>
                resolveSiteVersion(requestFor(hostname, "/favicon.ico")),
            )
            expect(result.versionId).toBe(versionId)
            expect(
                statements.filter((statement) =>
                    statement.includes('from "docs_page"'),
                ),
            ).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("a warm preview host reads the version id, not its artifact columns", async () => {
        const sha = "abcdef0123456789abcdef0123456789abcdef01"
        const { siteId, versionId, hostname } = await seedSite({
            preview: sha,
        })
        try {
            await resolveSiteVersion(requestFor(hostname))
            const { result, statements } = await capture(() =>
                resolveSiteVersion(requestFor(hostname)),
            )
            expect(result.versionId).toBe(versionId)
            expect(result.config?.name).toBe("Query counts")
            expect(statements).toHaveLength(1)
            expect(statements[0]).not.toContain("theme_css")
        } finally {
            await dropSite(siteId)
        }
    })

    test("a suspended site goes dark on the next request", async () => {
        const { siteId, versionId, hostname } = await seedSite()
        try {
            const served = await resolveSiteVersion(requestFor(hostname))
            expect(served.versionId).toBe(versionId)
            await db
                .update(schema.docsSite)
                .set({ status: "suspended" })
                .where(eq(schema.docsSite.id, siteId))
            const next = await resolveSiteVersion(requestFor(hostname))
            expect(next.versionId).toBeNull()
        } finally {
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("changelog reads never load the MDX source", () => {
    test("the page body read selects updates, not source", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const ctx = await resolveDocsContext(
                requestFor(hostname, "/changelog"),
                ["changelog"],
            )
            const page = await resolvePage(ctx, ctx.source, ["changelog"])
            if (!page) throw new Error("/changelog did not resolve")
            const { result, statements } = await capture(() =>
                pageBodyFor(ctx, page.data.sourcePath),
            )
            expect(result?.updates?.map((update) => update.tags)).toEqual([
                ["SDK"],
            ])
            const bodyReads = statements.filter(readsDocsPage)
            expect(bodyReads).toHaveLength(1)
            expect(bodyReads[0]).toContain('"updates"')
            expect(bodyReads[0]).not.toContain('"source"')
        } finally {
            await dropSite(siteId)
        }
    })

    test("the RSS feed reads only the updates column", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = () =>
                getUpdatesRss({
                    request: requestFor(hostname, "/changelog.rss.xml"),
                    params: { _splat: "changelog" },
                })
            await read()
            const { result, statements } = await capture(read)
            expect(result.status).toBe(200)
            expect(await result.text()).toContain(
                "<title>Node 20 support</title>",
            )
            const pageReads = statements.filter(readsDocsPage)
            expect(pageReads).toHaveLength(1)
            expect(pageReads[0]).toMatch(/^select "updates" from "docs_page"/)
        } finally {
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("conditional reads by identity ETag", () => {
    test("a .md revalidation answers 304 without reading docs_page", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = (etag?: string) =>
                getDocsMarkdown({
                    request: new Request("http://placeholder.local/guide.md", {
                        headers: {
                            host: hostname,
                            ...(etag ? { "if-none-match": etag } : {}),
                        },
                    }),
                    params: { _splat: "guide" },
                })
            const etag = (await read()).headers.get("etag")
            expect(etag).toMatch(/^W\/"/)
            const { result, statements } = await capture(() =>
                read(etag ?? undefined),
            )
            expect(result.status).toBe(304)
            expect(statements.filter(readsDocsPage)).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("a .md 200 reads the page body once", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = () =>
                getDocsMarkdown({
                    request: requestFor(hostname, "/guide.md"),
                    params: { _splat: "guide" },
                })
            await read()
            const { result, statements } = await capture(read)
            expect(result.status).toBe(200)
            expect(await result.text()).toContain("# Guide")
            expect(statements.filter(readsDocsPage)).toHaveLength(1)
        } finally {
            await dropSite(siteId)
        }
    })

    test("a context bundle 200 reads docs_page once", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = () =>
                getAgentContext({
                    request: requestFor(hostname, "/api/agent/context/guide"),
                    params: { _splat: "guide" },
                })
            await read()
            const { result, statements } = await capture(read)
            expect(result.status).toBe(200)
            const bundle = z
                .object({
                    headings: z.array(
                        z.object({ id: z.string(), content: z.string() }),
                    ),
                    codeExamples: z.array(z.unknown()),
                    markdown: z.string(),
                })
                .parse(await result.json())
            expect(bundle.headings).toEqual([{ id: "setup", content: "Setup" }])
            expect(bundle.codeExamples).toEqual([])
            expect(bundle.markdown).toContain("# Guide")
            expect(statements.filter(readsDocsPage)).toHaveLength(1)
        } finally {
            await dropSite(siteId)
        }
    })

    test("a context summary reads only structured_data and omits the body", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = () =>
                getAgentContext({
                    request: requestFor(
                        hostname,
                        "/api/agent/context/guide?view=summary",
                    ),
                    params: { _splat: "guide" },
                })
            await read()
            const { result, statements } = await capture(read)
            expect(result.status).toBe(200)
            expect(result.headers.get("etag")).toMatch(/:summary2"$/)
            const summary = z
                .record(z.string(), z.unknown())
                .parse(await result.json())
            expect(summary).not.toHaveProperty("markdown")
            expect(summary).not.toHaveProperty("codeExamples")
            expect(summary.headings).toEqual([
                { id: "setup", content: "Setup" },
            ])
            const pageReads = statements.filter(readsDocsPage)
            expect(pageReads).toHaveLength(1)
            expect(pageReads[0]).toMatch(
                /^select "structured_data" from "docs_page"/,
            )
        } finally {
            await dropSite(siteId)
        }
    })

    test("an unknown context view serves the full bundle", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = (search: string) =>
                getAgentContext({
                    request: requestFor(
                        hostname,
                        `/api/agent/context/guide${search}`,
                    ),
                    params: { _splat: "guide" },
                })
            const full = await read("")
            const bogus = await read("?view=bogus")
            expect(bogus.status).toBe(200)
            expect(bogus.headers.get("etag")).toBe(full.headers.get("etag"))
            const bundle = z
                .object({ markdown: z.string(), truncated: z.boolean() })
                .parse(await bogus.json())
            expect(bundle.markdown).toContain("# Guide")
            expect(bundle.truncated).toBe(false)
        } finally {
            await dropSite(siteId)
        }
    })

    test("a context bundle revalidation answers 304 without reading docs_page", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const read = (etag?: string) =>
                getAgentContext({
                    request: new Request(
                        "http://placeholder.local/api/agent/context/guide",
                        {
                            headers: {
                                host: hostname,
                                ...(etag ? { "if-none-match": etag } : {}),
                            },
                        },
                    ),
                    params: { _splat: "guide" },
                })
            const etag = (await read()).headers.get("etag")
            const { result, statements } = await capture(() =>
                read(etag ?? undefined),
            )
            expect(result.status).toBe(304)
            expect(statements.filter(readsDocsPage)).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("an HTML revalidation answers 304 before any loader work", {
        timeout: 120_000,
    }, async () => {
        const { Route } = await import("@/routes/$")
        const handlers = Route.options.server?.handlers
        if (!handlers || typeof handlers === "function")
            throw new Error("/$ declares no handler map")
        const get = handlers.GET
        if (typeof get !== "function")
            throw new Error("/$ declares no GET handler")
        const { siteId, hostname } = await seedSite()
        try {
            const call = async (etag: string) => {
                const next = vi.fn()
                const result = await get({
                    request: new Request("http://placeholder.local/guide", {
                        headers: { host: hostname, "if-none-match": etag },
                    }),
                    params: { _splat: "guide" },
                    pathname: "/$",
                    context: undefined,
                    next,
                })
                return {
                    status: result instanceof Response ? result.status : 0,
                    fellThrough: next.mock.calls.length > 0,
                }
            }
            // The loader stamps htmlPageEtag over the same context and
            // page, with no star count until the memo is warm.
            const ctx = await resolveDocsContext(
                requestFor(hostname, "/guide"),
                ["guide"],
            )
            const page = await resolvePage(ctx, ctx.source, ["guide"])
            if (!page) throw new Error("/guide did not resolve")
            const etag = htmlPageEtag(
                ctx,
                page,
                null,
                siteUrlFromRequest(requestFor(hostname, "/guide")),
            )
            expect((await call('W/"stale"')).fellThrough).toBe(true)
            const { result, statements } = await capture(() => call(etag))
            expect(result).toEqual({ status: 304, fellThrough: false })
            expect(statements.filter(readsDocsPage)).toEqual([])
            // The live pointer gate still runs.
            expect(statements.filter(isPointerJoin)).toHaveLength(1)
        } finally {
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("recency-bounded memos", () => {
    test("a continuously read version keeps its loader through 64 newer versions", {
        timeout: 120_000,
    }, async () => {
        const read = await seedSite()
        const others: Awaited<ReturnType<typeof seedSite>>[] = []
        try {
            for (let index = 0; index < 64; index++)
                others.push(await seedSite())
            const resolve = (hostname: string) =>
                resolveDocsContext(requestFor(hostname, "/guide"), ["guide"])
            await resolve(read.hostname)
            for (const other of others) {
                await resolve(other.hostname)
                await resolve(read.hostname)
            }
            const { statements } = await capture(() => resolve(read.hostname))
            // A FIFO memo would have evicted the first-built loader by now.
            expect(statements.filter(readsDocsPage)).toEqual([])
            expect(statements).toHaveLength(1)
        } finally {
            for (const { siteId } of [read, ...others]) await dropSite(siteId)
        }
    })

    test("a built search server leaves no corpus memoized for its version", async () => {
        const { siteId, versionId, hostname } = await seedSite()
        try {
            const ctx = await resolveDocsContext(
                requestFor(hostname, "/guide"),
                ["guide"],
            )
            const server = await searchServerFor(ctx, ["guide"])
            expect(await server.search("Setup")).not.toEqual([])
            const { statements } = await capture(() =>
                structuredDataFor(versionId),
            )
            expect(
                statements.filter((statement) =>
                    statement.includes("search_corpus_url"),
                ),
            ).toHaveLength(1)
        } finally {
            await dropSite(siteId)
        }
    })
})

const readsDocsAsset = (statement: string) =>
    statement.includes('from "docs_asset"')

describe.skipIf(!hasDocsDb)("OG cards, PDFs and MCP listings", () => {
    test("a version's second OG card reads no docs_asset row and fetches no blob", {
        timeout: 60_000,
    }, async () => {
        const backgroundHash = "b".repeat(64)
        const lightLogoHash = "c".repeat(64)
        const darkLogoHash = "d".repeat(64)
        const svg = (fill: string) =>
            `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="63"><rect width="120" height="63" fill="${fill}"/></svg>`
        const { siteId, versionId, hostname } = await seedSite({
            config: {
                name: "Query counts",
                logo: {
                    light: `/_assets/${lightLogoHash}`,
                    dark: `/_assets/${darkLogoHash}`,
                },
            },
            seo: {
                indexing: "navigable",
                metatags: {},
                ogDefaults: {
                    appearance: "dark",
                    background: `/_assets/${backgroundHash}`,
                },
                headMeta: [],
            },
        })
        const blobAsset = (hash: string, fill: string) => ({
            id: randomUUID(),
            siteId: siteId,
            versionId,
            path: `${fill.slice(1)}.svg`,
            contentHash: hash,
            mimeType: "image/svg+xml",
            blobUrl: `data:image/svg+xml;base64,${Buffer.from(svg(fill)).toString("base64")}`,
            byteSize: svg(fill).length,
        })
        await db.insert(schema.docsAsset).values([
            blobAsset(backgroundHash, "#111111"),
            blobAsset(darkLogoHash, "#eeeeee"),
            {
                id: randomUUID(),
                siteId: siteId,
                versionId,
                path: "light.svg",
                contentHash: lightLogoHash,
                mimeType: "image/svg+xml",
                bytes: Buffer.from(svg("#222222")),
                byteSize: svg("#222222").length,
            },
        ])
        const fetchSpy = vi.spyOn(globalThis, "fetch")
        const blobFetches = () =>
            fetchSpy.mock.calls.filter(([input]) =>
                String(input).startsWith("data:image/svg+xml"),
            )
        try {
            const card = (path: string) =>
                getDocsOgImage({
                    request: requestFor(hostname, `/og/docs/${path}`),
                    params: { _splat: path },
                })
            const first = await card("guide")
            expect(first.status).toBe(200)
            expect(first.headers.get("content-type")).toBe("image/png")
            // Background and dark logo are blob-backed; the light logo is
            // inline and never fetched. (satori's own wasm load also goes
            // through fetch, so count only the asset blob URLs.)
            expect(blobFetches()).toHaveLength(2)
            fetchSpy.mockClear()
            const { result, statements } = await capture(() =>
                card("changelog"),
            )
            expect(result.status).toBe(200)
            expect(statements.filter(readsDocsAsset)).toEqual([])
            expect(blobFetches()).toEqual([])
        } finally {
            fetchSpy.mockRestore()
            await dropSite(siteId)
        }
    })

    test("the PDF asset read filters embeddable image types in SQL", {
        timeout: 60_000,
    }, async () => {
        const { siteId, versionId, hostname } = await seedSite()
        try {
            await db
                .update(schema.docsPage)
                .set({
                    source: `# Guide\n\n![Chart](/_assets/${"e".repeat(64)})\n`,
                })
                .where(
                    and(
                        eq(schema.docsPage.versionId, versionId),
                        eq(schema.docsPage.path, "guide.mdx"),
                    ),
                )
            const { result, statements } = await capture(() =>
                getDocsPdf({
                    request: requestFor(hostname, "/guide.pdf"),
                    params: { _splat: "guide" },
                }),
            )
            expect(result.status).toBe(200)
            const assetReads = statements.filter(readsDocsAsset)
            expect(assetReads).toHaveLength(1)
            expect(assetReads[0]).toContain('"docs_asset"."mime_type" in')
        } finally {
            await dropSite(siteId)
        }
    })

    test("serves a page as a noindexed PDF attachment", {
        timeout: 60_000,
    }, async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const response = await getDocsPdf({
                request: requestFor(hostname, "/guide.pdf"),
                params: { _splat: "guide" },
            })
            expect(response.status).toBe(200)
            expect(response.headers.get("content-type")).toBe("application/pdf")
            expect(response.headers.get("content-disposition")).toBe(
                "attachment; filename=\"guide.pdf\"; filename*=UTF-8''guide.pdf",
            )
            expect(response.headers.get("cache-control")).toBe(
                "public, s-maxage=86400, stale-while-revalidate=604800",
            )
            expect(response.headers.get("x-robots-tag")).toBe("noindex")
            expect(response.headers.get("link")).toBe(
                '</guide>; rel="canonical"',
            )
            const bytes = new Uint8Array(await response.arrayBuffer())
            expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
        } finally {
            await dropSite(siteId)
        }
    })

    test("a PDF revalidation answers 304 with the same identity ETag", {
        timeout: 60_000,
    }, async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const first = await getDocsPdf({
                request: requestFor(hostname, "/guide.pdf"),
                params: { _splat: "guide" },
            })
            const etag = first.headers.get("etag")
            expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
            const request = requestFor(hostname, "/guide.pdf")
            request.headers.set("if-none-match", etag ?? "")
            const second = await getDocsPdf({
                request,
                params: { _splat: "guide" },
            })
            expect(second.status).toBe(304)
            expect(second.headers.get("etag")).toBe(etag)
            expect(await second.text()).toBe("")
        } finally {
            await dropSite(siteId)
        }
    })

    test("a PDF for an unknown page 404s with plain-text suggestions", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const response = await getDocsPdf({
                request: requestFor(hostname, "/guid.pdf"),
                params: { _splat: "guid" },
            })
            expect(response.status).toBe(404)
            expect(response.headers.get("content-type")).toContain("text/plain")
            expect(await response.text()).toContain("- Guide (/guide)")
        } finally {
            await dropSite(siteId)
        }
    })

    test("a PDF never serves another site's page", {
        timeout: 60_000,
    }, async () => {
        const owner = await seedSite()
        const other = await seedSite()
        try {
            // Only the owner publishes /guide.
            await db
                .delete(schema.docsPage)
                .where(
                    and(
                        eq(schema.docsPage.versionId, other.versionId),
                        eq(schema.docsPage.path, "guide.mdx"),
                    ),
                )
            const request = (hostname: string) =>
                getDocsPdf({
                    request: requestFor(hostname, "/guide.pdf"),
                    params: { _splat: "guide" },
                })
            expect((await request(owner.hostname)).status).toBe(200)
            expect((await request(other.hostname)).status).toBe(404)
        } finally {
            await dropSite(owner.siteId)
            await dropSite(other.siteId)
        }
    })

    test("list_docs pages its listing with a cursor", async () => {
        const { siteId, hostname } = await seedSite()
        const client = new Client({ name: "list-docs-test", version: "1.0.0" })
        try {
            const server = await buildMcpServer(
                requestFor(hostname, "/api/mcp"),
            )
            const [clientTransport, serverTransport] =
                InMemoryTransport.createLinkedPair()
            await Promise.all([
                server.connect(serverTransport),
                client.connect(clientTransport),
            ])
            const result = z
                .object({
                    content: z.tuple([
                        z.object({ type: z.literal("text"), text: z.string() }),
                    ]),
                })
                .parse(
                    await client.callTool({
                        name: "list_docs",
                        arguments: { limit: 2 },
                    }),
                )
            const listing = z
                .object({
                    pages: z.array(z.object({ url: z.string() })),
                    total: z.number(),
                    nextCursor: z.number().nullable(),
                })
                .parse(JSON.parse(result.content[0].text))
            expect(listing.pages).toHaveLength(2)
            expect(listing.total).toBeGreaterThan(2)
            expect(listing.nextCursor).toBe(2)
        } finally {
            await client.close()
            await dropSite(siteId)
        }
    })
})

const mcpTextResult = z.object({
    content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
})

describe.skipIf(!hasDocsDb)("MCP tool locale scope", () => {
    test.each(["legacy", "2026-07-28"])(
        "HTTP endpoint serves %s clients",
        async (revision) => {
            const { siteId, hostname } = await seedSite()
            const client = new Client(
                { name: "http-docs-test", version: "1.0.0" },
                {
                    versionNegotiation: {
                        mode:
                            revision === "legacy"
                                ? "legacy"
                                : { pin: revision },
                    },
                },
            )
            const transport = new StreamableHTTPClientTransport(
                new URL(`http://${hostname}/api/mcp`),
                {
                    requestInit: { headers: { host: hostname } },
                    fetch: (input, init) => handleMcp(new Request(input, init)),
                },
            )
            try {
                await client.connect(transport)
                expect(
                    (await client.listTools()).tools
                        .map((tool) => tool.name)
                        .sort(),
                ).toEqual([...MCP_TOOL_NAMES].sort())
                const result = mcpTextResult.parse(
                    await client.callTool({
                        name: "list_docs",
                        arguments: { url: "/fr/guide" },
                    }),
                )
                const listing = z
                    .object({ pages: z.array(z.object({ url: z.string() })) })
                    .parse(JSON.parse(result.content[0].text))
                expect(listing.pages.map((page) => page.url).sort()).toEqual([
                    "/fr",
                    "/fr/guide",
                ])
            } finally {
                await client.close()
                await dropSite(siteId)
            }
        },
    )

    test.each(["GET", "DELETE"])(
        "stateless HTTP rejects %s session operations",
        async (method) => {
            const { siteId, hostname } = await seedSite()
            try {
                // An MCP client opening a session stream asks for SSE; only a
                // plain GET (no event-stream) gets the info document instead.
                const response = await handleMcp(
                    new Request(`http://${hostname}/api/mcp`, {
                        method,
                        headers: {
                            host: hostname,
                            accept: "text/event-stream",
                        },
                    }),
                )
                expect(response.status).toBe(405)
            } finally {
                await dropSite(siteId)
            }
        },
    )

    test("a plain GET describes the server and how to connect", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            const response = await handleMcp(
                new Request(`http://${hostname}/api/mcp`, {
                    headers: { host: hostname, accept: "application/json" },
                }),
            )
            expect(response.status).toBe(200)
            const body = z
                .object({
                    url: z.string(),
                    instructions: z.string(),
                    tools: z.array(z.string()),
                    connect: z.object({ claudeCode: z.string() }),
                })
                .parse(await response.json())
            expect(body.url).toBe(`http://${hostname}/api/mcp`)
            expect(body.tools).toContain("query_docs_filesystem")
            expect(body.connect.claudeCode).toContain(body.url)
        } finally {
            await dropSite(siteId)
        }
    })

    test.each([
        { url: "/fr/guide" },
        { url: "/fr/guide", prefix: "/fr" },
        { prefix: "/fr" },
    ])("list_docs selects French pages with %j", async (args) => {
        const { siteId, hostname } = await seedSite()
        const client = new Client({ name: "locale-test", version: "1.0.0" })
        const server = await buildMcpServer(requestFor(hostname, "/api/mcp"))
        try {
            const [clientTransport, serverTransport] =
                InMemoryTransport.createLinkedPair()
            await Promise.all([
                server.connect(serverTransport),
                client.connect(clientTransport),
            ])
            const { result, statements } = await capture(() =>
                client.callTool({ name: "list_docs", arguments: args }),
            )
            const listing = z
                .object({ pages: z.array(z.object({ url: z.string() })) })
                .parse(JSON.parse(mcpTextResult.parse(result).content[0].text))
            expect(listing.pages.map((page) => page.url).sort()).toEqual([
                "/fr",
                "/fr/guide",
            ])
            expect(statements.filter(readsDocsPage)).toEqual([])
            expect(statements.filter(isPointerJoin)).toEqual([])
        } finally {
            await Promise.all([client.close(), server.close()])
            await dropSite(siteId)
        }
    })

    test.each([
        {
            name: "get_navigation",
            args: { url: "/fr/guide" },
            expected: "Guide FR",
        },
        {
            name: "search_docs",
            args: { query: "Accueil", url: "/fr" },
            expected: "/fr",
        },
        {
            name: "read_page",
            args: { url: "/fr/guide" },
            expected: "# Guide FR",
        },
    ])("$name uses the URL locale", async ({ name, args, expected }) => {
        const { siteId, hostname } = await seedSite()
        const client = new Client({ name: "locale-test", version: "1.0.0" })
        const server = await buildMcpServer(requestFor(hostname, "/api/mcp"))
        try {
            const [clientTransport, serverTransport] =
                InMemoryTransport.createLinkedPair()
            await Promise.all([
                server.connect(serverTransport),
                client.connect(clientTransport),
            ])
            const result = mcpTextResult.parse(
                await client.callTool({ name, arguments: args }),
            )
            expect(result.content[0].text).toContain(expected)
        } finally {
            await Promise.all([client.close(), server.close()])
            await dropSite(siteId)
        }
    })
})

describe.skipIf(!hasDocsDb)("docs chat gate", () => {
    /** Every limiter row the chat route keyed on this site. */
    const rateLimitRows = (siteId: string) =>
        db
            .select({ key: schema.publicRateLimit.key })
            .from(schema.publicRateLimit)
            .where(like(schema.publicRateLimit.key, `docs_chat:${siteId}%`))

    // The Assistant needs an AI Gateway credential; the model call itself is
    // mocked above, so a placeholder key opens the gate.
    beforeEach(() => {
        vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    const question = JSON.stringify({
        messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        ],
        path: "/guide",
    })

    async function ask(
        hostname: string,
        input: {
            ip?: string
            body?: string
            headers?: Record<string, string>
        } = {},
    ): Promise<Response> {
        const { Route } = await import("@/routes/api.chat")
        const handlers = Route.options.server?.handlers
        if (!handlers || typeof handlers === "function")
            throw new Error("/api/chat declares no handler map")
        const post = handlers.POST
        if (typeof post !== "function")
            throw new Error("/api/chat declares no POST handler")
        const result = await post({
            request: new Request("http://placeholder.local/api/chat", {
                method: "POST",
                headers: {
                    host: hostname,
                    "content-type": "application/json",
                    "x-forwarded-for": input.ip ?? "203.0.113.1",
                    ...input.headers,
                },
                body: input.body ?? question,
            }),
            params: {},
            pathname: "/api/chat",
            context: undefined,
            next: vi.fn(),
        })
        if (!(result instanceof Response)) throw new Error("no Response")
        return result
    }

    test.each([
        ["keeps the Assistant by default", { name: "Chat" }, 200, 1],
        [
            "turned the Assistant off",
            { name: "Chat", "x-margin": { search: { mode: "static" } } },
            404,
            0,
        ],
        [
            "turned it off beside a field the chrome's layout parse rejects",
            {
                name: "Chat",
                navbar: { socials: { github: 123 } },
                "x-margin": { search: { mode: "off" } },
            },
            404,
            0,
        ],
    ])("a site that %s", async (_label, config, status, modelCalls) => {
        streamText.mockClear()
        const { siteId, hostname } = await seedSite({ config })
        try {
            expect((await ask(hostname)).status).toBe(status)
            expect(streamText).toHaveBeenCalledTimes(modelCalls)
        } finally {
            await dropSite(siteId)
        }
    })

    test("reports an unconfigured assistant without spending a model call or rate limit", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            streamText.mockClear()
            expect((await ask(hostname)).status).toBe(200)
            expect(streamText).toHaveBeenCalledTimes(1)

            vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
            vi.stubEnv("VERCEL_OIDC_TOKEN", undefined)
            vi.stubEnv("VERCEL", undefined)
            streamText.mockClear()
            const before = await rateLimitRows(siteId)

            const unavailable = await ask(hostname)
            expect(unavailable.status).toBe(503)
            expect(unavailable.headers.get("content-type")).toContain(
                "application/json",
            )
            expect(await unavailable.json()).toEqual({
                error: "assistant_not_configured",
                message:
                    "The assistant is not configured. Use documentation search instead.",
            })
            expect(streamText).not.toHaveBeenCalled()
            expect(await rateLimitRows(siteId)).toEqual(before)
        } finally {
            await dropSite(siteId)
        }
    })

    test("keys a visitor on Vercel's address, never a caller's cf-connecting-ip", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            for (let i = 0; i < 20; i += 1)
                expect(
                    (
                        await ask(hostname, {
                            headers: {
                                "x-vercel-forwarded-for": "198.51.100.40",
                                "cf-connecting-ip": `10.0.0.${i}`,
                            },
                        })
                    ).status,
                ).toBe(200)

            const response = await ask(hostname, {
                headers: {
                    "x-vercel-forwarded-for": "198.51.100.40",
                    "cf-connecting-ip": "10.0.0.99",
                },
            })

            expect(response.status).toBe(429)
        } finally {
            await dropSite(siteId)
        }
    })

    // Behind an organization's proxy every visitor arrives from the proxy's
    // address: a per-visitor limit there would stop the whole site at once.
    test("holds a shared client address to the site's limits only", async () => {
        const { siteId, hostname } = await seedSite()
        const askThroughProxy = () =>
            siteScope().run(
                { basePath: "", publicOrigin: null, sharedClientAddress: true },
                () => ask(hostname, { ip: "198.51.100.30" }),
            )
        try {
            for (let i = 0; i < 20; i += 1)
                expect((await askThroughProxy()).status).toBe(200)

            expect((await askThroughProxy()).status).toBe(200)
            expect(
                await db
                    .select({ bucket: schema.publicRateLimit.bucket })
                    .from(schema.publicRateLimit)
                    .where(
                        like(
                            schema.publicRateLimit.key,
                            `docs_chat:${siteId}%`,
                        ),
                    ),
            ).toEqual([{ bucket: "docs_chat_site_day" }])
        } finally {
            await dropSite(siteId)
        }
    })

    test("stops one visitor after its ten-minute allowance, not the next", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            for (let i = 0; i < 20; i += 1)
                expect(
                    (await ask(hostname, { ip: "198.51.100.20" })).status,
                ).toBe(200)
            streamText.mockClear()

            const limited = await ask(hostname, { ip: "198.51.100.20" })

            expect(limited.status).toBe(429)
            const retryAfter = Number(limited.headers.get("retry-after"))
            expect(retryAfter).toBeGreaterThan(0)
            // The panel renders `message`, which names the wait in whole
            // minutes, rounded up.
            const minutes = Math.max(1, Math.ceil(retryAfter / 60))
            expect(limited.headers.get("content-type")).toContain(
                "application/json",
            )
            expect(await limited.json()).toEqual({
                error: "rate_limited",
                message: `You've asked a lot of questions in a short time. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
                retryAfterSeconds: retryAfter,
            })
            expect(streamText).not.toHaveBeenCalled()
            expect((await ask(hostname, { ip: "198.51.100.21" })).status).toBe(
                200,
            )
        } finally {
            await dropSite(siteId)
        }
    })

    test("holds the site's daily ceiling however the address rotates", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            await db.insert(schema.publicRateLimit).values({
                id: randomUUID(),
                bucket: "docs_chat_site_day",
                key: `docs_chat:${siteId}`,
                count: 3000,
                resetAt: new Date(Date.now() + 86_400_000),
            })
            streamText.mockClear()

            const response = await ask(hostname, { ip: "192.0.2.200" })

            expect(response.status).toBe(429)
            expect(streamText).not.toHaveBeenCalled()
        } finally {
            await dropSite(siteId)
        }
    })

    test("refuses an oversized conversation before any model call", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            streamText.mockClear()

            const response = await ask(hostname, {
                body: JSON.stringify({
                    messages: [
                        {
                            id: "m1",
                            role: "user",
                            parts: [
                                { type: "text", text: "x".repeat(600_000) },
                            ],
                        },
                    ],
                }),
            })

            expect(response.status).toBe(413)
            expect(await response.json()).toEqual({
                error: "conversation_too_long",
                message:
                    "This conversation is too long. Start a new chat to keep asking.",
            })
            expect(streamText).not.toHaveBeenCalled()
            expect(await rateLimitRows(siteId)).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("refuses a declared oversized body from its content-length alone", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            streamText.mockClear()

            // A tiny body behind a large declared length: only the header
            // check can refuse it.
            const response = await ask(hostname, {
                body: "{}",
                headers: { "content-length": String(10 * 1024 * 1024) },
            })

            expect(response.status).toBe(413)
            expect(await response.json()).toEqual({
                error: "conversation_too_long",
                message:
                    "This conversation is too long. Start a new chat to keep asking.",
            })
            expect(streamText).not.toHaveBeenCalled()
            expect(await rateLimitRows(siteId)).toEqual([])
        } finally {
            await dropSite(siteId)
        }
    })

    test("sends the model only the 24 most recent turns", async () => {
        const { siteId, hostname } = await seedSite()
        try {
            streamText.mockClear()
            modelInputs.length = 0

            const response = await ask(hostname, {
                body: JSON.stringify({
                    messages: Array.from({ length: 60 }, (_, index) => ({
                        id: `m${index}`,
                        role: index % 2 === 0 ? "user" : "assistant",
                        parts: [{ type: "text", text: `turn ${index}` }],
                    })),
                }),
            })

            expect(response.status).toBe(200)
            expect(streamText).toHaveBeenCalledTimes(1)
            expect(
                modelInputs.map((messages) =>
                    z
                        .array(z.object({ id: z.string() }))
                        .parse(messages)
                        .map((message) => message.id),
                ),
            ).toEqual([
                Array.from({ length: 24 }, (_, index) => `m${index + 36}`),
            ])
        } finally {
            await dropSite(siteId)
        }
    })
})
