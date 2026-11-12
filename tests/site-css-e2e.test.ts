/** Chromium checks that a site stylesheet written against the common
 * docs.json hooks takes effect, and that the URLs such a site already has
 * in circulation (heading anchors, section prefixes, the MCP endpoint) keep
 * resolving. Run by `bun run test:e2e` against the `site-css` fixture. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { env } from "@/env"

const SERVER_ENTRY = ".output/server/index.mjs"

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

describe.skipIf(!runnable)("site stylesheet hooks and inherited URLs", () => {
    let browser: Browser
    let child: ChildProcess
    let baseUrl: string

    beforeAll(async () => {
        browser = await chromium.launch({ chromiumSandbox: false })
        const probe = createServer()
        await new Promise<void>((resolve) =>
            probe.listen(0, "127.0.0.1", resolve),
        )
        const address = probe.address()
        if (!address || typeof address === "string")
            throw new Error("port probe failed")
        await new Promise<void>((resolve) => probe.close(() => resolve()))
        baseUrl = `http://127.0.0.1:${address.port}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                // A developer's DSN must not file local runs as production.
                SENTRY_DSN: "",
                PORT: String(address.port),
                SITE_SLUG: "site-css",
                SITE_ORIGIN: baseUrl,
                NODE_ENV: "production",
            },
            stdio: "ignore",
        })
        const deadline = Date.now() + 30_000
        for (;;) {
            const ready = await fetch(`${baseUrl}/llms.txt`)
                .then((res) => res.status === 200)
                .catch(() => false)
            if (ready) break
            if (Date.now() > deadline)
                throw new Error("built server did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
    }, 120_000)

    afterAll(async () => {
        await browser?.close()
        child?.kill("SIGTERM")
    })

    /** Opens a fixture page at desktop width, light scheme. */
    async function open(path: string): Promise<Page> {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            colorScheme: "light",
        })
        const page = await context.newPage()
        await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" })
        return page
    }
    const style = (page: Page, selector: string, property: string) =>
        page
            .locator(selector)
            .first()
            .evaluate(
                (element, name) =>
                    getComputedStyle(element).getPropertyValue(name),
                property,
            )

    it("an ID hook reaches the sidebar the layout renders", async () => {
        const page = await open("/")
        try {
            expect(
                await style(
                    page,
                    "#nd-sidebar a[data-active]",
                    "border-top-left-radius",
                ),
            ).toBe("2px")
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("a card's parts carry their hooks", async () => {
        const page = await open("/")
        try {
            const body = '[data-component-part="card-content"]'
            expect(await page.locator(body).first().textContent()).toContain(
                "Read the first guide.",
            )
            expect(await style(page, body, "font-size")).toBe("14px")
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("redefining a corner variable reshapes cards", async () => {
        const page = await open("/")
        try {
            expect(await style(page, ".card", "border-top-left-radius")).toBe(
                "6px",
            )
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("a rule scoped by the current path applies only under that path", async () => {
        const guide = await open("/guides/first")
        const home = await open("/")
        try {
            expect(await style(guide, "#nd-page h1", "letter-spacing")).toBe(
                "4px",
            )
            expect(await style(home, "#nd-page h1", "letter-spacing")).not.toBe(
                "4px",
            )
        } finally {
            await guide.context().close()
            await home.context().close()
        }
    }, 60_000)

    it("an ID hook styles the page region, not a heading with the same anchor", async () => {
        const page = await open("/")
        try {
            expect(
                await style(
                    page,
                    '[data-layout-item="pagination"]',
                    "letter-spacing",
                ),
            ).toBe("1px")
            expect(
                await style(page, "h2#pagination", "letter-spacing"),
            ).not.toBe("1px")
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("the mint theme sets cards on white over a tinted page", async () => {
        const page = await open("/")
        try {
            expect(await style(page, "body", "background-color")).toBe(
                "rgb(248, 246, 241)",
            )
            expect(await style(page, ".card", "background-color")).toBe(
                "rgb(255, 255, 255)",
            )
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("heading anchors hyphenate punctuation, keep symbols and number repeats from 2", async () => {
        const page = await open("/guides/first")
        try {
            expect(
                await page
                    .locator("#nd-page :is(h2, h3)[id]")
                    .evaluateAll((headings) =>
                        headings.map((heading) => heading.id),
                    ),
            ).toEqual([
                "install",
                "install-2",
                "domains-&-verification",
                "always-pass-decision-id",
            ])
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("a link to a heading's former anchor scrolls to that heading", async () => {
        const page = await open("/guides/first")
        try {
            // Short viewport: the last heading starts below the fold.
            await page.setViewportSize({ width: 1440, height: 320 })
            const heading = page.locator("#always-pass-decision-id")
            const top = () =>
                heading.evaluate(
                    (element) => element.getBoundingClientRect().top,
                )
            expect(await top()).toBeGreaterThan(320)
            await page.getByRole("link", { name: "the former anchor" }).click()
            await expect.poll(top).toBeLessThan(320)
        } finally {
            await page.context().close()
        }
    }, 60_000)

    it("a section prefix with no page redirects to its first page", async () => {
        const response = await fetch(`${baseUrl}/guides`, {
            redirect: "manual",
        })
        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe("/guides/first")
    })

    it("an MCP client posting to /mcp reaches the MCP server", async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('"tools"')
    })
})
