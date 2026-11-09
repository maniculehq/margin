/** A site served under a base path (SITE_ORIGIN with a path, the way a
 * proxied acme.com/docs reaches the built server): pages, built assets and
 * redirects all sit under it, and a path outside it redirects into it. The
 * second suite puts the site behind a proxy that forwards only /help, on its
 * own origin, and checks every surface names that origin and path. Run by
 * `bun run test:e2e`, which builds the node-server bundle and ingests the
 * `acme` fixture. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer, request as forward, type Server } from "node:http"
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { env } from "@/env"
import { buildSearchCorpus } from "@/ingest/assets"

const SERVER_ENTRY = ".output/server/index.mjs"

async function freePort(): Promise<number> {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const address = probe.address()
    if (!address || typeof address === "string")
        throw new Error("port probe failed")
    const port = address.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
}

describe.skipIf(
    !existsSync(SERVER_ENTRY) ||
        !(process.env.DATABASE_URL || process.env.POSTGRES_URL),
)("a site under a base path", () => {
    let child: ChildProcess
    let origin = ""

    beforeAll(async () => {
        const probe = createServer()
        await new Promise<void>((resolve) =>
            probe.listen(0, "127.0.0.1", resolve),
        )
        const address = probe.address()
        if (!address || typeof address === "string")
            throw new Error("port probe failed")
        const port = address.port
        await new Promise<void>((resolve) => probe.close(() => resolve()))

        origin = `http://127.0.0.1:${port}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                PORT: String(port),
                SITE_SLUG: "acme",
                SITE_ORIGIN: `${origin}/docs`,
                SENTRY_DSN: "",
            },
            stdio: "ignore",
        })
        const deadline = Date.now() + 30_000
        for (;;) {
            try {
                await fetch(`${origin}/docs/robots.txt`)
                break
            } catch {
                // still booting
            }
            if (Date.now() > deadline)
                throw new Error("built server did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
    }, 60_000)

    afterAll(() => {
        child?.kill("SIGTERM")
    })

    it("serves a page with its scripts, styles and links under the base path", async () => {
        const res = await fetch(`${origin}/docs/quickstart`)
        const html = await res.text()
        expect(res.status).toBe(200)
        expect(html).toContain('data-base-path="/docs"')
        expect(html).toContain('href="/docs/webhooks"')
        const assets = [
            ...html.matchAll(
                /<(?:script[^>]*\ssrc|link[^>]*rel="(?:stylesheet|modulepreload)"[^>]*\shref)="([^"]+)"/g,
            ),
        ].map((match) => match[1] ?? "")
        expect(assets.length).toBeGreaterThan(2)
        expect(
            assets.filter((url) => !url.startsWith("/docs/_margin/assets/")),
        ).toEqual([])
        // The node-server preset serves them from the static output.
        const statuses = await Promise.all(
            assets.map(async (url) => {
                const asset = await fetch(`${origin}${url}`)
                await asset.body?.cancel()
                return `${asset.status} ${url}`
            }),
        )
        expect(statuses).toEqual(assets.map((url) => `200 ${url}`))
    })

    it("redirects a path outside the base path to the same path under it", async () => {
        const res = await fetch(`${origin}/quickstart?tab=1`, {
            redirect: "manual",
        })
        expect(res.status).toBe(308)
        expect(res.headers.get("location")).toBe("/docs/quickstart?tab=1")
    })

    it("redirects a doubled slash after the base path to the page it names", async () => {
        const res = await fetch(`${origin}/docs//quickstart?tab=1`, {
            redirect: "manual",
        })
        expect(res.status).toBe(308)
        expect(res.headers.get("location")).toBe("/docs/quickstart?tab=1")
    })

    it.each([
        // A handler's redirect names an internal path.
        ["/docs/quickstart/", 308, "/docs/quickstart"],
        // The router's own redirect (it respells ?search=) already carries it.
        [
            "/docs/quickstart?search=404",
            307,
            "/docs/quickstart?search=%22404%22",
        ],
    ])("prefixes the redirect from %s once", async (path, status, location) => {
        const res = await fetch(`${origin}${path}`, { redirect: "manual" })
        expect(res.status).toBe(status)
        expect(res.headers.get("location")).toBe(location)
    })

    it("answers a missing built file with a 404, not a redirect", async () => {
        const res = await fetch(`${origin}/_margin/assets/missing.js`, {
            redirect: "manual",
        })
        await res.body?.cancel()
        expect(res.status).toBe(404)
    })
})

const PROXIED_SITE_ID = "00000000-0000-4000-8000-000000000141"
const PROXIED_SLUG = "base-path-proxied"

/** Every attribute URL in a document that is root-relative but outside
 * the base path: each one would leave the proxied path. The base is not
 * "/docs", which the framework already accepts as a page-path prefix. */
