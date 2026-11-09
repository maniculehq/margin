/** Exercise the docs tools through Chromium's native WebMCP API: `executeTool`
 * takes the input object (Chromium 156 dropped the JSON-string form) and
 * returns a JSON string. Run by `bun run test:e2e` (Main CI) against the
 * seeded fixtures. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { eq } from "drizzle-orm"
import {
    type Browser,
    type BrowserContext,
    chromium,
    type Page,
} from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { env } from "@/env"
import { MCP_TOOL_NAMES } from "@/lib/mcp-server"

const SERVER_ENTRY = ".output/server/index.mjs"
const WEBMCP_ARGS = [
    "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport",
]
const TOOL_NAMES = [
    "get_current_page_context",
    "get_site_overview",
    "open_documentation",
    "read_page",
    "read_skill",
    "search_docs",
]

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

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

async function bootSiteServer(
    slug: string,
): Promise<{ child: ChildProcess; baseUrl: string }> {
    const port = await freePort()
    const child = spawn("node", [SERVER_ENTRY], {
        env: {
            ...process.env,
            // A developer's DSN must not file local runs as production.
            SENTRY_DSN: "",
            PORT: String(port),
            SITE_SLUG: slug,
            SITE_ORIGIN: `http://127.0.0.1:${port}`,
            NODE_ENV: "production",
        },
        stdio: "ignore",
    })
    const baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30_000
    for (;;) {
        try {
            if ((await fetch(`${baseUrl}/llms.txt`)).status === 200) break
        } catch {
            // still booting
        }
        if (Date.now() > deadline) {
            child.kill("SIGTERM")
            await new Promise((r) => setTimeout(r, 500))
            if (child.exitCode === null) child.kill("SIGKILL")
            throw new Error(`built server for ${slug} did not become ready`)
        }
        await new Promise((r) => setTimeout(r, 250))
    }
    return { child, baseUrl }
}

/** Names of the tools currently registered on the page, sorted. */
async function toolNames(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        const modelContext = document.modelContext
        if (!modelContext) return []
        return (await modelContext.getTools()).map((tool) => tool.name).sort()
    })
}

/** Wait until the registered tool set equals `expected` (toolchange-driven). */
async function waitForTools(page: Page, expected: string[]): Promise<void> {
    await expect
        .poll(() => toolNames(page), { timeout: 15_000 })
        .toEqual([...expected].sort())
}

/** Execute a registered tool natively and parse its JSON-string result. */
async function runTool(
    page: Page,
    name: string,
    input: Record<string, unknown> = {},
): Promise<unknown> {
    const raw = await page.evaluate(
        async ({ toolName, args }) => {
            const modelContext = document.modelContext
            if (!modelContext) throw new Error("document.modelContext missing")
            const tool = (await modelContext.getTools()).find(
                (candidate) => candidate.name === toolName,
            )
            if (!tool) throw new Error(`tool ${toolName} not registered`)
            return modelContext.executeTool(tool, args)
        },
        { toolName: name, args: input },
    )
    if (typeof raw !== "string")
        throw new Error(`executeTool returned ${typeof raw}, expected string`)
    return JSON.parse(raw)
}

const okResult = z.object({ ok: z.literal(true) })
const errorResult = z.object({ ok: z.literal(false), error: z.string() })
const searchOk = okResult.extend({
    scope: z.object({ path: z.string() }),
    query: z.string(),
    results: z.array(
        z.object({
            url: z.string(),
            type: z.enum(["page", "heading", "text"]),
            content: z.string(),
        }),
    ),
    complete: z.boolean(),
})
const contextOk = okResult.extend({
    scope: z.object({ path: z.string(), canonical: z.string() }),
    url: z.string(),
    title: z.string(),
    headings: z.array(z.object({ id: z.string(), content: z.string() })),
    markdown: z.string(),
    truncated: z.boolean(),
})
const openOk = okResult.extend({
    href: z.string(),
    headingMatched: z.boolean().nullable(),
})

