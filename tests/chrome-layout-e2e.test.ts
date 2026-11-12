/** Chromium checks for docs chrome layout regressions found by the October
 * 2026 cross-browser QA pass. Run by `bun run test:e2e` against the
 * ingested fixtures, one built server per fixture site. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { env } from "@/env"

const SERVER_ENTRY = ".output/server/index.mjs"

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

describe.skipIf(!runnable)("docs chrome layout", () => {
    let browser: Browser
    const servers = new Map<string, { child: ChildProcess; baseUrl: string }>()

    beforeAll(async () => {
        browser = await chromium.launch({ chromiumSandbox: false })
        for (const slug of [
            "demo",
            "acme",
            "gantt-tabs",
            "code-wrap",
            "luma",
        ]) {
            const probe = createServer()
            await new Promise<void>((resolve) =>
                probe.listen(0, "127.0.0.1", resolve),
            )
            const address = probe.address()
            if (!address || typeof address === "string")
                throw new Error("port probe failed")
            await new Promise<void>((resolve) => probe.close(() => resolve()))
            const child = spawn("node", [SERVER_ENTRY], {
                env: {
                    ...process.env,
                    // A developer's DSN must not file local runs as production.
                    SENTRY_DSN: "",
                    PORT: String(address.port),
                    SITE_SLUG: slug,
                    SITE_ORIGIN: `http://127.0.0.1:${address.port}`,
                    NODE_ENV: "production",
                },
                stdio: "ignore",
            })
            const baseUrl = `http://127.0.0.1:${address.port}`
            servers.set(slug, { child, baseUrl })
            const deadline = Date.now() + 30_000
            for (;;) {
                const ready = await fetch(`${baseUrl}/llms.txt`)
                    .then((res) => res.status === 200)
                    .catch(() => false)
                if (ready) break
                if (Date.now() > deadline)
                    throw new Error(
                        `built server for ${slug} did not become ready`,
                    )
                await new Promise((r) => setTimeout(r, 250))
            }
        }
    }, 120_000)

    afterAll(async () => {
        await browser?.close()
        for (const { child } of servers.values()) child.kill("SIGTERM")
    })

    it("closing search returns focus to the trigger that opened it", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(`${servers.get("demo")?.baseUrl}/`, {
            waitUntil: "networkidle",
        })
        try {
            const trigger = page
                .locator("#docs-band button")
                .filter({ hasText: /search/i })
                .first()
            const dialog = page.getByRole("dialog")
            const triggerFocused = () =>
                trigger.evaluate((el) => el === document.activeElement)

            await trigger.focus()
            await page.keyboard.press("Enter")
            await dialog.waitFor()
            // The dialog took focus, so the check below cannot pass vacuously.
            expect(await triggerFocused()).toBe(false)
            await page.keyboard.press("Escape")
            await dialog.waitFor({ state: "detached" })
            expect(await triggerFocused()).toBe(true)

            await page.keyboard.press("Enter")
            await dialog.waitFor()
            await dialog.getByRole("button", { name: "Close Search" }).click()
            await dialog.waitFor({ state: "detached" })
            expect(await triggerFocused()).toBe(true)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("wrapped code lines stop short of the floating copy button at 390px", async () => {
        // QA finding 302: the wrapped lines reserved no room for the action
        // cluster, so whether text cleared the copy button depended on the
        // mono font's glyph widths (Geist Mono ran under it).
        const context = await browser.newContext({
            viewport: { width: 390, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(`${servers.get("code-wrap")?.baseUrl}/`, {
            waitUntil: "networkidle",
        })
        try {
            const figure = page.locator("figure.shiki[data-wrap]").first()
            await figure.waitFor()
            const geometry = await figure.evaluate((node) => {
                const buttons = [
                    ...node.querySelectorAll(":scope > div.absolute button"),
                ].map((button) => button.getBoundingClientRect())
                // Where wrapped text may run to: the line box minus its
                // end padding. Glyph widths decide how close a given line
                // gets, so the reservation itself is what must clear the
                // buttons, whatever the mono font.
                const line = node.querySelector(".line")
                const textEdge = line
                    ? line.getBoundingClientRect().right -
                      Number.parseFloat(getComputedStyle(line).paddingRight)
                    : Number.POSITIVE_INFINITY
                return {
                    buttons: buttons.length,
                    left: Math.min(...buttons.map((rect) => rect.left)),
                    textEdge,
                }
            })
            expect(geometry.buttons).toBeGreaterThan(0)
            expect(geometry.textEdge).toBeLessThanOrEqual(geometry.left - 8)
        } finally {
            await context.close()
        }
    })

    it.each([1440, 390])(
        "the luma footer starts below the article at %ipx",
        async (width) => {
            // The footer sits in fumadocs' docs grid. Placed at a fixed row
            // number, it landed on the main row once fumadocs added a row
            // above it, and the article covered the footer.
            const context = await browser.newContext({
                viewport: { width, height: 900 },
            })
            const page = await context.newPage()
            await page.goto(`${servers.get("luma")?.baseUrl}/`, {
                waitUntil: "networkidle",
            })
            try {
                const footer = page.locator(
                    "footer[data-footer-variant='luma']",
                )
                await footer.getByRole("link", { name: "Changelog" }).waitFor()
                const footerBox = await footer.boundingBox()
                const articleBox = await page.locator("#nd-page").boundingBox()
                expect(footerBox?.height).toBeGreaterThan(0)
                expect(articleBox?.height).toBeGreaterThan(0)
                if (!footerBox || !articleBox) throw new Error("unreachable")
                expect(footerBox.y).toBeGreaterThanOrEqual(
                    articleBox.y + articleBox.height,
                )
            } finally {
                await context.close()
            }
        },
        60_000,
    )

    it("an API page with the example rail ends after its content", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(
            `${servers.get("acme")?.baseUrl}/api-reference/payments/list-payments`,
            {
                waitUntil: "networkidle",
            },
        )
        try {
            const layout = await page.evaluate(() => {
                const pageEl = document.querySelector("#nd-page")
                if (!pageEl) return null
                const contentBottom = Math.max(
                    ...[...pageEl.querySelectorAll("*")].map(
                        (el) => el.getBoundingClientRect().bottom,
                    ),
                )
                return {
                    display: getComputedStyle(pageEl).display,
                    rail: pageEl.querySelector(".api-example-rail") !== null,
                    blankBelowContent:
                        pageEl.getBoundingClientRect().bottom - contentBottom,
                }
            })
            // The two-column rail grid is active, so the measurement covers
            // the implicit rows that once left ~6,000px of blank page.
            expect(layout?.display).toBe("grid")
            expect(layout?.rail).toBe(true)
            expect(layout?.blankBelowContent).toBeLessThan(200)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a gantt in an inactive tab lays out at the column width once shown", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(`${servers.get("gantt-tabs")?.baseUrl}/`, {
            waitUntil: "networkidle",
        })
        try {
            await page.getByRole("tab", { name: "Timeline" }).click()
            const chart = page.locator("#nd-page svg[id^='mermaid']")
            await chart.waitFor()
            // Rendered at the column's width, the SVG is drawn at ~1:1. The
            // viewport-wide layout scaled it to ~0.44 (5px labels).
            await expect
                .poll(
                    () =>
                        chart.evaluate((svg) => {
                            if (!(svg instanceof SVGSVGElement)) return 0
                            const viewBox = svg.viewBox.baseVal.width
                            return viewBox > 0
                                ? svg.getBoundingClientRect().width / viewBox
                                : 0
                        }),
                    { timeout: 10_000 },
                )
                .toBeGreaterThan(0.9)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a callout icon centres on the first line at the mint theme's 20px line height", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        const page = await context.newPage()
        await page.goto(`${servers.get("gantt-tabs")?.baseUrl}/`, {
            waitUntil: "networkidle",
        })
        try {
            const callout = page.locator("#nd-page [data-callout]")
            await callout.waitFor()
            const copy = callout.getByText("The old deployment keeps serving")
            // The mint theme sets callout copy at 14/20, not the default 16/28.
            expect(
                await copy.evaluate(
                    (element) => getComputedStyle(element).lineHeight,
                ),
            ).toBe("20px")
            const icon = await callout
                .locator(":scope > [aria-hidden='true']")
                .boundingBox()
            const line = await copy.boundingBox()
            if (!icon || !line)
                throw new Error("callout parts are not laid out")
            // One line of copy, so its box is the first line. The icon sat
            // 4px low when its offset assumed the 28px line.
            expect(
                Math.abs(icon.y + icon.height / 2 - (line.y + line.height / 2)),
            ).toBeLessThanOrEqual(0.5)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a gantt resized during a pending render redraws only the latest width", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        const page = await context.newPage()
        // Hold the lazy mermaid chunk so every resize below lands while the
        // first render is still pending.
        let release = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let pending = false
        await page.route(/\/assets\/mermaid[-.][^/]*\.js$/, async (route) => {
            pending = true
            await gate
            await route.continue()
        })
        try {
            await page.goto(`${servers.get("gantt-tabs")?.baseUrl}/`, {
                waitUntil: "domcontentloaded",
            })
            // Count diagrams committed into the article (mermaid's scratch
            // render node lives on <body>, outside #nd-page).
            await page.evaluate(() => {
                const counter = { count: 0 }
                Reflect.set(window, "__ganttDraws", counter)
                new MutationObserver((records) => {
                    for (const record of records)
                        for (const node of record.addedNodes)
                            if (
                                node instanceof SVGSVGElement &&
                                node.id.startsWith("mermaid") &&
                                node.closest("#nd-page")
                            )
                                counter.count += 1
                }).observe(document.body, { childList: true, subtree: true })
            })
            await page.getByRole("tab", { name: "Timeline" }).click()
            await page
                .getByRole("tabpanel", { name: "Timeline" })
                .waitFor({ state: "visible" })
            await expect.poll(() => pending).toBe(true)
            const widths = await page.evaluate(async () => {
                const panel = document.querySelector<HTMLElement>(
                    "#nd-page [role='tabpanel'][data-state='active']",
                )
                const seen: number[] = []
                for (const width of [600, 560, 520, 480]) {
                    if (panel) panel.style.width = `${width}px`
                    await new Promise((resolve) =>
                        requestAnimationFrame(() =>
                            requestAnimationFrame(resolve),
                        ),
                    )
                    seen.push(panel?.getBoundingClientRect().width ?? 0)
                }
                return seen
            })
            // The burst really changed the column four times.
            expect(new Set(widths).size).toBe(4)
            release()
            const chart = page.locator("#nd-page svg[id^='mermaid']")
            await chart.waitFor()
            // Let any queued redraws flush before counting.
            await page.waitForTimeout(1500)
            // The render already running when the burst began, then one
            // for the latest width — not one per superseded width.
            expect(
                await page.evaluate(() =>
                    Reflect.get(Reflect.get(window, "__ganttDraws"), "count"),
                ),
            ).toBe(2)
            // And that last render laid the chart out at the final column
            // width (gantt sizes its viewBox from the width it was given).
            const layout = await chart.evaluate((svg) => ({
                viewBox:
                    svg instanceof SVGSVGElement
                        ? svg.viewBox.baseVal.width
                        : 0,
                column: svg.parentElement?.clientWidth ?? -1,
            }))
            expect(layout.viewBox).toBe(layout.column)
        } finally {
            release()
            await context.close()
        }
    }, 60_000)
})
