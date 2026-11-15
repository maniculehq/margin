/** Chromium checks for the MDX <Prompt> block: what a reader sees, what
 * Copy puts on the clipboard, and where the Open in links lead. Run by
 * `bun run test:e2e` against the ingested `prompt` fixture. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { type Browser, type BrowserContext, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { env } from "@/env"

const SERVER_ENTRY = ".output/server/index.mjs"

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

// The fixture's first prompt, as authored: the URL is auto-linked by
// Markdown, and "&" needs encoding in a query string.
const SENTENCE =
    "Publish my docs & keep the links. Fetch https://docs.example.com/quickstart.md and follow it."
const ENCODED =
    "Publish%20my%20docs%20%26%20keep%20the%20links.%20Fetch%20https%3A%2F%2Fdocs.example.com%2Fquickstart.md%20and%20follow%20it."

const LONG_PROMPT = [
    "Review the retry policy for this API client.",
    "List every request that cannot be retried safely.",
    "For each one, say what the client should do instead.",
    "Check the backoff schedule against the rate limits.",
    "Flag any retry that could repeat a payment.",
    "Name the tests that cover each case.",
    "Point out the cases no test covers.",
    "Suggest one change that removes the most risk.",
    "Keep the report under one page.",
    "Finish with the three changes to make first.",
].join("\n\n")

// The fixture's third prompt: a line wrapped in the source (one space on
// the page), a hard break (one newline) and a paragraph break (two).
const BROKEN_LINES =
    "Check every link on this page and list the broken ones.\nGroup them by host.\n\nThen fix the first one."

describe.skipIf(!runnable)("MDX Prompt block", () => {
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
                SITE_SLUG: "prompt",
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
                throw new Error("built server for prompt did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
    }, 120_000)

    afterAll(async () => {
        await browser?.close()
        child?.kill("SIGTERM")
    })

    /** Opens the fixture page and hands back its prompt blocks. */
    async function open(context: BrowserContext) {
        const page = await context.newPage()
        await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
        return {
            page,
            first: page.getByRole("group", { name: "Hand this to your agent" }),
            long: page.getByRole("group", { name: "Review the retry policy" }),
            broken: page.getByRole("group", { name: "Check the links" }),
        }
    }

    it("shows the prompt as text a reader can see", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        try {
            const { first } = await open(context)
            const sentence = first.getByText(SENTENCE, { exact: true })
            await sentence.waitFor({ state: "visible" })
            const box = await sentence.boundingBox()
            // On the page, not parked off-canvas at 1px as it used to be.
            expect(box?.x).toBeGreaterThanOrEqual(0)
            expect(box?.width).toBeGreaterThan(200)
            // The auto-linked URL is prompt text, not a link to follow.
            expect(await sentence.getByRole("link").count()).toBe(0)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("Copy writes the prompt's exact text to the clipboard", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            permissions: ["clipboard-read", "clipboard-write"],
        })
        try {
            const { page, first } = await open(context)
            await first.getByRole("button", { name: "Copy prompt" }).click()
            await first.getByRole("status").getByText("Copied.").waitFor()
            expect(
                await page.evaluate(() => navigator.clipboard.readText()),
            ).toBe(SENTENCE)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("Copy keeps a multi-paragraph prompt's paragraph breaks", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            permissions: ["clipboard-read", "clipboard-write"],
        })
        try {
            const { page, long } = await open(context)
            await long.getByRole("button", { name: "Copy prompt" }).click()
            await long
                .getByRole("button", { name: "Copy prompt" })
                .getByText("Copied")
                .waitFor()
            expect(
                await page.evaluate(() => navigator.clipboard.readText()),
            ).toBe(LONG_PROMPT)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a long prompt scrolls inside the block and takes keyboard focus", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        try {
            const { page, first, long } = await open(context)
            const body = '[data-component-part="prompt-body"]'
            const measure = (el: Element) => ({
                overflows: el.scrollHeight > el.clientHeight,
                top: el.scrollTop,
                focusable: el.getAttribute("tabindex") === "0",
            })
            // The short prompt fits, so it adds no tab stop.
            expect(await first.locator(body).evaluate(measure)).toEqual({
                overflows: false,
                top: 0,
                focusable: false,
            })
            await expect
                .poll(() => long.locator(body).evaluate(measure))
                .toEqual({ overflows: true, top: 0, focusable: true })
            await long.locator(body).focus()
            await page.keyboard.press("End")
            await expect
                .poll(() => long.locator(body).evaluate((el) => el.scrollTop))
                .toBeGreaterThan(0)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a link carries the text Copy writes, line breaks included, before JavaScript runs", async () => {
        const scripted = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            permissions: ["clipboard-read", "clipboard-write"],
        })
        const unscripted = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            javaScriptEnabled: false,
        })
        try {
            const { page, broken } = await open(scripted)
            await broken.getByRole("button", { name: "Copy prompt" }).click()
            await broken.getByRole("status").getByText("Copied.").waitFor()
            expect(
                await page.evaluate(() => navigator.clipboard.readText()),
            ).toBe(BROKEN_LINES)

            // The server's own href: nothing has run to correct it.
            const served = await open(unscripted)
            const href = await served.broken
                .getByRole("link", { name: "Open in ChatGPT (new tab)" })
                .getAttribute("href")
            expect(href).toBe(
                `https://chatgpt.com/?q=${encodeURIComponent(BROKEN_LINES)}`,
            )
        } finally {
            await scripted.close()
            await unscripted.close()
        }
    }, 60_000)

    it("a long prompt prints in full", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        try {
            const { page, long } = await open(context)
            const body = long.locator('[data-component-part="prompt-body"]')
            const hidden = () =>
                body.evaluate((el) => el.scrollHeight - el.clientHeight)
            // On screen the window cuts it, so print has something to lose.
            expect(await hidden()).toBeGreaterThan(0)
            await page.emulateMedia({ media: "print" })
            expect(await hidden()).toBe(0)
        } finally {
            await context.close()
        }
    }, 60_000)

    it("the Claude and ChatGPT links carry the encoded prompt into a new tab", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        try {
            const { first } = await open(context)
            const claude = first.getByRole("link", {
                name: "Open in Claude (new tab)",
            })
            expect(await claude.getAttribute("href")).toBe(
                `https://claude.ai/new?q=${ENCODED}`,
            )
            expect(await claude.getAttribute("target")).toBe("_blank")
            const chatgpt = first.getByRole("link", {
                name: "Open in ChatGPT (new tab)",
            })
            expect(await chatgpt.getAttribute("href")).toBe(
                `https://chatgpt.com/?q=${ENCODED}`,
            )
            expect(await chatgpt.getAttribute("target")).toBe("_blank")
        } finally {
            await context.close()
        }
    }, 60_000)

    it("the app links keep their deep-link schemes, in the authored order", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        try {
            const { first } = await open(context)
            const hrefs = await first
                .getByRole("link")
                .evaluateAll((anchors) =>
                    anchors.map((anchor) => anchor.getAttribute("href")),
                )
            expect(hrefs.slice(0, 3)).toEqual([
                `claude://code/new?q=${ENCODED}`,
                `codex://threads/new?prompt=${ENCODED}`,
                `cursor://anysphere.cursor-deeplink/prompt?text=${ENCODED}`,
            ])
        } finally {
            await context.close()
        }
    }, 60_000)

    it("a refused clipboard write says so in the block and selects the prompt", async () => {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        })
        // The browser's refusal (no permission, insecure origin, a blocked
        // frame) is the external condition; reproduce it at the API.
        await context.addInitScript(() => {
            navigator.clipboard.writeText = () =>
                Promise.reject(new DOMException("denied", "NotAllowedError"))
        })
        try {
            const { page, first } = await open(context)
            const selected = () =>
                page.evaluate(() => getSelection()?.toString() ?? "")
            expect(await first.getByRole("status").textContent()).toBe("")
            expect(await selected()).toBe("")
            await first.getByRole("button", { name: "Copy prompt" }).click()
            await first
                .getByRole("status")
                .getByText("Copy failed.", { exact: false })
                .waitFor({ state: "visible" })
            expect(await selected()).toBe(SENTENCE)
        } finally {
            await context.close()
        }
    }, 60_000)
})