describe.skipIf(!runnable)("webmcp docs tools", () => {
    let browser: Browser
    let plainBrowser: Browser
    const servers = new Map<string, { child: ChildProcess; baseUrl: string }>()

    beforeAll(async () => {
        browser = await chromium.launch({
            chromiumSandbox: false,
            args: WEBMCP_ARGS,
        })
        plainBrowser = await chromium.launch({ chromiumSandbox: false })
        for (const slug of [
            "demo",
            "acme",
            "globex",
            "mintlify-verbatim",
            "cross-tab",
        ]) {
            await db
                .update(schema.docsSite)
                .set({ webmcpEnabled: true })
                .where(eq(schema.docsSite.slug, slug))
            servers.set(slug, await bootSiteServer(slug))
        }
    }, 180_000)

    afterAll(async () => {
        await browser?.close()
        await plainBrowser?.close()
        for (const { child } of servers.values()) child.kill("SIGTERM")
    })

    function baseUrl(slug: string): string {
        const server = servers.get(slug)
        if (!server) throw new Error(`no server for ${slug}`)
        return server.baseUrl
    }

    async function openPage(
        context: BrowserContext,
        slug: string,
        path: string,
    ): Promise<Page> {
        const page = await context.newPage()
        await page.goto(`${baseUrl(slug)}${path}`, { waitUntil: "networkidle" })
        return page
    }

    it("MCP discovery advertises the public endpoint and its tools", async () => {
        const response = await fetch(`${baseUrl("demo")}/.well-known/mcp.json`)
        expect(response.status).toBe(200)
        const discovery = z
            .object({
                transport: z.literal("streamable-http"),
                url: z.string(),
                tools: z.array(z.string()),
            })
            .parse(await response.json())
        expect(discovery.url).toBe(`${baseUrl("demo")}/api/mcp`)
        expect(discovery.tools).toEqual(MCP_TOOL_NAMES)
    })

    it.each(["legacy", "2026-07-28"])(
        "the built MCP endpoint serves %s clients",
        async (revision) => {
            const client = new Client(
                { name: "built-docs-test", version: "1.0.0" },
                {
                    versionNegotiation: {
                        mode:
                            revision === "legacy"
                                ? "legacy"
                                : { pin: revision },
                    },
                },
            )
            try {
                await client.connect(
                    new StreamableHTTPClientTransport(
                        new URL(`${baseUrl("cross-tab")}/api/mcp`),
                    ),
                )
                const result = z
                    .object({
                        content: z.tuple([
                            z.object({
                                type: z.literal("text"),
                                text: z.string(),
                            }),
                        ]),
                    })
                    .parse(
                        await client.callTool({
                            name: "list_docs",
                            arguments: {},
                        }),
                    )
                const listing = z
                    .object({ pages: z.array(z.object({ url: z.string() })) })
                    .parse(JSON.parse(result.content[0].text))
                expect(listing.pages.map((page) => page.url).sort()).toEqual([
                    "/",
                    "/api-reference",
                    "/status",
                ])
            } finally {
                await client.close()
            }
        },
    )

    it("registers exactly the docs tools on a docs page", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "demo", "/")
        await waitForTools(page, TOOL_NAMES)
        const annotations = await page.evaluate(async () => {
            const tools = (await document.modelContext?.getTools()) ?? []
            return Object.fromEntries(
                tools.map((tool) => [tool.name, tool.annotations ?? {}]),
            )
        })
        expect(annotations.search_docs?.readOnlyHint).toBe(true)
        expect(annotations.get_current_page_context?.readOnlyHint).toBe(true)
        expect(annotations.read_page?.readOnlyHint).toBe(true)
        expect(annotations.get_site_overview?.readOnlyHint).toBe(true)
        expect(annotations.read_skill?.readOnlyHint).toBe(true)
        expect(annotations.open_documentation?.readOnlyHint ?? false).toBe(
            false,
        )
        await context.close()
    }, 60_000)

    it("search_docs returns same-site results only", async () => {
        const context = await browser.newContext()
        const demo = await openPage(context, "demo", "/")
        await waitForTools(demo, TOOL_NAMES)
        const demoResult = searchOk.parse(
            await runTool(demo, "search_docs", { query: "content" }),
        )
        expect(demoResult.results.length).toBeGreaterThan(0)
        expect(demoResult.scope.path).toBe("/")
        for (const row of demoResult.results) {
            const response = await fetch(`${baseUrl("demo")}${row.url}`)
            expect(response.status, row.url).toBe(200)
        }

        const acme = await openPage(context, "acme", "/")
        await waitForTools(acme, TOOL_NAMES)
        const acmeResult = searchOk.parse(
            await runTool(acme, "search_docs", { query: "content" }),
        )
        const acmeUrls = new Set(acmeResult.results.map((row) => row.url))
        for (const row of demoResult.results) {
            expect(acmeUrls.has(row.url), row.url).toBe(false)
        }
        const acmeCharge = searchOk.parse(
            await runTool(acme, "search_docs", { query: "charge", limit: 3 }),
        )
        expect(acmeCharge.results.length).toBeGreaterThan(0)
        expect(acmeCharge.results.length).toBeLessThanOrEqual(3)
        expect(
            acmeCharge.results.some((row) =>
                /payment|charge/i.test(row.content),
            ),
        ).toBe(true)
        await context.close()
    }, 90_000)

    it("search_docs keys /api/search by scope, not page path", async () => {
        const context = await browser.newContext()
        // Pass through to the real server while disabling browser HTTP cache:
        // Chromium otherwise reports the cached second fetch twice.
        await context.route("**/api/search?**", (route) => route.continue())
        const searchUrls: string[] = []
        context.on("request", (request) => {
            const url = new URL(request.url())
            if (url.pathname === "/api/search") searchUrls.push(request.url())
        })
        for (const path of ["/quickstart", "/webhooks"]) {
            const page = await openPage(context, "acme", path)
            await waitForTools(page, TOOL_NAMES)
            searchOk.parse(
                await runTool(page, "search_docs", { query: "charge" }),
            )
        }
        // One query typed on two pages of one locale is one CDN entry.
        expect(searchUrls, JSON.stringify(searchUrls)).toHaveLength(2)
        expect(searchUrls[0]).toBe(searchUrls[1])
        expect(new URL(searchUrls[0] ?? "").searchParams.get("path")).toBe("/")
        await context.close()
    }, 60_000)

    it("search_docs rejects invalid input without fetching", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "demo", "/")
        await waitForTools(page, TOOL_NAMES)
        const result = errorResult.parse(
            await runTool(page, "search_docs", { query: "", limit: 999 }),
        )
        expect(result.error).toBe("invalid_input")
        await context.close()
    }, 60_000)

    it("get_current_page_context follows client-side navigation", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "demo", "/")
        await waitForTools(page, TOOL_NAMES)
        const home = contextOk.parse(
            await runTool(page, "get_current_page_context"),
        )
        expect(home.scope.path).toBe("/")
        expect(home.title).toBe("Hello World")
        expect(home.truncated).toBe(false)

        const opened = openOk.parse(
            await runTool(page, "open_documentation", {
                path: "/content-versions",
                heading: "How content flows",
            }),
        )
        expect(opened.headingMatched).toBe(true)
        expect(opened.href.startsWith("/content-versions#")).toBe(true)
        await page.waitForURL(/\/content-versions#/)
        await waitForTools(page, TOOL_NAMES)
        await expect
            .poll(async () => {
                const parsed = contextOk.safeParse(
                    await runTool(page, "get_current_page_context"),
                )
                return parsed.success ? parsed.data.scope.path : null
            })
            .toBe("/content-versions")
        const after = contextOk.parse(
            await runTool(page, "get_current_page_context"),
        )
        expect(after.title).toBe("Build-time content versions")
        expect(
            after.headings.some((h) => h.content === "How content flows"),
        ).toBe(true)
        await context.close()
    }, 90_000)

    it("open_documentation resolves a heading with one summary request", async () => {
        const context = await browser.newContext()
        const contextUrls: string[] = []
        context.on("request", (request) => {
            if (
                new URL(request.url()).pathname.startsWith(
                    "/api/agent/context/",
                )
            )
                contextUrls.push(request.url())
        })
        const page = await openPage(context, "demo", "/")
        await waitForTools(page, TOOL_NAMES)
        const opened = openOk.parse(
            await runTool(page, "open_documentation", {
                path: "/content-versions",
                heading: "How content flows",
            }),
        )
        expect(opened.headingMatched).toBe(true)
        expect(contextUrls).toHaveLength(1)
        expect(new URL(contextUrls[0] ?? "").searchParams.get("view")).toBe(
            "summary",
        )
        await context.close()
    }, 60_000)

    it("open_documentation rejects external, protocol-relative, and unknown paths", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "demo", "/")
        await waitForTools(page, TOOL_NAMES)
        for (const path of [
            "https://example.com/",
            "//example.com/",
            "/\\content-versions",
            "javascript:alert(1)",
            "/content-versions?x=1",
        ]) {
            const result = errorResult.parse(
                await runTool(page, "open_documentation", { path }),
            )
            expect(result.error, path).toBe("invalid_input")
        }
        const unknown = errorResult.parse(
            await runTool(page, "open_documentation", { path: "/quickstart" }),
        )
        expect(unknown.error).toBe("unknown_path")
        expect(new URL(page.url()).pathname).toBe("/")
        await context.close()
    }, 60_000)

    it("open_documentation opens a search result in another navigation tab", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "cross-tab", "/")
        await waitForTools(page, TOOL_NAMES)
        const search = searchOk.parse(
            await runTool(page, "search_docs", { query: "API Reference" }),
        )
        expect(search.results.some((row) => row.url === "/api-reference")).toBe(
            true,
        )
        const opened = openOk.parse(
            await runTool(page, "open_documentation", {
                path: "/api-reference",
            }),
        )
        expect(opened.href).toBe("/api-reference")
        await page.waitForURL(/\/api-reference$/)
        await context.close()
    }, 60_000)

    it("open_documentation navigates a .md path to its canonical page", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "cross-tab", "/")
        await waitForTools(page, TOOL_NAMES)
        const opened = openOk.parse(
            await runTool(page, "open_documentation", {
                path: "/api-reference.md",
            }),
        )
        expect(opened.href).toBe("/api-reference")
        await page.waitForURL(/\/api-reference$/)
        await context.close()
    }, 60_000)

    it("open_documentation refuses a page that redirects off-site", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "cross-tab", "/")
        await waitForTools(page, TOOL_NAMES)
        const refused = errorResult.parse(
            await runTool(page, "open_documentation", { path: "/status" }),
        )
        expect(refused.error).toBe("external_page")
        expect(new URL(page.url()).pathname).toBe("/")
        await context.close()
    }, 60_000)

    it("open_documentation validates existing pages across versions with the server", async () => {
        const context = await browser.newContext()
        const page = await openPage(
            context,
            "mintlify-verbatim",
            "/v2/overview",
        )
        await waitForTools(page, TOOL_NAMES)
        const opened = openOk.parse(
            await runTool(page, "open_documentation", { path: "/v1/overview" }),
        )
        expect(opened.href).toBe("/v1/overview")
        await page.waitForURL(/\/v1\/overview$/)
        await context.close()
    }, 60_000)

    it("read_page reads another page than the one open", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "acme", "/")
        await waitForTools(page, TOOL_NAMES)
        const result = okResult
            .extend({
                path: z.string(),
                text: z.string(),
                truncated: z.boolean(),
            })
            .parse(await runTool(page, "read_page", { path: "/webhooks" }))
        expect(result.path).toBe("/webhooks")
        expect(result.text).toContain("Verify signatures")
        expect(result.truncated).toBe(false)
        const missing = errorResult.parse(
            await runTool(page, "read_page", { path: "/no-such-page" }),
        )
        expect(missing.error).toBe("unknown_path")
        await context.close()
    }, 60_000)

    it("get_site_overview returns the site's llms.txt", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "acme", "/quickstart")
        await waitForTools(page, TOOL_NAMES)
        const result = okResult
            .extend({ text: z.string() })
            .parse(await runTool(page, "get_site_overview"))
        const index = await (await fetch(`${baseUrl("acme")}/llms.txt`)).text()
        expect(result.text).toBe(index)
        await context.close()
    }, 60_000)

    it("read_skill lists the site's skills and reads one", async () => {
        const context = await browser.newContext()
        const page = await openPage(context, "globex", "/")
        await waitForTools(page, TOOL_NAMES)
        const listed = okResult
            .extend({
                skills: z.array(
                    z.object({ name: z.string(), description: z.string() }),
                ),
            })
            .parse(await runTool(page, "read_skill"))
        expect(listed.skills.map((skill) => skill.name)).toContain(
            "globex-telemetry",
        )
        const read = okResult
            .extend({ name: z.string(), text: z.string() })
            .parse(
                await runTool(page, "read_skill", { name: "globex-telemetry" }),
            )
        expect(read.text).toContain("globex.track(name, properties)")
        await context.close()
    }, 60_000)

    it("renders and hydrates normally without WebMCP support", async () => {
        const context = await plainBrowser.newContext()
        const page = await context.newPage()
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text())
        })
        await page.goto(`${baseUrl("demo")}/`, { waitUntil: "networkidle" })
        expect(await page.evaluate(() => typeof document.modelContext)).toBe(
            "undefined",
        )
        expect(await page.locator("article").innerText()).toContain(
            "Hello World",
        )
        expect(errors).toEqual([])
        await context.close()
    }, 60_000)
})
