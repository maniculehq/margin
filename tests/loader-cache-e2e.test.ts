/** Opt-in Chromium checks for the docs page's client-navigation data path:
 * the router cache answers back/forward, the page RPC carries no chrome, and
 * RPC frames carry the shared CDN policy only on success. Run by `bun run
 * test:e2e` (Main CI), which builds the server and provisions the
 * database. The suite seeds its own two-locale site through the real
 * ingest pipeline. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { type Browser, chromium, type Page, type Response } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { env } from "@/env"
import { buildSearchCorpus, type SearchCorpusEntry } from "@/ingest/assets"

const SERVER_ENTRY = ".output/server/index.mjs"
const SITE_ID = "00000000-0000-4000-8000-000000000131"
const SITE_SLUG = "loader-cache"
const SENTINEL = "snapshot sentinel"
/** The lazy MdxBody executor chunk; holding it open keeps a js page on its
 * server snapshot. */
const MDX_BODY_CHUNK = /\/assets\/mdx-body-[\w-]+\.js$/

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

function corpusDataUrl(pages: readonly SearchCorpusEntry[]): string {
    const corpus = buildSearchCorpus(pages)
    return `data:application/gzip;base64,${corpus.gzipped.toString("base64")}`
}

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

/** Resolves with the RPC whose serialized payload names `slug` (the page
 * loader's slugs). Start it before the click: Playwright may report the URL
 * change before the response event. */
function rpcFor(page: Page, slug: string): Promise<Response> {
    return page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname.startsWith("/_serverFn") &&
            decodeURIComponent(response.url()).includes(`"s":"${slug}"`),
    )
}

/** Every server-function response the page receives from now on. */
function recordRpcs(page: Page): Response[] {
    const responses: Response[] = []
    page.on("response", (response) => {
        if (new URL(response.url()).pathname.startsWith("/_serverFn"))
            responses.push(response)
    })
    return responses
}

function sidebar(page: Page) {
    return page.locator("aside#nd-sidebar")
}