function rootLinksOutside(html: string): string[] {
    return [...html.matchAll(/\s(?:href|src|srcset|action)="(\/[^"]*)"/g)]
        .flatMap((match) => (match[1] ?? "").split(/,\s*/))
        .map((candidate) => candidate.split(" ")[0] ?? "")
        .filter(
            (url) =>
                url.startsWith("/") &&
                !url.startsWith("//") &&
                url !== "/help" &&
                !url.startsWith("/help/") &&
                !url.startsWith("/help?") &&
                !url.startsWith("/help#"),
        )
}

describe.skipIf(!existsSync(SERVER_ENTRY) || !env.DATABASE_URL)(
    "a site behind a proxy that forwards only its base path",
    () => {
        let child: ChildProcess
        let proxy: Server
        /** The public origin: the proxy's. */
        let publicOrigin = ""
        /** The site's URL: public origin plus base path. */
        let site = ""
        let faviconHash = ""
        /** Paths the proxy refused because they sit outside /help. */
        const outside: string[] = []

        beforeAll(async () => {
            const { compileDocs } = await import("@/ingest/compile")
            const { persistDocsVersion } = await import("@/ingest/persist")
            const { db, schema } = await import("@/db")
            await db
                .insert(schema.docsSite)
                .values({
                    id: PROXIED_SITE_ID,
                    slug: PROXIED_SLUG,
                    name: "Proxied Docs",
                    analyticsMode: "off",
                    status: "active",
                })
                .onConflictDoUpdate({
                    target: schema.docsSite.slug,
                    set: { status: "active" },
                })
            const compiled = await compileDocs([
                {
                    path: "docs.json",
                    kind: "text",
                    content: JSON.stringify({
                        name: "Proxied Docs",
                        favicon: "/pixel.png",
                        feedback: { thumbsRating: true },
                        // An authored redirect whose target starts with the
                        // base path: the internal page /help/new.
                        redirects: [
                            { source: "/old", destination: "/help/new" },
                        ],
                        navigation: {
                            global: {
                                anchors: [
                                    {
                                        anchor: "Community",
                                        href: "https://community.example",
                                        icon: "/pixel.png",
                                    },
                                ],
                            },
                            languages: [
                                {
                                    language: "en",
                                    default: true,
                                    pages: [
                                        "index",
                                        "guide",
                                        "expr",
                                        "help/new",
                                    ],
                                },
                                {
                                    language: "es",
                                    pages: ["es/index", "es/guide"],
                                },
                            ],
                        },
                    }),
                },
                {
                    path: "index.mdx",
                    kind: "text",
                    content: [
                        "---\ntitle: Proxied Home\n---\n",
                        "Read [the guide](/guide) first.\n",
                        "![pixel](/pixel.png)\n",
                        "```md\n[in code](/guide)\n```\n",
                    ].join("\n"),
                },
                {
                    path: "guide.mdx",
                    kind: "text",
                    // The icon is an image: its sidebar row renders an <img>.
                    content:
                        "---\ntitle: Proxied Guide\nicon: /pixel.png\n---\n\nGuide body for the proxied site.\n",
                },
                {
                    path: "help/new.mdx",
                    kind: "text",
                    content:
                        "---\ntitle: Moved Guide\n---\n\nThe moved guide.\n",
                },
                {
                    path: "expr.mdx",
                    kind: "text",
                    // The expression puts the page on the isolate path: its
                    // server snapshot renders these links without a router.
                    content:
                        '---\ntitle: Expression Page\n---\n\n{"isolate " + "body"}\n\n[Back to the guide](/guide)\n\n<Card title="Guide card" href="/guide" />\n',
                },
                {
                    path: "es/index.mdx",
                    kind: "text",
                    content: "---\ntitle: Inicio\n---\n\nCuerpo.\n",
                },
                {
                    path: "es/guide.mdx",
                    kind: "text",
                    content: "---\ntitle: Guía\n---\n\nGuía del sitio.\n",
                },
                {
                    path: "styles.css",
                    kind: "text",
                    content:
                        ".proxied-marker{background-image:url(/pixel.png)}\n",
                },
                {
                    path: "pixel.png",
                    kind: "binary",
                    bytes: new Uint8Array(
                        readFileSync("tests/fixtures/acme/images/pixel.png"),
                    ),
                },
            ])
            if (!compiled.ok) throw new Error("proxied fixture failed")
            const favicon = compiled.config?.favicon
            faviconHash =
                typeof favicon === "string"
                    ? favicon.replace("/_assets/", "")
                    : ""
            await persistDocsVersion({
                siteId: PROXIED_SITE_ID,
                commitSha: "0000000000000000000000000000000000000141",
                kind: "production",
                replaceExisting: true,
                seq: 9_999_941,
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
                searchCorpusUrl: `data:application/gzip;base64,${buildSearchCorpus(
                    compiled.pages,
                ).gzipped.toString("base64")}`,
            })

            const [serverPort, proxyPort] = await Promise.all([
                freePort(),
                freePort(),
            ])
            publicOrigin = `http://127.0.0.1:${proxyPort}`
            site = `${publicOrigin}/help`
            child = spawn("node", [SERVER_ENTRY], {
                env: {
                    ...process.env,
                    SENTRY_DSN: "",
                    PORT: String(serverPort),
                    SITE_SLUG: PROXIED_SLUG,
                    SITE_ORIGIN: site,
                    NODE_ENV: "production",
                    // The assistant is on; its upstream call fails without a
                    // real key, which the chat check allows for.
                    AI_GATEWAY_API_KEY: "test-gateway-key",
                },
                stdio: "ignore",
            })
            // The owner's proxy: /help and below go to the platform host
            // unchanged (its own Host header), anything else stays here.
            proxy = createServer((incoming, outgoing) => {
                const path = incoming.url ?? "/"
                if (!/^\/help(?:[/?#]|$)/.test(path)) {
                    outside.push(path)
                    outgoing.writeHead(404).end()
                    return
                }
                const upstream = forward(
                    {
                        host: "127.0.0.1",
                        port: serverPort,
                        path,
                        method: incoming.method,
                        headers: {
                            ...incoming.headers,
                            host: `127.0.0.1:${serverPort}`,
                            "x-forwarded-proto": "http",
                        },
                    },
                    (response) => {
                        outgoing.writeHead(
                            response.statusCode ?? 502,
                            response.headers,
                        )
                        response.pipe(outgoing)
                    },
                )
                upstream.on("error", () => outgoing.writeHead(502).end())
                incoming.pipe(upstream)
            })
            await new Promise<void>((resolve) =>
                proxy.listen(proxyPort, "127.0.0.1", resolve),
            )
            const deadline = Date.now() + 30_000
            for (;;) {
                try {
                    if ((await fetch(`${site}/llms.txt`)).status === 200) break
                } catch {
                    // still booting
                }
                if (Date.now() > deadline)
                    throw new Error("built server did not become ready")
                await new Promise((r) => setTimeout(r, 250))
            }
        }, 120_000)

        afterAll(async () => {
            child?.kill("SIGTERM")
            await new Promise((resolve) => proxy?.close(resolve))
        })

        it("names the public origin and base path in a page's head", async () => {
            const html = await (await fetch(`${site}/guide`)).text()
            expect(html).toContain(`<link rel="canonical" href="${site}/guide"`)
            expect(html).toContain(
                `<link rel="alternate" hrefLang="es" href="${site}/es/guide"`,
            )
            expect(html).toContain(
                `<link rel="sitemap" type="application/xml" href="${site}/sitemap.xml"`,
            )
            expect(html).toContain('href="/help/manifest.webmanifest"')
            expect(html).toContain(`href="/help/_assets/${faviconHash}"`)
            expect(html).toMatch(/href="\/help\/_theme\/[0-9a-f]+\.css"/)
            // Image icons: the page's sidebar row (frontmatter icon) and the
            // anchor (navigation icon) render the stored asset's URL.
            expect(html).toMatch(
                new RegExp(
                    `<img src="/help/_assets/${faviconHash}"[^>]*docs-tree-icon`,
                ),
            )
            expect(
                html.match(
                    new RegExp(`<img src="/help/_assets/${faviconHash}"`, "g"),
                )?.length,
            ).toBeGreaterThanOrEqual(2)
            expect(rootLinksOutside(html)).toEqual([])
        })

        it.each([
            // The internal page /help/new sits at /help/help/new: a target
            // that starts with the base path is not thereby public.
            ["the slashed internal path /help/", "/help/", "/help/help"],
            [
                "an authored redirect to /help/new",
                "/old?tab=1",
                "/help/help/new?tab=1",
            ],
            ["that redirect's markdown twin", "/old.md", "/help/help/new.md"],
        ])(
            "prefixes the redirect from %s once",
            async (_label, path, location) => {
                const response = await fetch(`${site}${path}`, {
                    redirect: "manual",
                })
                expect(response.status).toBe(308)
                expect(response.headers.get("location")).toBe(location)
            },
        )

        it("serves the page an authored redirect lands on", async () => {
            const response = await fetch(`${site}/old`)
            expect(response.status).toBe(200)
            expect(response.url).toBe(`${site}/help/new`)
            expect(await response.text()).toContain("Moved Guide")
        })

        it.each([
            {
                link: "the markdown 404's closest pages",
                path: "/guid.md",
                expected: "](/help/guide.md)",
            },
            {
                link: "the markdown 404's index",
                path: "/guid.md",
                expected: "[/help/llms.txt](/help/llms.txt)",
            },
            {
                link: "the PDF 404's closest pages",
                path: "/guid.pdf",
                expected: "(/help/guide)",
            },
        ])("links $link under the base path", async ({ path, expected }) => {
            const response = await fetch(`${site}${path}`)
            expect(response.status).toBe(404)
            expect(await response.text()).toContain(expected)
        })

        it("spells the site root as the bare base path", async () => {
            const html = await (await fetch(site)).text()
            expect(html).toContain(`<link rel="canonical" href="${site}"`)
            expect(rootLinksOutside(html)).toEqual([])
        })

        it("prefixes the links an isolate snapshot renders", async () => {
            const html = await (await fetch(`${site}/expr`)).text()
            // The snapshot is in the document: its links are too.
            expect(html).toContain("isolate body")
            expect(html).toMatch(
                /<a[^>]*href="\/help\/guide"[^>]*>Back to the guide/,
            )
            expect(rootLinksOutside(html)).toEqual([])
        })

        it("lists sitemap URLs and robots rules under the base path", async () => {
            const sitemap = await (await fetch(`${site}/sitemap.xml`)).text()
            const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
                (match) => match[1],
            )
            expect(locs).toContain(site)
            expect(locs).toContain(`${site}/guide`)
            expect(locs.filter((loc) => !loc?.startsWith(site))).toEqual([])

            const robots = await (await fetch(`${site}/robots.txt`)).text()
            expect(robots).toContain("Allow: /help\n")
            expect(robots).not.toContain("Allow: /\n")
            expect(robots).toContain(`Sitemap: ${site}/sitemap.xml`)
        })

        it("links llms.txt and a page's markdown under the base path", async () => {
            const llms = await (await fetch(`${site}/llms.txt`)).text()
            expect(llms).toContain(`(${site}/guide.md)`)
            const markdown = await (await fetch(`${site}/index.md`)).text()
            expect(markdown).toContain("[the guide](/help/guide)")
            expect(markdown).toContain("![pixel](/help/_assets/")
            expect(markdown).toContain("[in code](/guide)")
        })

        it.each([
            {
                file: "a page's markdown",
                method: "GET",
                path: "/guide.md",
                link: '</help/guide>; rel="canonical"',
            },
            {
                file: "a page's PDF",
                method: "GET",
                path: "/guide.pdf",
                link: '</help/guide>; rel="canonical"',
            },
            {
                file: "the API catalog",
                method: "HEAD",
                path: "/.well-known/api-catalog",
                link: '</help/.well-known/api-catalog>; rel="api-catalog"',
            },
        ])(
            "links $file under the base path",
            async ({ method, path, link }) => {
                const response = await fetch(`${site}${path}`, { method })
                await response.body?.cancel()
                expect(response.status).toBe(200)
                // The markdown route adds the site-wide links after its own.
                expect(response.headers.get("link")).toContain(link)
            },
        )

        it("serves the manifest, favicon and theme CSS under the base path", async () => {
            const manifest = z
                .object({
                    start_url: z.string(),
                    icons: z.array(z.object({ src: z.string() })),
                })
                .parse(
                    await (await fetch(`${site}/manifest.webmanifest`)).json(),
                )
            expect(manifest.start_url).toBe("/help")
            expect(manifest.icons.map((icon) => icon.src)).toEqual([
                `/help/_assets/${faviconHash}`,
            ])

            const favicon = await fetch(`${site}/favicon.ico`, {
                redirect: "manual",
            })
            expect(favicon.headers.get("location")).toBe(
                `/help/_assets/${faviconHash}`,
            )

            const html = await (await fetch(`${site}/guide`)).text()
            const themeHref = /href="(\/help\/_theme\/[0-9a-f]+\.css)"/.exec(
                html,
            )?.[1]
            const css = await (
                await fetch(`${publicOrigin}${themeHref}`)
            ).text()
            expect(css).toContain(`url("/help/_assets/${faviconHash}")`)
        })

        it("scopes search by a public path", async () => {
            const response = await fetch(
                `${site}/api/search?query=${encodeURIComponent("Guía del sitio")}&path=/help/es`,
            )
            expect(response.status).toBe(200)
            const results = z
                .array(z.object({ url: z.string() }))
                .parse(await response.json())
            // The site's own browser code reads these: router paths.
            expect(results.map((result) => result.url)).toContain("/es/guide")
        })

        describe("MCP under the base path", () => {
            let client: Client
            const text = z.object({
                content: z.tuple([z.object({ text: z.string() })]),
            })

            beforeAll(async () => {
                const discovery = z
                    .object({ url: z.string() })
                    .parse(
                        await (
                            await fetch(`${site}/.well-known/mcp.json`)
                        ).json(),
                    )
                expect(discovery.url).toBe(`${site}/api/mcp`)
                client = new Client({
                    name: "base-path-test",
                    version: "1.0.0",
                })
                await client.connect(
                    new StreamableHTTPClientTransport(new URL(discovery.url)),
                )
            })

            afterAll(async () => {
                await client?.close()
            })

            it("reads a page by its public URL", async () => {
                const read = text.parse(
                    await client.callTool({
                        name: "read_page",
                        arguments: { url: `${site}/guide` },
                    }),
                )
                // The page itself, headed with its public path.
                expect(read.content[0].text).toContain(
                    "# Proxied Guide (/help/guide)",
                )
            })

            it("follows a stored redirect to its internal target", async () => {
                // /old → /help/new is the page at /help/help/new, not /new.
                const moved = text.parse(
                    await client.callTool({
                        name: "read_page",
                        arguments: { url: `${site}/old` },
                    }),
                )
                expect(moved.content[0].text).toContain(
                    "# Moved Guide (/help/help/new)",
                )
            })

            it("suggests a missed page's neighbours at their public paths", async () => {
                const missed = z
                    .object({ isError: z.literal(true) })
                    .extend(text.shape)
                    .parse(
                        await client.callTool({
                            name: "read_page",
                            arguments: { url: `${site}/guid` },
                        }),
                    )
                const candidates = z
                    .object({
                        candidates: z.array(
                            z.object({
                                url: z.string(),
                                markdownUrl: z.string(),
                            }),
                        ),
                    })
                    .parse(JSON.parse(missed.content[0].text)).candidates
                expect(candidates.map((c) => c.url)).toContain("/help/guide")
                expect(candidates.map((c) => c.markdownUrl)).toContain(
                    "/help/guide.md",
                )
            })

            it("lists pages under a public prefix", async () => {
                const listed = z
                    .object({
                        structuredContent: z.object({
                            pages: z.array(z.object({ url: z.string() })),
                        }),
                    })
                    .parse(
                        await client.callTool({
                            name: "list_docs",
                            arguments: { prefix: "/help/es" },
                        }),
                    )
                expect(
                    listed.structuredContent.pages.map((page) => page.url),
                ).toEqual(["/help/es", "/help/es/guide"])
            })

            it("stores a page's file at the path search returns", async () => {
                const searched = z
                    .object({
                        structuredContent: z.object({
                            results: z.array(z.object({ url: z.string() })),
                        }),
                    })
                    .parse(
                        await client.callTool({
                            name: "search_docs",
                            arguments: { query: "Guide body" },
                        }),
                    )
                const hit = searched.structuredContent.results[0]?.url
                expect(hit).toBe("/help/guide")
                const file = z
                    .object({
                        structuredContent: z.object({
                            stdout: z.string(),
                            exitCode: z.number(),
                        }),
                    })
                    .parse(
                        await client.callTool({
                            name: "query_docs_filesystem",
                            arguments: { command: `cat ${hit}.md` },
                        }),
                    )
                expect(file.structuredContent.exitCode).toBe(0)
                expect(file.structuredContent.stdout).toContain(
                    "Guide body for the proxied site.",
                )
            })

            it("links a page's file to the other files under the base path", async () => {
                const file = z
                    .object({
                        structuredContent: z.object({
                            stdout: z.string(),
                            exitCode: z.number(),
                        }),
                    })
                    .parse(
                        await client.callTool({
                            name: "query_docs_filesystem",
                            arguments: { command: "cat /help/index.md" },
                        }),
                    )
                expect(file.structuredContent.exitCode).toBe(0)
                expect(file.structuredContent.stdout).toContain(
                    "[the guide](/help/guide)",
                )
                expect(file.structuredContent.stdout).toContain(
                    "[in code](/guide)",
                )
            })
        })

        it("lets a server-function call from the public origin past the CSRF check", async () => {
            // No Sec-Fetch-Site (an older browser): the Origin decides, and
            // the request reaches the server on another host than the
            // proxy's.
            const call = (origin: string) =>
                fetch(`${site}/_serverFn/unknown-function`, {
                    method: "POST",
                    headers: {
                        Origin: origin,
                        "Content-Type": "application/json",
                    },
                    body: "{}",
                })
            const foreign = await call("http://elsewhere.test")
            expect(foreign.status).toBe(403)
            // Past the check, the unknown function id is what fails.
            const own = await call(publicOrigin)
            expect(await own.text()).toContain(
                "Server function info not found for unknown-function",
            )
        })

        it.skipIf(process.env.BROWSER_E2E !== "1")(
            "a browser on the proxy searches, rates the page and asks the assistant without leaving /help",
            async () => {
                const browser: Browser = await chromium.launch({
                    chromiumSandbox: false,
                })
                try {
                    const page = await browser.newPage({
                        viewport: { width: 1280, height: 900 },
                    })
                    const statuses = new Map<string, number>()
                    page.on("response", (response) => {
                        const url = new URL(response.url())
                        if (url.origin === publicOrigin)
                            statuses.set(url.pathname, response.status())
                    })
                    outside.length = 0
                    await page.goto(`${site}/guide`, {
                        waitUntil: "networkidle",
                    })

                    // A client navigation through the sidebar.
                    await page
                        .locator("aside#nd-sidebar")
                        .getByRole("link", { name: "Proxied Home" })
                        .click()
                    await page.waitForURL(site)
                    await page.goBack()
                    await page.waitForURL(`${site}/guide`)

                    const search = page.waitForResponse((response) =>
                        response.url().startsWith(`${site}/api/search?`),
                    )
                    await page.keyboard.press("ControlOrMeta+k")
                    await page
                        .getByRole("dialog")
                        .getByRole("textbox")
                        .fill("Guide body")
                    expect((await search).status()).toBe(200)
                    const result = page
                        .getByRole("dialog")
                        .getByRole("link", { name: /Proxied Guide/ })
                        .first()
                    await expect(result.getAttribute("href")).resolves.toBe(
                        "/help/guide",
                    )
                    await page.keyboard.press("Escape")

                    const feedback = page.waitForResponse(
                        (response) =>
                            response.url() === `${site}/api/agent/feedback`,
                    )
                    await page.getByRole("button", { name: "Yes" }).click()
                    expect((await feedback).ok()).toBe(true)

                    const chat = page.waitForRequest(
                        (request) => request.url() === `${site}/api/chat`,
                    )
                    await page
                        .getByRole("button", { name: "Assistant" })
                        .first()
                        .click()
                    const input = page.getByPlaceholder("Ask a question")
                    await input.fill("How do I start?")
                    await input.press("Enter")
                    const response = await (await chat).response()
                    expect(response?.status()).not.toBe(404)

                    expect(outside).toEqual([])
                    expect(
                        [...statuses].filter(([, status]) => status === 404),
                    ).toEqual([])
                } finally {
                    await browser.close()
                }
            },
            90_000,
        )
    },
)
