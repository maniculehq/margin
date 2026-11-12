/** A reader's browser reports each page view (routes/__root.tsx): once on
 * the first page, once per in-site navigation, never for a 404, through
 * the site's base path. Real Chromium against the built server and a local
 * PostHog sink, on the `acme` fixture under /docs, where every path the
 * report names must lose the base path and every URL it posts to must keep
 * it. Run by `bun run test:e2e`. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { gunzipSync } from "node:zlib"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const SERVER_ENTRY = ".output/server/index.mjs"
// Headless Chromium names itself in its user agent, which classifies as
// automation; a reader's browser does not.
const CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

const capturedEventSchema = z.looseObject({
    event: z.string(),
    properties: z.record(z.string(), z.unknown()).default({}),
})
const batchSchema = z.looseObject({
    batch: z.array(capturedEventSchema).default([]),
})

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
)("reported page views", () => {
    const events: z.infer<typeof capturedEventSchema>[] = []
    let sink: Server
    let child: ChildProcess
    let browser: Browser
    let origin = ""

    /** The paths of every page view reported so far, in arrival order. */
    const reported = () =>
        events
            .filter((event) => event.event === "docs_page_viewed")
            .map((event) => event.properties.$pathname)

    async function openPage(path: string): Promise<Page> {
        const context = await browser.newContext({ userAgent: CHROME_UA })
        const page = await context.newPage()
        await page.goto(`${origin}${path}`)
        return page
    }

    beforeAll(async () => {
        sink = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on("data", (chunk: Buffer) => chunks.push(chunk))
            req.on("end", () => {
                const raw = Buffer.concat(chunks)
                try {
                    const body =
                        req.headers["content-encoding"] === "gzip"
                            ? gunzipSync(raw)
                            : raw
                    const parsed = batchSchema.safeParse(
                        JSON.parse(body.toString("utf8")),
                    )
                    if (parsed.success) events.push(...parsed.data.batch)
                } catch {
                    // non-batch traffic — ignore
                }
                res.writeHead(200, { "content-type": "application/json" })
                res.end('{"status":"ok"}')
            })
        })
        await new Promise<void>((resolve) =>
            sink.listen(0, "127.0.0.1", resolve),
        )
        const sinkAddress = sink.address()
        if (!sinkAddress || typeof sinkAddress === "string")
            throw new Error("sink failed to bind")

        const port = await freePort()
        origin = `http://127.0.0.1:${port}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                PORT: String(port),
                SITE_SLUG: "acme",
                SITE_ORIGIN: `${origin}/docs`,
                SENTRY_DSN: "",
                POSTHOG_HOST: `http://127.0.0.1:${sinkAddress.port}`,
                POSTHOG_KEY: "test-key",
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
        browser = await chromium.launch()
    }, 60_000)

    afterAll(async () => {
        await browser?.close()
        child?.kill("SIGTERM")
        await new Promise<void>((resolve) => sink.close(() => resolve()))
    })

    it("reports the first page once, as a person's view, through the base path", async () => {
        const context = await browser.newContext({ userAgent: CHROME_UA })
        const page = await context.newPage()
        const report = page.waitForRequest((request) =>
            request.url().endsWith("/api/agent/event"),
        )
        await page.goto(`${origin}/docs/quickstart`)
        expect(new URL((await report).url()).pathname).toBe(
            "/docs/api/agent/event",
        )
        await expect
            .poll(reported, { timeout: 10_000 })
            .toContain("/quickstart")
        const event = events.find(
            (candidate) =>
                candidate.event === "docs_page_viewed" &&
                candidate.properties.$pathname === "/quickstart",
        )
        expect(event?.properties).toMatchObject({
            surface: "docs_html",
            traffic_category: "human",
            classification_version: 3,
            // No extension check on a self-hosted site: the report counts.
            view_verdict: "skipped",
        })
        await context.close()
    }, 30_000)

    it("reports each in-site navigation once, and the page it left only once", async () => {
        const before = reported().length
        const page = await openPage("/docs/quickstart")
        await expect
            .poll(() => reported().slice(before), { timeout: 10_000 })
            .toEqual(["/quickstart"])
        await page.locator('a[href="/docs/webhooks"]').first().click()
        await page.waitForURL(`${origin}/docs/webhooks`)
        await expect
            .poll(() => reported().slice(before), { timeout: 10_000 })
            .toEqual(["/quickstart", "/webhooks"])
        await page.context().close()
    }, 30_000)

    it("reports nothing for a page that is not found", async () => {
        const before = reported().length
        const missing = await openPage("/docs/no-such-page")
        expect(
            await missing.evaluate(() => document.title.includes("not found")),
        ).toBe(true)
        // Anything the 404 page sent has left it before the next page opens.
        await missing.waitForLoadState("networkidle")
        // A page that does exist, opened afterwards in the same way, is
        // reported: had the 404 reported too, its report would sit first.
        const found = await openPage("/docs/webhooks")
        await expect
            .poll(() => reported().slice(before), { timeout: 10_000 })
            .toEqual(["/webhooks"])
        await missing.context().close()
        await found.context().close()
    }, 30_000)
})