describe.skipIf(!runnable)("docs page loader cache", () => {
    let browser: Browser
    let child: ChildProcess
    let baseUrl = ""

    beforeAll(async () => {
        const { compileDocs } = await import("@/ingest/compile")
        const { persistDocsVersion } = await import("@/ingest/persist")
        const { db, schema } = await import("@/db")
        await db
            .insert(schema.docsSite)
            .values({
                id: SITE_ID,
                slug: SITE_SLUG,
                name: "Loader Cache Docs",
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
                    name: "Loader Cache Docs",
                    navigation: {
                        // One tab per locale: each locale's sidebar is its
                        // tab's tree, so both chrome keys are `tabs:0` and
                        // only the locale tells them apart.
                        languages: [
                            {
                                language: "en",
                                default: true,
                                tabs: [
                                    {
                                        tab: "Guides",
                                        pages: [
                                            "index",
                                            "alpha",
                                            "beta",
                                            "expr",
                                            "long",
                                            "things",
                                        ],
                                    },
                                ],
                            },
                            {
                                language: "es",
                                tabs: [
                                    {
                                        tab: "Guías",
                                        pages: ["es/index", "es/alfa"],
                                    },
                                ],
                            },
                        ],
                    },
                }),
            },
            {
                path: "index.mdx",
                kind: "text",
                content: "---\ntitle: Loader Home\n---\n\nHome body.\n",
            },
            {
                path: "alpha.mdx",
                kind: "text",
                // Cards render fumadocs' Link, i.e. a router <Link>: the
                // header's locale menu uses plain anchors that reload the
                // document, and no sidebar entry points at a missing page.
                content:
                    '---\ntitle: Alpha Guide\n---\n\nAlpha body.\n\n<Card title="Guía en español" href="/es/alfa" />\n\n<Card title="Missing page" href="/no-such-page" />\n',
            },
            {
                path: "beta.mdx",
                kind: "text",
                content: "---\ntitle: Beta Guide\n---\n\nBeta body.\n",
            },
            {
                path: "expr.mdx",
                kind: "text",
                // The MDX expression puts this page on the compiled-JS path
                // (isolate snapshot + browser MdxBody). SENTINEL is only the
                // evaluated output, so it counts copies of the snapshot.
                content:
                    '---\ntitle: Expression Guide\n---\n\nExpression body.\n\n{"snapshot " + "sentinel"}\n',
            },
            {
                path: "long.mdx",
                kind: "text",
                // Tall enough to scroll, with an anchor mid-page: typing in
                // the search dialog must not move it.
                content: [
                    "---\ntitle: Long Guide\n---\n",
                    ...Array.from(
                        { length: 40 },
                        (_, index) => `Opening paragraph ${index}.\n`,
                    ),
                    "## Target section\n",
                    ...Array.from(
                        { length: 40 },
                        (_, index) => `Closing paragraph ${index}.\n`,
                    ),
                ].join("\n"),
            },
            {
                path: "things.mdx",
                kind: "text",
                content:
                    '---\ntitle: List things\nopenapi: "openapi.yaml GET /things"\n---\n',
            },
            {
                path: "openapi.yaml",
                kind: "text",
                // Enough parameters that the one-column (sub-xl) console puts
                // the playground panel well below the fold.
                content: [
                    "openapi: 3.1.0",
                    "info:",
                    "  title: Things API",
                    "  version: 1.0.0",
                    "servers:",
                    "  - url: https://api.things.test",
                    "paths:",
                    "  /things:",
                    "    get:",
                    "      operationId: listThings",
                    "      summary: List things",
                    "      parameters:",
                    ...Array.from({ length: 30 }, (_, index) => [
                        `        - name: filter${index}`,
                        "          in: query",
                        `          description: Narrows the list by field ${index}.`,
                        "          schema:",
                        "            type: string",
                    ]).flat(),
                    "      responses:",
                    '        "200":',
                    "          description: OK",
                    "",
                ].join("\n"),
            },
            {
                path: "styles.css",
                kind: "text",
                content: ".loader-cache-marker{color:rgb(1,2,3)}\n",
            },
            {
                path: "es/index.mdx",
                kind: "text",
                content: "---\ntitle: Inicio\n---\n\nCuerpo de inicio.\n",
            },
            {
                path: "es/alfa.mdx",
                kind: "text",
                content: "---\ntitle: Guía Alfa\n---\n\nCuerpo alfa.\n",
            },
        ])
        if (!compiled.ok) throw new Error("loader-cache fixture failed")
        await persistDocsVersion({
            siteId: SITE_ID,
            commitSha: "0000000000000000000000000000000000000131",
            kind: "production",
            replaceExisting: true,
            seq: 9_999_931,
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
            searchCorpusUrl: corpusDataUrl(compiled.pages),
        })

        const port = await freePort()
        baseUrl = `http://127.0.0.1:${port}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                // A developer's DSN must not file local runs as production.
                SENTRY_DSN: "",
                PORT: String(port),
                SITE_SLUG: SITE_SLUG,
                // Only the external answer stream is replaced in the browser.
                AI_GATEWAY_API_KEY: "test-gateway-key",
                NODE_ENV: "production",
                // Off production every response is private, no-store
                // (previewMiddleware); the shared policy is what's under test.
                VERCEL_ENV: "production",
                SITE_ORIGIN: baseUrl,
            },
            stdio: "ignore",
        })
        const deadline = Date.now() + 30_000
        for (;;) {
            try {
                if ((await fetch(`${baseUrl}/llms.txt`)).status === 200) break
            } catch {
                // still booting
            }
            if (Date.now() > deadline)
                throw new Error("built server did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
        browser = await chromium.launch({ chromiumSandbox: false })
    }, 120_000)

    afterAll(async () => {
        await browser?.close()
        child?.kill("SIGTERM")
    })

    async function openPage(path: string): Promise<Page> {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" })
        return page
    }

    it("A→B fetches one chrome-free page RPC and back fetches none", async () => {
        const page = await openPage("/alpha")
        const rpcs = recordRpcs(page)
        const beta = rpcFor(page, "beta")
        await sidebar(page).locator('a[href="/beta"]').click()
        const body = await (await beta).text()
        await expect
            .poll(() => page.locator("h1").first().textContent())
            .toBe("Beta Guide")
        expect(body).toContain("Beta Guide")
        expect(body).not.toContain("pageTree")
        expect(body).not.toContain("versionsManifest")

        await page.goBack()
        await page.waitForURL(`${baseUrl}/alpha`)
        await expect
            .poll(() => page.locator("h1").first().textContent())
            .toBe("Alpha Guide")
        // Response events can trail the render; give a stray RPC time to
        // surface before asserting there was none. The hydrated document
        // seeded the chrome memo, so B cost only its page RPC.
        await page.waitForTimeout(500)
        expect(rpcs).toHaveLength(1)
        await page.context().close()
    }, 60_000)

    it("an RPC 200 carries the shared policy; an RPC 404 frame carries none", async () => {
        const page = await openPage("/alpha")
        const beta = rpcFor(page, "beta")
        await sidebar(page).locator('a[href="/beta"]').click()
        const ok = await beta
        expect(ok.status()).toBe(200)
        expect(ok.headers()["cache-control"]).toContain("s-maxage=")
        expect(ok.headers()["vercel-cache-tag"]).toBe(`site-${SITE_SLUG}`)

        await page.goBack()
        await page.waitForURL(`${baseUrl}/alpha`)
        const miss = rpcFor(page, "no-such-page")
        await page.locator('a[href="/no-such-page"]').click()
        // Start frames a loader notFound inside the RPC body; the frame must
        // not carry the shared policy (the loader sets it after its last
        // throw).
        const missing = await miss
        expect(missing.headers()["cache-control"]).toBeUndefined()
        await page.context().close()
    }, 60_000)

    it("a client navigation into /es then back renders Spanish then English nav", async () => {
        const page = await openPage("/alpha")
        await page.locator('a[href="/es/alfa"]').click()
        await expect
            .poll(() => page.locator("h1").first().textContent())
            .toBe("Guía Alfa")
        await expect(
            sidebar(page).locator('a[href="/es/alfa"]').count(),
        ).resolves.toBeGreaterThan(0)
        await expect(
            sidebar(page).locator('a[href="/beta"]').count(),
        ).resolves.toBe(0)

        await page.goBack()
        await expect
            .poll(() => page.locator("h1").first().textContent())
            .toBe("Alpha Guide")
        await expect(
            sidebar(page).locator('a[href="/beta"]').count(),
        ).resolves.toBeGreaterThan(0)
        await expect(
            sidebar(page).locator('a[href="/es/alfa"]').count(),
        ).resolves.toBe(0)
        await page.context().close()
    }, 60_000)

    it("a js document ships its snapshot once and hydrates onto it", async () => {
        const html = await (await fetch(`${baseUrl}/expr`)).text()
        expect(html.split(SENTINEL)).toHaveLength(2)
        const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g)
        expect(scripts?.join("")).not.toContain(SENTINEL)

        const context = await browser.newContext()
        const page = await context.newPage()
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text())
        })
        // Hold the executor chunk: once hydrated, only the snapshot node
        // (whose dehydrated value is empty) can be showing the article.
        await page.route(MDX_BODY_CHUNK, () => undefined)
        await page.goto(`${baseUrl}/expr`)
        await page.waitForFunction(() => {
            const node = document.querySelector("[data-ssr-body]")
            return (
                node !== null &&
                Object.keys(node).some((key) => key.startsWith("__reactFiber"))
            )
        })
        await expect(
            page.locator("[data-ssr-body]").innerText(),
        ).resolves.toContain(SENTINEL)
        expect(
            errors.filter((text) => /hydrat|#41[89]|#42[35]/i.test(text)),
        ).toEqual([])
        await context.close()
    }, 60_000)

    it("a hydrated js page swaps to the live body without doubling it", async () => {
        const page = await openPage("/expr")
        // The snapshot leaves the DOM once the live body lands, taking its
        // duplicate heading ids with it.
        await expect.poll(() => page.locator("[data-ssr-body]").count()).toBe(0)
        const text = await page.locator("#nd-page").innerText()
        expect(text.split(SENTINEL)).toHaveLength(2)
        await page.context().close()
    }, 60_000)

    it("a client navigation to a js page still shows the snapshot", async () => {
        const page = await openPage("/alpha")
        await page.route(MDX_BODY_CHUNK, () => undefined)
        const expr = rpcFor(page, "expr")
        await sidebar(page).locator('a[href="/expr"]').click()
        // The RPC is the only copy the browser gets, so it carries the HTML.
        expect(await (await expr).text()).toContain(SENTINEL)
        await expect
            .poll(() => page.locator("[data-ssr-body]").innerText())
            .toContain(SENTINEL)
        await page.context().close()
    }, 60_000)

    it("inlines only the token block and serves site CSS by content address", async () => {
        const html = await (await fetch(`${baseUrl}/alpha`)).text()
        const blocks = [
            ...html.matchAll(/<style data-site-css[^>]*>([\s\S]*?)<\/style>/g),
        ]
        expect(blocks).toHaveLength(1)
        expect(blocks[0]?.[1]).toMatch(/^:root\{[^{}]*\}\.dark\{[^{}]*\}$/)
        expect(html).not.toContain("loader-cache-marker")
        const href = html.match(/href="(\/_theme\/[a-f\d]{32}\.css)"/)?.[1]
        expect(href).toBeTruthy()

        const current = await fetch(`${baseUrl}${href}`)
        expect(current.headers.get("content-type")).toContain("text/css")
        expect(current.headers.get("cache-control")).toBe(
            "public, max-age=31536000, immutable",
        )
        const css = await current.text()
        expect(css).toContain(".loader-cache-marker")

        // A document cached before a publish still names the old hash: it
        // gets the current CSS under the shared, purge-tagged policy.
        const stale = await fetch(`${baseUrl}/_theme/${"0".repeat(32)}.css`)
        expect(stale.status).toBe(200)
        expect(stale.headers.get("cache-control")).toContain("s-maxage=")
        expect(stale.headers.get("vercel-cache-tag")).toBe(`site-${SITE_SLUG}`)
        expect(await stale.text()).toBe(css)
    }, 60_000)

    it("typing in search mirrors ?search= without moving the page, and Back reopens it", async () => {
        const page = await openPage("/long#target-section")
        // Off the anchor: a jump back to #target-section would show.
        await page.evaluate(() => window.scrollBy(0, 300))
        const scrollY = await page.evaluate(() => window.scrollY)
        expect(scrollY).toBeGreaterThan(300)

        await page.keyboard.press("ControlOrMeta+k")
        const dialog = page.locator("div[role='dialog']", {
            has: page.locator("input"),
        })
        await dialog.waitFor({ state: "visible" })
        await page.keyboard.type("Beta")
        await expect
            .poll(() => new URL(page.url()).searchParams.get("search"))
            .toBe("Beta")
        const mirrored = new URL(page.url())
        expect(mirrored.pathname).toBe("/long")
        expect(mirrored.hash).toBe("#target-section")
        expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)

        // A result click leaves ?search= on the page it was typed on.
        const result = dialog.locator('a[href="/beta"]').first()
        await result.waitFor()
        await result.click()
        await expect
            .poll(() => page.locator("h1").first().textContent())
            .toBe("Beta Guide")
        expect(new URL(page.url()).search).toBe("")

        await page.goBack()
        await dialog.waitFor({ state: "visible" })
        await expect
            .poll(() => dialog.locator("input").inputValue())
            .toBe("Beta")
        expect(new URL(page.url()).pathname).toBe("/long")

        // Closing strips the param and keeps the fragment.
        await page.keyboard.press("Escape")
        await dialog.waitFor({ state: "hidden" })
        await expect
            .poll(() => new URL(page.url()).searchParams.has("search"))
            .toBe(false)
        expect(new URL(page.url()).hash).toBe("#target-section")
        await page.context().close()
    }, 60_000)

    it("a Try-it click before the console mounts still opens the playground", async () => {
        const context = await browser.newContext({
            viewport: { width: 900, height: 700 },
        })
        const page = await context.newPage()
        let release = () => {}
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        await page.route(/\/assets\/api-page-[\w-]+\.js$/, async (route) => {
            await held
            await route.continue()
        })
        await page.goto(`${baseUrl}/things`)
        const tryIt = page.locator("button[data-endpoint-try-it]")
        await page.waitForFunction(() => {
            const node = document.querySelector("[data-endpoint-try-it]")
            return (
                node !== null &&
                Object.keys(node).some((key) => key.startsWith("__reactFiber"))
            )
        })
        expect(await page.locator("[data-api-playground]").count()).toBe(0)

        await tryIt.click()
        // Longer than the old 2 s DOM-polling budget gave the chunk.
        await page.waitForTimeout(2_500)
        release()
        // The playground is a modal: the early click must leave it
        // open once the console chunk mounts, not render it closed.
        const panel = page.getByRole("dialog")
        await panel.waitFor()
        expect(await panel.getAttribute("data-api-playground")).toBe("")
        await expect
            .poll(() =>
                panel.evaluate((node) => {
                    const rect = node.getBoundingClientRect()
                    return rect.top < window.innerHeight && rect.bottom > 0
                }),
            )
            .toBe(true)
        await context.close()
    }, 60_000)

    it("one Try-it click opens the request form with Send, in a single modal", async () => {
        // QA finding 300: fumadocs-openapi 12.3's playground slot brings its
        // own endpoint bar and modal; nested in a framework modal, Try it
        // showed a second "Try in Playground" button instead of the form.
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
        })
        const page = await context.newPage()
        await page.goto(`${baseUrl}/things`, { waitUntil: "networkidle" })
        await page.locator("button[data-endpoint-try-it]").click()
        const dialog = page.getByRole("dialog")
        await expect
            .poll(() =>
                dialog.getByRole("button", { name: "Send" }).isVisible(),
            )
            .toBe(true)
        expect(await dialog.count()).toBe(1)
        expect(
            await page
                .getByRole("button", { name: "Try in Playground" })
                .count(),
        ).toBe(0)
        await context.close()
    }, 60_000)

    it("closing the console returns focus to the Try-it button", async () => {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
        })
        const page = await context.newPage()
        await page.goto(`${baseUrl}/things`, { waitUntil: "networkidle" })
        await page.locator("button[data-endpoint-try-it]").click()
        await page
            .getByRole("dialog")
            .getByRole("button", { name: "Send" })
            .waitFor()
        await page.keyboard.press("Escape")
        await expect
            .poll(() =>
                page.evaluate(() =>
                    document.activeElement?.hasAttribute(
                        "data-endpoint-try-it",
                    ),
                ),
            )
            .toBe(true)
        // The close animation may still be running when focus moves.
        await expect.poll(() => page.getByRole("dialog").count()).toBe(0)
        await context.close()
    }, 60_000)

    /** Asks `question` in the panel and resolves with the chat response. */
    async function ask(page: Page, question: string): Promise<Response> {
        await page.keyboard.press("ControlOrMeta+i")
        const input = page.locator("#nd-ai-input")
        await input.waitFor()
        const response = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/chat",
        )
        await input.fill(question)
        await input.press("Enter")
        return response
    }

    function panelMessageCount(page: Page, message: string) {
        return page
            .locator("[data-assistant-panel]")
            .getByText(message, { exact: true })
            .count()
    }

    it.each([
        {
            format: "structured",
            body: JSON.stringify({
                error: "assistant_not_configured",
                message:
                    "The assistant is not configured. Use documentation search instead.",
            }),
            message:
                "The assistant is not configured. Use documentation search instead.",
        },
        {
            format: "invalid structured",
            body: '{"error":"unavailable","message":42}',
            message: "The assistant request failed. Please try again.",
        },
        {
            format: "unstructured",
            body: "Upstream unavailable",
            message: "The assistant request failed. Please try again.",
        },
    ])(
        "keeps documentation search usable after an assistant 503 with $format content",
        async ({ body, message }) => {
            const page = await openPage("/alpha")
            try {
                await page.route("**/api/chat", (route) =>
                    route.fulfill({
                        status: 503,
                        contentType: "application/json",
                        body,
                    }),
                )
                const response = await ask(page, "How do I install?")
                expect(response.status()).toBe(503)
                await expect
                    .poll(() => panelMessageCount(page, message), {
                        timeout: 5_000,
                    })
                    .toBe(1)
                expect(
                    await page.locator("[data-assistant-panel]").innerText(),
                ).not.toContain('{"error"')
                expect(await page.locator("#nd-ai-input").isEnabled()).toBe(
                    true,
                )
                await page.keyboard.press("Escape")
                await page.keyboard.press("ControlOrMeta+k")
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input[placeholder='Search...']"),
                })
                await dialog.waitFor()
                await dialog.locator("input").fill("Beta")
                await dialog.locator('a[href="/beta"]').first().waitFor()
                expect(await dialog.isVisible()).toBe(true)
            } finally {
                await page.context().close()
            }
        },
        60_000,
    )

    it("shows the server's rate-limit wait in the panel", async () => {
        const { db, schema } = await import("@/db")
        const { and, eq } = await import("drizzle-orm")
        const siteDay = and(
            eq(schema.publicRateLimit.bucket, "docs_chat_site_day"),
            eq(schema.publicRateLimit.key, `docs_chat:${SITE_ID}`),
        )
        // The site's daily allowance is spent and resets in five minutes.
        await db.delete(schema.publicRateLimit).where(siteDay)
        await db.insert(schema.publicRateLimit).values({
            id: crypto.randomUUID(),
            bucket: "docs_chat_site_day",
            key: `docs_chat:${SITE_ID}`,
            count: 3000,
            resetAt: new Date(Date.now() + 5 * 60_000),
        })
        const page = await openPage("/alpha")
        try {
            const response = await ask(page, "How do I install?")
            expect(response.status()).toBe(429)
            await expect
                .poll(
                    () =>
                        panelMessageCount(
                            page,
                            "This site's assistant has reached its daily limit. Try again in 5 minutes.",
                        ),
                    { timeout: 5_000 },
                )
                .toBe(1)
        } finally {
            await page.context().close()
            await db.delete(schema.publicRateLimit).where(siteDay)
        }
    }, 60_000)

    it("tells the visitor to start a new chat when the conversation is too long", async () => {
        const page = await openPage("/alpha")
        try {
            // Over the route's 512 KB body limit on its own.
            const response = await ask(page, "x".repeat(600_000))
            expect(response.status()).toBe(413)
            await expect
                .poll(
                    () =>
                        panelMessageCount(
                            page,
                            "This conversation is too long. Start a new chat to keep asking.",
                        ),
                    { timeout: 5_000 },
                )
                .toBe(1)
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("a 200-token streamed answer keeps the markdown cache at 32 entries", async () => {
        const tokens = Array.from(
            { length: 200 },
            (_, index) => `word${index} `,
        )
        // The UI message stream /api/chat would send, one delta every few
        // milliseconds so each lands as its own render.
        const chat = createServer((request, response) => {
            response.writeHead(200, {
                "access-control-allow-origin": "*",
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
            })
            if (request.method !== "POST") {
                response.end()
                return
            }
            const frames = [
                { type: "start" },
                { type: "start-step" },
                { type: "text-start", id: "t" },
                ...tokens.map((delta) => ({
                    type: "text-delta",
                    id: "t",
                    delta,
                })),
                { type: "text-end", id: "t" },
                { type: "finish-step" },
                { type: "finish" },
            ]
            let index = 0
            const timer = setInterval(() => {
                const frame = frames[index]
                index += 1
                if (frame === undefined) {
                    clearInterval(timer)
                    response.end("data: [DONE]\n\n")
                    return
                }
                response.write(`data: ${JSON.stringify(frame)}\n\n`)
            }, 5)
        })
        await new Promise<void>((resolve) =>
            chat.listen(0, "127.0.0.1", resolve),
        )
        const address = chat.address()
        if (!address || typeof address === "string")
            throw new Error("chat stub did not bind")
        const page = await openPage("/alpha")
        await page.route("**/api/chat", (route) =>
            route.continue({ url: `http://127.0.0.1:${address.port}/` }),
        )
        await page.keyboard.press("ControlOrMeta+i")
        const input = page.locator("#nd-ai-input")
        await input.waitFor()
        await input.fill("How long is this?")
        await input.press("Enter")
        const answer = page.locator("[data-assistant-panel] .prose").last()
        await expect
            .poll(() => answer.textContent(), { timeout: 20_000 })
            .toContain("word199")
        // The Markdown component's own promise cache (its useState hook).
        const size = await answer.evaluate((node) => {
            const key = Object.keys(node).find((name) =>
                name.startsWith("__reactFiber"),
            )
            let hook = key ? Reflect.get(node, key)?.child?.memoizedState : null
            while (hook) {
                if (hook.memoizedState instanceof Map)
                    return hook.memoizedState.size
                hook = hook.next
            }
            return -1
        })
        expect(size).toBeGreaterThan(0)
        expect(size).toBeLessThanOrEqual(32)
        await page.context().close()
        await new Promise<void>((resolve) => chat.close(() => resolve()))
    }, 60_000)
})
