/** Opt-in Chromium acceptance suite for browser-only regressions such as
 * unpainted pages and inaccessible search dialogs. Build first, then run
 * `BROWSER_E2E=1 DATABASE_URL=… BROWSER_DOCS_DIR=/path/to/snapshots bunx vitest run tests/browser-e2e.test.ts`.
 * Each site is ingested with scripts/ingest.ts before its server starts.
 * Manual only, not in CI: it needs complete public documentation snapshots
 * under BROWSER_DOCS_DIR; the small tests/fixtures do not
 * provide these complete public documentation mirrors. */

import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { promisify } from "node:util"
import AxeBuilder from "@axe-core/playwright"
import {
    type Browser,
    type BrowserContext,
    chromium,
    type Page,
} from "playwright"
import { PNG } from "pngjs"
import {
    afterAll,
    beforeAll,
    describe,
    type ExpectStatic,
    expect,
    it,
} from "vitest"
import { env } from "@/env"

const SERVER_ENTRY = ".output/server/index.mjs"

const optedIn = process.env.BROWSER_E2E === "1"
const prerequisites = existsSync(SERVER_ENTRY) && Boolean(env.DATABASE_URL)
const runnable = optedIn && prerequisites

// The advertised browser command must never exit green by
// skipping everything: opting in without a built server or DATABASE_URL is
// a hard failure, not a silent skip. (Without BROWSER_E2E the file stays
// skip-quiet inside plain `bun run test`.)
describe.runIf(optedIn && !prerequisites)("browser harness preflight", () => {
    it("has a built server and DATABASE_URL", () => {
        throw new Error(
            `browser harness prerequisites missing: ${
                existsSync(SERVER_ENTRY)
                    ? ""
                    : `${SERVER_ENTRY} not found (run NITRO_PRESET=node-server NODE_ENV=production bun run build); `
            }${env.DATABASE_URL ? "" : "DATABASE_URL is not set"}`,
        )
    })
})

interface SiteExpectation {
    slug: string
    /**
     * Desktop chrome structure (layout.shared.tsx chromeMode): "band" =
     * top bar + horizontal tab strip; "sidenav" = no band, chrome hosted in
     * the sidebar (the Mintlify maple layout). Drives which selectors the shared
     * assertions use.
     */
    chrome: "band" | "sidenav"
    /** Band flavour: "luma" (Mintlify's luma theme → contrast preset) renders
     * the single-row pill-tab header with icon search/assistant/theme
     * buttons, the docked assistant bar and the main-area footer. */
    chromeVariant?: "luma"
    /** A query with obvious hits in this site's corpus. */
    searchTerm: string
    /** Expected nav tab titles (exact list, authoring order). */
    tabs: string[]
    /** Link-only anchor labels, in order — must render as boxed rows inside
     * the sidebar scroll viewport ABOVE the page tree. */
    anchors: string[] | null
    /** Expected logo anchor href: object-form docs.json logo.href when
     * authored, "/" otherwise. */
    logoHref: string
    /** Band header CTA: the LAST li.navbar-link entry. cssBackground/cssOrder
     * assert the site's INGESTED CSS applies through Mintlify's
     * ul > li.navbar-link > a hooks. */
    bandCta: {
        label: string
        cssBackground?: string
        cssOrder?: string
    } | null
    /** Expected version switcher default label; null = no switcher. */
    versionDefault: string | null
    /** A sidebar folder on the home page that must expand to these children. */
    sidebarProbe: { folder: string; children: string[] } | null
    /** Locale selector expectation: display names it must offer; null = none. */
    locales: string[] | null
    /** A page with 2+ same-label code-tab groups + a non-default label to
     * click — asserts the page-wide sync. */
    codeTabSync: { path: string; label: string } | null
    /**
     * Frontmatter-`openapi:` page: must render the API
     * console client-side, plus any authored prose alongside it.
     * authHeaderSample: substring the generated code sample must carry
     * (generated samples must respect OpenAPI `security`).
     */
    apiConsole: {
        path: string
        prose: string | null
        authHeaderSample?: string
        /** Playground enabled for this site: the endpoint bar's Try-it
         * button MUST exist (a conditional skip would go green on the very
         * regression the test guards). */
        tryIt?: boolean
    } | null
    /** Drawer labels that must each render once. */
    drawerOnce: string[]
    /** A page whose article must be non-blank. */
    articleProbe: { path: string; minChars: number } | null
    /** A page whose step numbers must paint beside the step rail. */
    stepsProbe: string | null
}

/**
 * Public documentation snapshots used as browser acceptance targets.
 * Expectations cover the rendered interface and interactions.
 */
const SITES: SiteExpectation[] = [
    {
        slug: "bun",
        chrome: "band",
        searchTerm: "install",
        anchors: null,
        logoHref: "/",
        // links[].primary — bun's explicit CTA extension.
        bandCta: { label: "Install Bun" },
        tabs: [
            "Runtime",
            "Package Manager",
            "Bundler",
            "Test Runner",
            "Guides",
            "Reference",
            "Blog",
            "Feedback",
        ],
        versionDefault: null,
        sidebarProbe: null,
        locales: null,
        codeTabSync: { path: "/bundler/macros", label: "Output" },
        apiConsole: null,
        drawerOnce: ["Install Bun"],
        articleProbe: null,
        stepsProbe: "/quickstart",
    },
    {
        slug: "firecrawl",
        chrome: "band",
        searchTerm: "scrape",
        anchors: ["Playground", "Blog", "Community", "Changelog"],
        logoHref: "https://firecrawl.dev",
        // No explicit primary — Mintlify's implicit LAST-links-entry rule;
        // Authored CSS tints and reorders it via li.navbar-link.
        bandCta: {
            label: "Sign Up",
            cssBackground: "rgb(255, 77, 0)",
            cssOrder: "99",
        },
        tabs: [
            "Documentation",
            "SDKs",
            "Integrations",
            "API Reference",
            "Build with AI",
        ],
        versionDefault: "v2",
        sidebarProbe: null,
        locales: ["English", "Español"],
        codeTabSync: null,
        // Authored MDX prose (the Interactions section) must coexist with
        // the generated console on the same page.
        apiConsole: {
            path: "/api-reference/endpoint/scrape",
            prose: "Interactions",
            // Firecrawl's spec secures operations with HTTP bearer.
            authHeaderSample: "Bearer <token>",
            tryIt: true,
        },
        drawerOnce: ["Playground", "Blog", "Changelog", "Status"],
        articleProbe: null,
        stepsProbe: null,
    },
    {
        slug: "e2b",
        // maple theme: no desktop band; chrome lives in the sidebar.
        chrome: "sidenav",
        searchTerm: "snapshot",
        anchors: null,
        logoHref: "/",
        bandCta: null,
        tabs: ["Documentation", "SDK Reference", "API reference", "Changelog"],
        versionDefault: null,
        sidebarProbe: null,
        locales: null,
        codeTabSync: {
            path: "/docs/sandbox/git-integration",
            label: "Python",
        },
        apiConsole: null,
        drawerOnce: ["Dashboard"],
        // Regression fixture: the Requirements snippet once threw on the
        // React global, leaving an empty article despite a 200 response.
        articleProbe: {
            path: "/docs/code-interpreting/analyze-data-with-ai/pre-installed-libraries",
            minChars: 100,
        },
        stepsProbe: "/docs/quickstart",
    },
    {
        slug: "mintlify",
        chrome: "band",
        chromeVariant: "luma",
        searchTerm: "navigation",
        anchors: null,
        logoHref: "https://mintlify.com/docs",
        // Explicit navbar.primary button.
        bandCta: { label: "Get started" },
        tabs: ["Documentation", "API reference", "Changelog", "Learn"],
        versionDefault: null,
        sidebarProbe: {
            folder: "CLI",
            children: ["Install the CLI", "Preview locally", "Commands"],
        },
        locales: ["English", "Español", "Français", "中文"],
        codeTabSync: null,
        apiConsole: { path: "/api/update/status", prose: null },
        drawerOnce: ["Talk to us", "Get started"],
        articleProbe: null,
        stepsProbe: null,
    },
]

const DESKTOP = { width: 1280, height: 800 }
/** Inside the 768–1023px window where CSS md (1024px) and fumadocs' 768px
 * sidebar JS disagree — the breakpoint-mismatch reproduction viewport. */
const TABLET = { width: 900, height: 700 }

/**
 * Non-blank paint check: decode the screenshot and require that the single
 * most common color covers <98% of sampled pixels. A fully-styled docs page
 * is way below that; uniform dark-gray or white failures are at 100%.
 */
function dominantColorShare(screenshot: Buffer): number {
    const png = PNG.sync.read(screenshot)
    const counts = new Map<number, number>()
    let sampled = 0
    // Sample every 4th pixel in both axes — plenty for a dominance test.
    for (let y = 0; y < png.height; y += 4) {
        for (let x = 0; x < png.width; x += 4) {
            const idx = (png.width * y + x) << 2
            const key =
                (png.data[idx] << 16) |
                (png.data[idx + 1] << 8) |
                png.data[idx + 2]
            counts.set(key, (counts.get(key) ?? 0) + 1)
            sampled++
        }
    }
    let max = 0
    for (const count of counts.values()) if (count > max) max = count
    return max / sampled
}

async function expectPainted(page: Page, label: string): Promise<void> {
    const share = dominantColorShare(await page.screenshot())
    expect(share, `${label}: viewport is a near-uniform color`).toBeLessThan(
        0.98,
    )
}

/** Console/pageerror tripwire: any hydration-mismatch signal fails the test. */
function armHydrationTripwire(page: Page): () => void {
    const errors: string[] = []
    const pattern =
        /hydrat|minified react error #4(18|23|25)|did not match|server rendered/i
    page.on("console", (message) => {
        if (message.type() === "error" && pattern.test(message.text()))
            errors.push(message.text())
    })
    page.on("pageerror", (error) => {
        if (pattern.test(error.message)) errors.push(error.message)
    })
    return () => {
        expect(errors, "hydration mismatch on page").toEqual([])
    }
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
            AI_GATEWAY_API_KEY: "test-gateway-key",
            NODE_ENV: "production",
        },
        stdio: "ignore",
    })
    const baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30_000
    for (;;) {
        try {
            const res = await fetch(`${baseUrl}/llms.txt`)
            if (res.status === 200) break
        } catch {
            // still booting
        }
        if (Date.now() > deadline) {
            // Reject WITHOUT leaking the child: the caller never receives
            // the handle on the failure path, so afterAll can't kill it.
            child.kill("SIGTERM")
            await new Promise((r) => setTimeout(r, 500))
            if (child.exitCode === null) child.kill("SIGKILL")
            throw new Error(`built server for ${slug} did not become ready`)
        }
        await new Promise((r) => setTimeout(r, 250))
    }
    return { child, baseUrl }
}

describe.skipIf(!runnable)("browser acceptance harness", () => {
    let browser: Browser

    beforeAll(async () => {
        browser = await chromium.launch({ chromiumSandbox: false })
    }, 120_000)

    afterAll(async () => {
        await browser?.close()
    })

    for (const site of SITES) {
        describe(site.slug, () => {
            let child: ChildProcess
            let baseUrl: string
            let ctx: BrowserContext
            // Where the desktop chrome (search pill, theme buttons, locale
            // selector, nav tabs) lives for this site.
            const chromeRoot =
                site.chrome === "sidenav"
                    ? "[data-sidebar-chrome]"
                    : "#docs-band"
            const tabsNav =
                site.chrome === "sidenav"
                    ? "[data-sidebar-chrome] nav[aria-label='Documentation']"
                    : "#docs-band nav[aria-label='Documentation tabs']"
            const luma = site.chromeVariant === "luma"
            // luma's search and assistant controls are icon-only buttons.
            const searchTrigger = luma
                ? `${chromeRoot} button[aria-label='Open search']`
                : `${chromeRoot} button:has-text("Search...")`
            // The visible "Ask a question…" affordance: luma docks a
            // column-wide input bar; other band themes float a pill.
            const askBar = luma
                ? "form[data-assistant-dock]"
                : "[data-assistant-float]"
            // luma's home is a `mode: frame` landing without the dock (as
            // upstream), so its assistant tests run on a default-mode page.
            const askPage = luma ? "/quickstart" : "/"

            beforeAll(async () => {
                await promisify(execFile)(
                    "bun",
                    [
                        "scripts/ingest.ts",
                        "--dir",
                        resolve(
                            process.env.BROWSER_DOCS_DIR ?? "tests/fixtures",
                            site.slug,
                        ),
                        "--slug",
                        site.slug,
                    ],
                    { env: process.env },
                )
                ;({ child, baseUrl } = await bootSiteServer(site.slug))
                ctx = await browser.newContext({ viewport: DESKTOP })
            }, 120_000)

            afterAll(async () => {
                await ctx?.close()
                child?.kill("SIGTERM")
            })

            it("direct load of / paints (desktop)", async () => {
                const page = await ctx.newPage()
                const check = armHydrationTripwire(page)
                await page.goto(`${baseUrl}/`, {
                    waitUntil: "domcontentloaded",
                })
                await expectPainted(page, "/ at domcontentloaded")
                await page.waitForLoadState("networkidle")
                await expectPainted(page, "/ at networkidle")
                check()
                await page.close()
            }, 45_000)

            it("direct load of / paints (900px tablet window)", async () => {
                const tablet = await browser.newContext({ viewport: TABLET })
                const page = await tablet.newPage()
                const check = armHydrationTripwire(page)
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await expectPainted(page, "/ at 900px")
                check()
                await tablet.close()
            }, 45_000)

            it("SSR body paints with JavaScript disabled", async () => {
                const noJs = await browser.newContext({
                    viewport: DESKTOP,
                    javaScriptEnabled: false,
                })
                const page = await noJs.newPage()
                await page.goto(`${baseUrl}/`, {
                    waitUntil: "domcontentloaded",
                })
                await expectPainted(page, "/ without JavaScript")
                await noJs.close()
            }, 45_000)

            it("desktop chrome shows the expected nav tabs", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                const nav = page.locator(tabsNav)
                // Mega-menu tabs (docs.json tab.menu) are dropdown buttons,
                // not links.
                await expect
                    .poll(async () =>
                        (
                            await nav
                                .locator(":scope > a, :scope > button")
                                .allInnerTexts()
                        ).map((text) => text.trim()),
                    )
                    .toEqual(site.tabs)
                await page.close()
            }, 45_000)

            // luma centres its pill tabs and its 648px article between the
            // sidebar and TOC by design — the pinned-axis contract is the
            // default band's.
            if (site.chrome === "band" && !luma) {
                it("band nav left-aligns with the sidebar tree text", async () => {
                    // The header logo, the tab strip, and the
                    // depth-0 sidebar row text share one 36px axis. The 1800px
                    // pass guards the shared centering: the band and the
                    // docs grid must both derive their gutters from the
                    // preset's --fd-layout-width (a layout-scoped var left
                    // the band centering on the 97rem fallback).
                    for (const width of [DESKTOP.width, 1800]) {
                        const context = await browser.newContext({
                            viewport: { width, height: 900 },
                        })
                        const page = await context.newPage()
                        await page.goto(`${baseUrl}/`, {
                            waitUntil: "networkidle",
                        })
                        const logoLeft = await page
                            .locator("#docs-band a")
                            .first()
                            .evaluate((a) => a.getBoundingClientRect().left)
                        // Depth-0 text start = row left + the inline
                        // depth-scaled padding; nested rows are wider, so
                        // the minimum across the tree is the depth-0 axis.
                        const textLeft = await page
                            .locator(
                                "#nd-sidebar [data-radix-scroll-area-viewport]",
                            )
                            .evaluate((viewport) =>
                                Math.min(
                                    ...[
                                        ...viewport.querySelectorAll(
                                            "a[data-active], p",
                                        ),
                                    ]
                                        .slice(0, 20)
                                        .map(
                                            (row) =>
                                                row.getBoundingClientRect()
                                                    .left +
                                                Number.parseFloat(
                                                    getComputedStyle(row)
                                                        .paddingInlineStart,
                                                ),
                                        ),
                                ),
                            )
                        expect(
                            Math.abs(textLeft - logoLeft),
                            `at ${width}px: sidebar text starts at ${textLeft}, band nav at ${logoLeft}`,
                        ).toBeLessThanOrEqual(0.5)
                        // Default pages centre the reading column between
                        // the sidebar and the TOC (app.css --margin-measure).
                        // Only non-default modes may skip; a missing sidebar,
                        // TOC or heading on a default page fails.
                        const article = await page.evaluate(() => {
                            const mode =
                                document
                                    .querySelector("[data-page-mode]")
                                    ?.getAttribute("data-page-mode") ??
                                "missing"
                            if (mode !== "default")
                                return { centred: false, offset: null }
                            const aside = document.querySelector("#nd-sidebar")
                            const toc = document.querySelector("#nd-toc")
                            const column = document.querySelector("#nd-page")
                            if (!aside || !toc || !column)
                                return { centred: true, offset: null }
                            const left =
                                column.getBoundingClientRect().left -
                                aside.getBoundingClientRect().right
                            const right =
                                toc.getBoundingClientRect().left -
                                column.getBoundingClientRect().right
                            return { centred: true, offset: left - right }
                        })
                        if (article.centred) {
                            expect(
                                article.offset,
                                `at ${width}px: default-mode page is missing #nd-sidebar, #nd-toc or #nd-page`,
                            ).not.toBeNull()
                            if (article.offset === null)
                                throw new Error("unreachable")
                            expect(
                                Math.abs(article.offset),
                                `at ${width}px: article column is ${article.offset}px off centre`,
                            ).toBeLessThanOrEqual(1)
                        }
                        await context.close()
                    }
                }, 90_000)
            }

            it("logo links to the configured logo.href", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                // The logo anchor is the first link in the chrome cluster;
                // object-form docs.json logo.href must be consumed (it was
                // parsed but hardcoded to "/").
                await expect
                    .poll(() =>
                        page
                            .locator(`${chromeRoot} a`)
                            .first()
                            .getAttribute("href"),
                    )
                    .toBe(site.logoHref)
                await page.close()
            }, 45_000)

            it("sidebar footer pins chrome only in sidenav mode", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                if (site.chrome === "band") {
                    // Real band sites pin NOTHING at the sidebar bottom —
                    // the header owns the navbar links and repo widget
                    // Duplicating them in the sidebar would render each control twice.
                    await expect
                        .poll(() =>
                            page.locator("#nd-sidebar li.navbar-link").count(),
                        )
                        .toBe(0)
                    expect(
                        await page.locator("#docs-band li.navbar-link").count(),
                    ).toBeGreaterThan(0)
                } else {
                    // The maple theme pins the navbar destinations at the
                    // sidebar bottom, wearing the li.navbar-link hooks.
                    await expect
                        .poll(() =>
                            page
                                .locator("#nd-sidebar li.navbar-link a")
                                .count(),
                        )
                        .toBeGreaterThan(0)
                }
                await page.close()
            }, 45_000)

            it("assistant trigger renders by default", async () => {
                // x-margin.search.mode defaults to "ai" — mirrors keep the
                // Assistant unless the site opts out.
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                const trigger =
                    site.chrome === "sidenav" || luma
                        ? page.locator(
                              `${chromeRoot} button[aria-label='Assistant']`,
                          )
                        : page.locator("#docs-band button", {
                              hasText: "Assistant",
                          })
                await trigger.first().waitFor({ state: "visible" })
                await page.close()
            }, 45_000)

            it("search lists page hits ahead of section hits", async () => {
                // Heading/text hits render with a "#" glyph
                // under a "Page › Heading" crumb, pages first.
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await page.keyboard.press("ControlOrMeta+k")
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input"),
                })
                await dialog.waitFor({ state: "visible" })
                await page.keyboard.type(site.searchTerm)
                const rows = dialog.locator("a[data-active]")
                await expect
                    .poll(async () => rows.count(), { timeout: 10_000 })
                    .toBeGreaterThan(0)
                // No page row follows a section row.
                const kinds = await rows.evaluateAll((anchors) =>
                    anchors.map((a) =>
                        a.querySelector("[aria-hidden='true']")
                            ? "section"
                            : "page",
                    ),
                )
                const firstSection = kinds.indexOf("section")
                if (firstSection !== -1)
                    expect(kinds.slice(firstSection)).not.toContain("page")
                await page.close()
            }, 60_000)

            it("search hands the typed query to the Assistant", async () => {
                // The leading action row closes search and opens the panel
                // prefilled with the query.
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await page.keyboard.press("ControlOrMeta+k")
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input"),
                })
                await dialog.waitFor({ state: "visible" })
                await page.keyboard.type(site.searchTerm)
                const ask = dialog.getByRole("button", {
                    name: /Ask Assistant/,
                })
                await ask.waitFor({ state: "visible" })
                await ask.click()
                await dialog.waitFor({ state: "hidden" })
                const panel = page.locator(
                    "[role='dialog'][aria-label='Assistant']",
                )
                await panel.waitFor({ state: "visible" })
                await expect
                    .poll(() => panel.locator("#nd-ai-input").inputValue())
                    .toBe(site.searchTerm)
                await page.close()
            }, 60_000)

            // luma docks a column-wide input bar instead (its own test above).
            it.skipIf(luma)(
                "floating ask bar sits bottom-centred on desktop",
                async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}${askPage}`, {
                        waitUntil: "networkidle",
                    })
                    const floatBar = page.locator(askBar)
                    await floatBar.waitFor({ state: "visible" })
                    const box = await floatBar.boundingBox()
                    const viewport = page.viewportSize()
                    expect(box).not.toBeNull()
                    if (!box || !viewport) throw new Error("unreachable")
                    expect(
                        Math.abs(box.x + box.width / 2 - viewport.width / 2),
                    ).toBeLessThan(40)
                    expect(box.y + box.height).toBeGreaterThan(
                        viewport.height - 80,
                    )
                    await page.close()
                },
                60_000,
            )

            it("Ctrl+I opens the Assistant and makes the floating ask bar inert", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}${askPage}`, {
                    waitUntil: "networkidle",
                })
                const floatBar = page.locator(askBar)
                await floatBar.waitFor({ state: "visible" })
                await page.keyboard.press("ControlOrMeta+i")
                const panel = page.locator(
                    "[role='dialog'][aria-label='Assistant']",
                )
                await panel.waitFor({ state: "visible" })
                await expect
                    .poll(() =>
                        floatBar.evaluate((node) => node.hasAttribute("inert")),
                    )
                    .toBe(true)
                await page.keyboard.press("Escape")
                await panel.waitFor({ state: "hidden" })
                await page.close()
            }, 60_000)

            it("Ctrl+I is ignored while typing in the search input", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}${askPage}`, {
                    waitUntil: "networkidle",
                })
                await page.locator(askBar).waitFor({
                    state: "visible",
                })
                await page.keyboard.press("ControlOrMeta+k")
                const searchInput = page
                    .locator("div[role='dialog']", {
                        has: page.locator("input"),
                    })
                    .locator("input")
                    .first()
                await searchInput.waitFor({ state: "visible" })
                await searchInput.focus()
                await page.keyboard.press("ControlOrMeta+i")
                // Give a wrongly-wired hotkey time to open the panel.
                await page.waitForTimeout(300)
                expect(
                    await page
                        .locator("[role='dialog'][aria-label='Assistant']")
                        .count(),
                ).toBe(0)
                await page.close()
            }, 60_000)

            it("Assistant seeds suggestions from the page headings", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}${askPage}`, {
                    waitUntil: "networkidle",
                })
                await page.locator(askBar).waitFor({
                    state: "visible",
                })
                const headings = await page.locator("#nd-page h2").count()
                if (headings === 0) {
                    // Nothing to seed from on this site's landing page.
                    await page.close()
                    return
                }
                await page.keyboard.press("ControlOrMeta+i")
                const panel = page.locator(
                    "[role='dialog'][aria-label='Assistant']",
                )
                await panel.waitFor({ state: "visible" })
                await panel
                    .locator("[data-testid='assistant-suggestions'] button")
                    .first()
                    .waitFor({ state: "visible" })
                await page.close()
            }, 60_000)

            it("Assistant maximise toggles the expanded panel", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}${askPage}`, {
                    waitUntil: "networkidle",
                })
                await page.locator(askBar).waitFor({
                    state: "visible",
                })
                await page.keyboard.press("ControlOrMeta+i")
                const panel = page.locator(
                    "[role='dialog'][aria-label='Assistant']",
                )
                await panel.waitFor({ state: "visible" })
                await panel
                    .locator("[data-testid='assistant-maximize']")
                    .click()
                await expect
                    .poll(() => panel.getAttribute("data-expanded"))
                    .toBe("true")
                await page.close()
            }, 60_000)

            it("maximised Assistant widens its grid track instead of overlapping the article", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}${askPage}`, {
                    waitUntil: "networkidle",
                })
                await page.locator(askBar).waitFor({
                    state: "visible",
                })
                await page.keyboard.press("ControlOrMeta+i")
                const panel = page.locator("[data-assistant-panel]")
                await panel.waitFor({ state: "visible" })
                await panel
                    .locator("[data-testid='assistant-maximize']")
                    .click()
                // Geometry, not just the flag: the panel is wider than any
                // preset toc track (244–284px) and the article column ends
                // where the panel begins.
                await expect
                    .poll(async () => (await panel.boundingBox())?.width ?? 0)
                    .toBeGreaterThan(500)
                const panelBox = await panel.boundingBox()
                const articleBox = await page.locator("#nd-page").boundingBox()
                expect(panelBox).not.toBeNull()
                expect(articleBox).not.toBeNull()
                expect(
                    (articleBox?.x ?? 0) + (articleBox?.width ?? 0),
                ).toBeLessThanOrEqual((panelBox?.x ?? 0) + 1)
                await page.close()
            }, 60_000)

            it("Ctrl+I opens the Assistant on a 404 page", async () => {
                const page = await ctx.newPage()
                const response = await page.goto(
                    `${baseUrl}/definitely-not-a-page-xyz`,
                    { waitUntil: "networkidle" },
                )
                if (response?.status() !== 404) {
                    // errors.404.redirect sites go home instead.
                    await page.close()
                    return
                }
                // The provider lives in the root route; the 404 page must
                // mount a panel slot too, or the hotkey opens nothing.
                await page.keyboard.press("ControlOrMeta+i")
                await page
                    .locator("[role='dialog'][aria-label='Assistant']")
                    .waitFor({ state: "visible" })
                await page.close()
            }, 60_000)

            it("unknown paths render a localised 404 with suggestions and noindex", async () => {
                const page = await ctx.newPage()
                const response = await page.goto(
                    `${baseUrl}/definitely-not-a-page-xyz`,
                    { waitUntil: "networkidle" },
                )
                if (
                    response?.status() === 200 &&
                    new URL(page.url()).pathname === "/"
                ) {
                    // errors.404.redirect sites go home instead.
                    await page.close()
                    return
                }
                expect(response?.status()).toBe(404)
                await expect
                    .poll(() => page.title())
                    .toMatch(
                        /Page not found|Page introuvable|Página no encontrada|页面未找到/,
                    )
                expect(
                    await page
                        .locator("meta[name='robots']")
                        .getAttribute("content"),
                ).toContain("noindex")
                const suggestions = page.locator("#nd-page a[data-suggestion]")
                await expect.poll(() => suggestions.count()).toBeGreaterThan(0)
                expect(await suggestions.count()).toBeLessThanOrEqual(3)
                await page.close()
            }, 45_000)

            if (site.chrome === "band") {
                it("band is a <header> landmark", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const band = page.locator("#docs-band")
                    expect(await band.evaluate((node) => node.tagName)).toBe(
                        "HEADER",
                    )
                    await page.close()
                }, 45_000)

                it("band stays pinned to the top after scrolling", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const band = page.locator("#docs-band")
                    await page.mouse.wheel(0, 1200)
                    await page.waitForTimeout(300)
                    const box = await band.boundingBox()
                    expect(box).not.toBeNull()
                    // Still pinned at the top after scrolling (site
                    // body{overflow-x:hidden} used to break the sticky).
                    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
                    expect(box?.y ?? 999).toBeLessThan(80)
                    await page.close()
                }, 45_000)
            }

            it("900px window runs the drawer sidebar, desktop the full one", async () => {
                // fumadocs' drawer/full switch is patched from 768px to
                // 1024px (patches/fumadocs-ui@16.17.7.patch): inside the
                // 768–1023 window the desktop aside must NOT render — the
                // earlier 768px boundary left the header chrome half-hidden.
                const tablet = await browser.newContext({ viewport: TABLET })
                const page = await tablet.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await expect
                    .poll(() => page.locator("#nd-sidebar").count())
                    .toBe(0)
                // The grid must not reserve a column for the absent aside:
                // the presets once pinned --fd-sidebar-width at a hardcoded
                // 768px gate, leaving a blank ~268px strip left of the
                // article through the whole 768-1023 window.
                await expect
                    .poll(() =>
                        page
                            .locator("#nd-docs-layout")
                            .evaluate((layout) =>
                                getComputedStyle(layout).getPropertyValue(
                                    "--fd-sidebar-width",
                                ),
                            ),
                    )
                    .toBe("0px")
                await tablet.close()
                const desktop = await ctx.newPage()
                await desktop.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await desktop
                    .locator("#nd-sidebar")
                    .waitFor({ state: "visible" })
                await desktop.close()
            }, 90_000)

            if (site.anchors) {
                const anchors = site.anchors
                it("link-only anchors render in the sidebar viewport above the tree", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    const rows = page.locator(
                        "#nd-sidebar [data-radix-scroll-area-viewport] a[data-sidebar-anchor]",
                    )
                    await expect
                        .poll(async () =>
                            (await rows.allInnerTexts()).map((text) =>
                                text.trim(),
                            ),
                        )
                        .toEqual(anchors)
                    // Visible on desktop: an anchor hidden in sidebar-header markup
                    // must not satisfy the presence check.
                    await rows.first().waitFor({ state: "visible" })
                    // Above the page tree: the first group label (if any)
                    // sits below the last anchor row.
                    const label = page
                        .locator(
                            "#nd-sidebar [data-radix-scroll-area-viewport] p",
                        )
                        .first()
                    if ((await label.count()) > 0) {
                        const anchorBox = await rows.last().boundingBox()
                        const labelBox = await label.boundingBox()
                        expect(anchorBox).not.toBeNull()
                        expect(labelBox).not.toBeNull()
                        if (anchorBox && labelBox) {
                            expect(anchorBox.y).toBeLessThan(labelBox.y)
                        }
                    }
                    await page.close()
                }, 45_000)
            }

            if (site.bandCta) {
                const cta = site.bandCta
                it("band navbar wears li.navbar-link hooks with the CTA last", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    // Mintlify-compatible markup: ul > li.navbar-link > a —
                    // ingested site CSS targets these hooks.
                    const items = page.locator("#docs-band ul > li.navbar-link")
                    await expect.poll(() => items.count()).toBeGreaterThan(0)
                    const link = items.last().locator("a")
                    await expect
                        .poll(() => link.innerText())
                        .toContain(cta.label)
                    if (cta.cssBackground || cta.cssOrder) {
                        // The site's ingested CSS must land on the CTA —
                        // including the configured fill and flex order.
                        const styles = await link.evaluate((node) => {
                            const item = node.closest("li")
                            return {
                                background:
                                    window.getComputedStyle(node)
                                        .backgroundColor,
                                order: item
                                    ? window.getComputedStyle(item).order
                                    : "",
                            }
                        })
                        if (cta.cssBackground) {
                            expect(styles.background).toBe(cta.cssBackground)
                        }
                        if (cta.cssOrder) {
                            expect(styles.order).toBe(cta.cssOrder)
                        }
                    }
                    await page.close()
                }, 45_000)
            }

            if (site.chrome === "sidenav") {
                it("renders no desktop band; chrome lives in the sidebar", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    expect(await page.locator("#docs-band").count()).toBe(0)
                    const chrome = page.locator("[data-sidebar-chrome]")
                    await chrome.waitFor({ state: "visible" })
                    // The chrome box sits inside the sidebar column.
                    const sidebarBox = await page
                        .locator("#nd-sidebar")
                        .boundingBox()
                    const chromeBox = await chrome.boundingBox()
                    expect(sidebarBox).not.toBeNull()
                    expect(chromeBox).not.toBeNull()
                    if (sidebarBox && chromeBox) {
                        expect(chromeBox.x).toBeGreaterThanOrEqual(
                            sidebarBox.x - 1,
                        )
                        expect(
                            chromeBox.x + chromeBox.width,
                        ).toBeLessThanOrEqual(
                            sidebarBox.x + sidebarBox.width + 1,
                        )
                    }
                    // No band offset: the docs grid starts at the viewport
                    // top (the band used to push content ~96px down and
                    // stretch short pages past 100dvh).
                    const layoutBox = await page
                        .locator("#nd-docs-layout")
                        .boundingBox()
                    expect(layoutBox).not.toBeNull()
                    if (layoutBox) expect(layoutBox.y).toBeLessThan(20)
                    await page.close()
                }, 45_000)
            }

            it("every internal top-tab route direct-loads and paints", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                const hrefs = await page
                    .locator(`${tabsNav} a`)
                    .evaluateAll((anchors) =>
                        anchors
                            .map((a) => a.getAttribute("href") ?? "")
                            .filter(
                                (href) =>
                                    href.startsWith("/") && href.length > 0,
                            ),
                    )
                await page.close()
                expect(hrefs.length).toBeGreaterThan(0)
                for (const href of hrefs) {
                    const tabPage = await ctx.newPage()
                    const check = armHydrationTripwire(tabPage)
                    // "load", not "networkidle": pages embedding external
                    // assets may never go network-idle.
                    const response = await tabPage.goto(`${baseUrl}${href}`, {
                        waitUntil: "load",
                    })
                    expect(response?.status(), `direct load of ${href}`).toBe(
                        200,
                    )
                    await expectPainted(tabPage, `tab route ${href}`)
                    check()
                    // Active tab treatment present on its own route
                    // (underline in the band; row highlight in the sidenav).
                    await expect
                        .poll(() =>
                            tabPage
                                .locator(
                                    `${tabsNav} :is(a, button)[data-active="true"]`,
                                )
                                .count(),
                        )
                        .toBe(1)
                    await tabPage.close()
                }
            }, 180_000)

            it("search opens visibly, returns results, and dismisses", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })

                // Open via the chrome's search control (pill, or luma's
                // icon button).
                await page.locator(searchTrigger).first().click()
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input[placeholder='Search...']"),
                })
                await dialog.waitFor({ state: "visible" })

                // Visibility beyond the a11y tree: on-screen box, painted at
                // its own center, full opacity.
                const box = await dialog.boundingBox()
                expect(box, "dialog has no layout box").not.toBeNull()
                if (!box) throw new Error("unreachable")
                expect(box.width).toBeGreaterThan(300)
                expect(box.y).toBeGreaterThanOrEqual(0)
                expect(box.x).toBeGreaterThanOrEqual(0)
                const centerHitsDialog = await dialog.evaluate(
                    (node, center) => {
                        const hit = document.elementFromPoint(
                            center.x,
                            center.y,
                        )
                        return hit !== null && node.contains(hit)
                    },
                    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                )
                expect(
                    centerHitsDialog,
                    "dialog center is covered by another element",
                ).toBe(true)
                const styles = await dialog.evaluate((node) => {
                    const computed = window.getComputedStyle(node)
                    return {
                        visibility: computed.visibility,
                        display: computed.display,
                    }
                })
                expect(styles.visibility).toBe("visible")
                expect(styles.display).not.toBe("none")
                // Poll past the 200ms entrance animation — a dialog stuck
                // mid-animation never converges.
                await expect
                    .poll(
                        () =>
                            dialog.evaluate((node) =>
                                Number(window.getComputedStyle(node).opacity),
                            ),
                        { timeout: 3_000 },
                    )
                    .toBeGreaterThan(0.9)

                // Query → visible results → Enter navigates. Result rows are
                // real anchors so cmd-click, middle-click, and copy-link work.
                await page.keyboard.type(site.searchTerm)
                const results = dialog.locator("a[data-active]")
                await expect
                    .poll(async () => results.count(), { timeout: 10_000 })
                    .toBeGreaterThan(0)
                // Native link semantics: every row carries a real href.
                const hrefs = await results.evaluateAll((anchors) =>
                    anchors.map((a) => a.getAttribute("href") ?? ""),
                )
                for (const href of hrefs) expect(href).toMatch(/^\//)
                // Shareable state: the query mirrors into ?search= while the
                // dialog is open.
                await expect
                    .poll(() =>
                        page.evaluate(
                            () =>
                                new URLSearchParams(window.location.search).get(
                                    "search",
                                ) ?? "",
                        ),
                    )
                    .toBe(site.searchTerm)
                // Results must be visible on screen, not just in the accessibility
                // tree: a collapsed list must fail this check.
                const firstBox = await results.first().boundingBox()
                expect(
                    firstBox,
                    "first result has no layout box",
                ).not.toBeNull()
                expect(firstBox?.height ?? 0).toBeGreaterThan(10)
                // Enter follows the ACTIVE row — whichever page the dialog
                // highlights for this corpus (the home page is a legitimate
                // hit).
                const activeHref =
                    (await dialog
                        .locator("a[data-active='true'], a[data-active]")
                        .first()
                        .evaluate((a) => a.getAttribute("href"))) ?? ""
                await page.keyboard.press("Enter")
                await page.waitForLoadState("networkidle")
                await dialog.waitFor({ state: "hidden" })
                expect(new URL(page.url()).pathname).toBe(
                    new URL(activeHref, page.url()).pathname,
                )

                // Reopen via hotkey; Escape closes; page stays interactive.
                await page.keyboard.press("ControlOrMeta+k")
                await dialog.waitFor({ state: "visible" })
                await page.keyboard.press("Escape")
                await dialog.waitFor({ state: "hidden" })

                // Reopen; close button dismisses.
                await page.keyboard.press("ControlOrMeta+k")
                await dialog.waitFor({ state: "visible" })
                await dialog
                    .locator("button[aria-label='Close Search']")
                    .click()
                await dialog.waitFor({ state: "hidden" })

                // Page interactive after dismissal: a sidebar link navigates.
                const link = page
                    .locator("#nd-sidebar a[href^='/']:visible")
                    .first()
                await link.click()
                await page.waitForLoadState("networkidle")
                await expectPainted(page, "after search dismissal")
                await page.close()
            }, 90_000)

            it("?search= on load restores the dialog with the query", async () => {
                const page = await ctx.newPage()
                await page.goto(
                    `${baseUrl}/?search=${encodeURIComponent(site.searchTerm)}`,
                    { waitUntil: "networkidle" },
                )
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input[placeholder='Search...']"),
                })
                await dialog.waitFor({ state: "visible", timeout: 10_000 })
                await expect
                    .poll(() =>
                        dialog
                            .locator("input[placeholder='Search...']")
                            .inputValue(),
                    )
                    .toBe(site.searchTerm)
                await page.close()
            }, 45_000)

            it("Back opens search before the lazy dialog has ever mounted", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                await page.evaluate((query) => {
                    window.history.replaceState(
                        window.history.state,
                        "",
                        `?search=${encodeURIComponent(query)}`,
                    )
                    window.history.pushState(window.history.state, "", "/")
                    window.history.back()
                }, site.searchTerm)

                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input[placeholder='Search...']"),
                })
                await dialog.waitFor({ state: "visible", timeout: 10_000 })
                await expect
                    .poll(() =>
                        dialog
                            .locator("input[placeholder='Search...']")
                            .inputValue(),
                    )
                    .toBe(site.searchTerm)
                await page.close()
            }, 45_000)

            it("mobile drawer: Escape closes, search reachable, links unique", async () => {
                const mobile = await browser.newContext({
                    viewport: { width: 390, height: 844 },
                })
                const page = await mobile.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                const trigger = page
                    .locator("button[aria-label='Open Sidebar']")
                    .first()
                await trigger.click()
                // The drawer carries its own search trigger because its overlay
                // covers the header search. It also identifies the drawer.
                const drawer = page.locator("aside", {
                    has: page.locator("button[data-search]"),
                })
                await drawer.waitFor({ state: "visible" })

                // Links must not render duplicate copies in the drawer.
                for (const label of site.drawerOnce) {
                    await expect
                        .poll(() =>
                            drawer
                                .getByRole("link", {
                                    name: label,
                                    exact: true,
                                })
                                .count(),
                        )
                        .toBeLessThanOrEqual(1)
                }

                // In-drawer search opens the dialog.
                await drawer.locator("button[data-search]").first().click()
                const dialog = page.locator("div[role='dialog']", {
                    has: page.locator("input[placeholder='Search...']"),
                })
                await dialog.waitFor({ state: "visible" })
                await page.keyboard.press("Escape")
                await dialog.waitFor({ state: "hidden" })

                // Escape also closes the drawer so it cannot intercept the
                // next header search click.
                await drawer.waitFor({ state: "visible" })
                await page.keyboard.press("Escape")
                await drawer.waitFor({ state: "hidden" })

                // Header search is clickable immediately after.
                await page.locator("button[data-search]").first().click()
                await dialog.waitFor({ state: "visible" })
                await mobile.close()
            }, 90_000)

            if (luma) {
                it("luma: pill tabs sit centred in a single 48px row", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const nav = await page.locator(tabsNav).boundingBox()
                    const band = await page.locator("#docs-band").boundingBox()
                    expect(nav).not.toBeNull()
                    expect(band).not.toBeNull()
                    if (!nav || !band) throw new Error("unreachable")
                    expect(band.height).toBeLessThanOrEqual(49)
                    const navCentre = nav.x + nav.width / 2
                    expect(
                        Math.abs(navCentre - DESKTOP.width / 2),
                    ).toBeLessThan(40)
                    // rounded-full: Chromium reports the clamped radius, not
                    // the authored 9999px.
                    const activeRadius = await page
                        .locator(`${tabsNav} [data-active="true"]`)
                        .first()
                        .evaluate((el) =>
                            Number.parseFloat(
                                getComputedStyle(el).borderRadius,
                            ),
                        )
                    expect(activeRadius).toBeGreaterThan(100)
                    await page.close()
                }, 45_000)

                it("luma: a menu tab opens its dropdown of items", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    await page
                        .locator(`${tabsNav} button[aria-haspopup='menu']`)
                        .first()
                        .click()
                    const items = page.locator(
                        "[role='menu'] [role='menuitem']",
                    )
                    await expect
                        .poll(() => items.count())
                        .toBeGreaterThanOrEqual(2)
                    expect(await items.allInnerTexts()).toEqual(
                        expect.arrayContaining([
                            expect.stringContaining("Guides"),
                        ]),
                    )
                    // Selecting an internal item navigates (SPA) and closes
                    // the menu; the header stays mounted, so an open popover
                    // would otherwise cover the destination page. (The first
                    // item, "Learn", is an external _blank link.)
                    const internal = items.and(page.locator("[href^='/']"))
                    const target = await internal.first().getAttribute("href")
                    await internal.first().click()
                    await expect
                        .poll(() => new URL(page.url()).pathname)
                        .toBe(target)
                    await expect
                        .poll(() => page.locator("[role='menu']").count())
                        .toBe(0)
                    await page.close()
                }, 45_000)

                it("luma: the CTA is a filled primary pill and search/theme are round icon buttons", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const cta = page
                        .locator("#docs-band li.navbar-link a")
                        .last()
                    expect(
                        await cta.evaluate(
                            (el) => getComputedStyle(el).backgroundColor,
                        ),
                    ).toBe("rgb(22, 110, 63)")
                    for (const selector of [
                        searchTrigger,
                        `${chromeRoot} [data-theme-toggle]`,
                    ]) {
                        const box = await page
                            .locator(selector)
                            .first()
                            .boundingBox()
                        expect(box, selector).not.toBeNull()
                        if (!box) throw new Error("unreachable")
                        expect(Math.round(box.width)).toBe(36)
                        expect(Math.round(box.height)).toBe(36)
                    }
                    await page.close()
                }, 45_000)

                it("luma: sidebar group labels capitalise, the active row has no fill, folders match link colour", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const viewport =
                        "#nd-sidebar [data-radix-scroll-area-viewport]"
                    expect(
                        await page
                            .locator(`${viewport} p`)
                            .first()
                            .evaluate(
                                (el) => getComputedStyle(el).textTransform,
                            ),
                    ).toBe("capitalize")
                    expect(
                        await page
                            .locator(`${viewport} a[data-active="true"]`)
                            .first()
                            .evaluate(
                                (el) => getComputedStyle(el).backgroundColor,
                            ),
                    ).toBe("rgba(0, 0, 0, 0)")
                    const linkColor = await page
                        .locator(`${viewport} a[data-active="false"]`)
                        .first()
                        .evaluate((el) => getComputedStyle(el).color)
                    const folderColor = await page
                        .locator(`${viewport} button[aria-expanded]`)
                        .first()
                        .evaluate((el) => getComputedStyle(el).color)
                    expect(folderColor).toBe(linkColor)
                    expect(
                        await page
                            .locator("#nd-sidebar")
                            .evaluate(
                                (el) => getComputedStyle(el).borderRightWidth,
                            ),
                    ).toBe("0px")
                    await page.close()
                }, 45_000)

                it("luma: the docked assistant bar spans the article and sends a question", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/quickstart`, {
                        waitUntil: "networkidle",
                    })
                    const dock = page.locator("form[data-assistant-dock]")
                    await dock.waitFor({ state: "visible" })
                    const box = await dock.boundingBox()
                    const article = await page.locator("#nd-page").boundingBox()
                    expect(box).not.toBeNull()
                    expect(article).not.toBeNull()
                    if (!box || !article) throw new Error("unreachable")
                    expect(box.width).toBeGreaterThan(500)
                    expect(Math.round(box.height)).toBe(58)
                    // Pinned to the viewport bottom while the column scrolls.
                    expect(box.y + box.height).toBeLessThanOrEqual(
                        DESKTOP.height,
                    )
                    await dock.locator("input").fill("What is Mintlify?")
                    await dock.locator("input").press("Enter")
                    const panel = page.locator(
                        "[role='dialog'][aria-label='Assistant']",
                    )
                    await panel.waitFor({ state: "visible" })
                    // The dock SENDS — the question must
                    // appear as a message in the conversation, not sit in
                    // the composer awaiting confirmation.
                    await expect
                        .poll(() =>
                            panel.getByText("What is Mintlify?").count(),
                        )
                        .toBeGreaterThan(0)
                    await expect
                        .poll(() => panel.locator("#nd-ai-input").inputValue())
                        .toBe("")
                    await page.close()
                }, 60_000)

                it("luma: the footer spans the main area, not the article column", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/quickstart`, {
                        waitUntil: "networkidle",
                    })
                    const footer = await page
                        .locator("footer[data-footer-variant='luma']")
                        .boundingBox()
                    const article = await page.locator("#nd-page").boundingBox()
                    expect(footer).not.toBeNull()
                    expect(article).not.toBeNull()
                    if (!footer || !article) throw new Error("unreachable")
                    expect(footer.width).toBeGreaterThan(article.width + 100)
                    await expect
                        .poll(() =>
                            page
                                .locator(
                                    "footer[data-footer-variant='luma'] [data-theme-toggle]",
                                )
                                .count(),
                        )
                        .toBe(1)
                    await page.close()
                }, 45_000)

                it("luma: the frame-mode home spans the main column with a two-column card grid", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                    const article = await page.locator("#nd-page").boundingBox()
                    expect(article).not.toBeNull()
                    if (!article) throw new Error("unreachable")
                    // 1280 − 224px sidebar ≈ the whole main area.
                    expect(article.width).toBeGreaterThan(900)
                    const columns = await page
                        .locator("#nd-page .grid")
                        .first()
                        .evaluate(
                            (el) =>
                                getComputedStyle(el).gridTemplateColumns.split(
                                    " ",
                                ).length,
                        )
                    expect(columns).toBe(2)
                    // Card anchors are not prose links.
                    expect(
                        await page
                            .locator("#nd-page a:has(> h3)")
                            .first()
                            .evaluate(
                                (el) => getComputedStyle(el).textDecorationLine,
                            ),
                    ).toBe("none")
                    await page.close()
                }, 45_000)

                it("luma: API sidebar labels wrap instead of truncating and the endpoint path chips its params", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/api/update/trigger`, {
                        waitUntil: "networkidle",
                    })
                    const label = page.locator(
                        "#nd-sidebar a:has-text('Trigger preview deployment') span.min-w-0",
                    )
                    await label.first().waitFor({ state: "visible" })
                    expect(
                        await label
                            .first()
                            .evaluate((el) => getComputedStyle(el).whiteSpace),
                    ).not.toBe("nowrap")
                    await expect
                        .poll(() =>
                            page
                                .locator(".api-endpoint-bar [data-path-param]")
                                .count(),
                        )
                        .toBeGreaterThan(0)
                    await page.close()
                }, 60_000)

                it("luma: the mobile breadcrumb carries no progress ring", async () => {
                    const mobile = await browser.newContext({
                        viewport: { width: 390, height: 844 },
                    })
                    const page = await mobile.newPage()
                    await page.goto(`${baseUrl}/quickstart`, {
                        waitUntil: "networkidle",
                    })
                    await page
                        .locator("[data-toc-popover-trigger]")
                        .first()
                        .waitFor({ state: "visible" })
                    expect(
                        await page
                            .locator(
                                "[data-toc-popover-trigger] svg[role='progressbar']",
                            )
                            .first()
                            .isVisible(),
                    ).toBe(false)
                    await mobile.close()
                }, 45_000)
            }

            it("one theme toggle cycles html.dark", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                // One control cycles the available theme modes.
                const toggles = page.locator(
                    `${chromeRoot} button[aria-label='Toggle Theme'], ${chromeRoot} [data-theme-toggle]`,
                )
                await expect.poll(() => toggles.count()).toBe(1)
                const before = await page.evaluate(() =>
                    document.documentElement.classList.contains("dark"),
                )
                await toggles.first().click()
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            document.documentElement.classList.contains("dark"),
                        ),
                    )
                    .toBe(!before)
                await toggles.first().click()
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            document.documentElement.classList.contains("dark"),
                        ),
                    )
                    .toBe(before)
                await page.close()
            }, 45_000)

            it("passes axe with no serious or critical violations", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                // Syntax-highlight token colours come from the site's
                // Shiki theme and are not
                // chrome we own; everything else must clear WCAG AA.
                // Authored images are the site's content (mintlify.com's
                // own hero cards ship <img> without alt); the framework's
                // images all carry alt text.
                const results = await new AxeBuilder({ page })
                    .exclude("figure.shiki pre")
                    .exclude("#nd-page img")
                    .analyze()
                const blocking = results.violations.filter(
                    (violation) =>
                        violation.impact === "serious" ||
                        violation.impact === "critical",
                )
                expect(
                    blocking.map((violation) => ({
                        id: violation.id,
                        nodes: violation.nodes.map((node) => node.target),
                    })),
                ).toEqual([])
                await page.close()
            }, 60_000)

            it("renders card titles as non-headings and preloads the default fonts", async () => {
                const page = await ctx.newPage()
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                expect(
                    await page
                        .locator("[data-card] h2, [data-card] h3")
                        .count(),
                ).toBe(0)
                // Sites without their own font stack preload the framework
                // defaults so the swap never shifts layout.
                expect(
                    await page
                        .locator('link[rel="preload"][as="font"]')
                        .count(),
                ).toBeGreaterThanOrEqual(1)
                await page.close()
            }, 45_000)

            it("never calls api.github.com from the browser", async () => {
                const page = await ctx.newPage()
                const thirdParty: string[] = []
                page.on("request", (request) => {
                    if (new URL(request.url()).host === "api.github.com")
                        thirdParty.push(request.url())
                })
                await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" })
                expect(thirdParty).toEqual([])
                await page.close()
            }, 45_000)

            if (site.versionDefault) {
                it(`version switcher defaults to ${site.versionDefault}`, async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    // The version control (dropdown or single-version chip)
                    // lives in the chrome cluster now — beside the band logo
                    // / under the sidenav search row — showing the default
                    // label rather than a stale version or an inert sidebar pill.
                    await page
                        .locator(chromeRoot)
                        .getByText(site.versionDefault ?? "", {
                            exact: true,
                        })
                        .first()
                        .waitFor({ state: "visible" })
                    for (const stale of ["v0"]) {
                        await expect
                            .poll(() =>
                                page
                                    .locator("#nd-sidebar, #docs-band")
                                    .getByText(stale, { exact: true })
                                    .count(),
                            )
                            .toBe(0)
                    }
                    await page.close()
                }, 45_000)
            }

            if (site.sidebarProbe) {
                const probe = site.sidebarProbe
                it(`sidebar folder "${probe.folder}" expands to its children`, async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    // Home must render a sidebar at all.
                    await page
                        .locator("#nd-sidebar")
                        .waitFor({ state: "visible" })
                    // A folder with a landing page (groups[].root) renders
                    // as a link + chevron; plain folders as a button.
                    const folder = page
                        .locator("#nd-sidebar a, #nd-sidebar button", {
                            hasText: probe.folder,
                        })
                        .first()
                    await folder.click()
                    for (const childLabel of probe.children) {
                        await page
                            .locator("#nd-sidebar a", { hasText: childLabel })
                            .first()
                            .waitFor({ state: "visible", timeout: 5_000 })
                    }
                    await page.close()
                }, 45_000)
            }

            if (site.codeTabSync) {
                const sync = site.codeTabSync
                it("same-shaped code-tab groups switch together", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}${sync.path}`, {
                        waitUntil: "load",
                    })
                    // Only tab groups that CARRY the target label — pages
                    // mix differently-shaped groups (bun's installation page
                    // leads with a single-label curl group).
                    const groups = page.locator("[role='tablist']", {
                        has: page.getByRole("tab", { name: sync.label }),
                    })
                    await expect
                        .poll(() => groups.count())
                        .toBeGreaterThanOrEqual(2)
                    await groups
                        .first()
                        .getByRole("tab", { name: sync.label })
                        .click()
                    await expect
                        .poll(() =>
                            groups
                                .nth(1)
                                .getByRole("tab", { name: sync.label })
                                .getAttribute("aria-selected"),
                        )
                        .toBe("true")
                    await page.close()
                }, 45_000)
            }

            if (site.apiConsole) {
                const probe = site.apiConsole
                // Shared per-test loader: the console is client-rendered, so
                // every check first polls for its generated interface (tabs
                // or code samples) before asserting console behavior.
                // Takes the CONCURRENT test's own context expect —
                // expect.poll on the global expect loses the current-test
                // async context when siblings overlap.
                const openConsole = async (expect: ExpectStatic) => {
                    const page = await ctx.newPage()
                    const response = await page.goto(
                        `${baseUrl}${probe.path}`,
                        {
                            waitUntil: "load",
                        },
                    )
                    expect(response?.status()).toBe(200)
                    await expect
                        .poll(
                            () =>
                                page
                                    .locator(
                                        "article [role='tablist'], article pre",
                                    )
                                    .count(),
                            { timeout: 20_000 },
                        )
                        .toBeGreaterThan(0)
                    return page
                }

                it.concurrent("operation navigations share one /api/spec fetch", async ({
                    expect,
                }) => {
                    // The spec is fetched separately from the loader payload: the
                    // console fetches it from /api/spec once per tab, so a
                    // client navigation to a sibling operation reuses it.
                    // max-age=0 means the browser HTTP cache would still
                    // revalidate — only the console's promise cache keeps
                    // this at one request.
                    const specRequests: string[] = []
                    const page = await ctx.newPage()
                    page.on("request", (request) => {
                        if (new URL(request.url()).pathname === "/api/spec")
                            specRequests.push(request.url())
                    })
                    await page.goto(`${baseUrl}${probe.path}`, {
                        waitUntil: "load",
                    })
                    await expect
                        .poll(() => page.locator("article pre").count(), {
                            timeout: 20_000,
                        })
                        .toBeGreaterThan(0)
                    const sibling = await page.evaluate(() => {
                        for (const link of document.querySelectorAll(
                            "#nd-sidebar a",
                        )) {
                            if (!link.querySelector(".api-method-badge"))
                                continue
                            const href = link.getAttribute("href")
                            if (href && href !== location.pathname) return href
                        }
                        return null
                    })
                    expect(sibling).not.toBeNull()
                    await page
                        .locator(`#nd-sidebar a[href="${sibling}"]`)
                        .first()
                        .click()
                    await page.waitForURL(`**${sibling}`)
                    await expect
                        .poll(() => page.locator("article pre").count(), {
                            timeout: 20_000,
                        })
                        .toBeGreaterThan(0)
                    expect(specRequests).toHaveLength(1)
                    await page.close()
                }, 60_000)

                it.concurrent("frontmatter-openapi page renders console + authored prose", async ({
                    expect,
                }) => {
                    const page = await openConsole(expect)
                    if (probe.prose) {
                        await page
                            .locator("article")
                            .getByText(probe.prose)
                            .first()
                            .waitFor({ state: "visible" })
                    }
                    await page.close()
                }, 60_000)

                it.concurrent("endpoint bar shows the method pill and auth-carrying sample", async ({
                    expect,
                }) => {
                    const page = await openConsole(expect)
                    // Mintlify-compatible endpoint bar: method pill +
                    // route under the H1.
                    const bar = page.locator(".api-endpoint-bar")
                    await bar.waitFor({ state: "visible" })
                    await bar
                        .locator(".api-method-badge")
                        .waitFor({ state: "visible" })
                    // Generated samples carry the operation's auth header.
                    if (probe.authHeaderSample) {
                        await expect
                            .poll(
                                () =>
                                    page
                                        .locator("article pre")
                                        .allInnerTexts()
                                        .then((texts) => texts.join("\n")),
                                { timeout: 20_000 },
                            )
                            .toContain(probe.authHeaderSample)
                    }
                    await page.close()
                }, 60_000)

                it.concurrent("sidebar rows show the method badge before the title", async ({
                    expect,
                }) => {
                    const page = await openConsole(expect)
                    // GET/POST pill LEFT of the
                    // page title in API-reference sidebar rows.
                    await expect
                        .poll(() =>
                            page
                                .locator("#nd-sidebar .api-method-badge")
                                .count(),
                        )
                        .toBeGreaterThan(0)
                    const badgeFirst = await page.evaluate(() => {
                        const badge = document.querySelector(
                            "#nd-sidebar .api-method-badge",
                        )
                        const title = badge?.nextElementSibling
                        if (!badge || !title) return null
                        return (
                            badge.getBoundingClientRect().left <
                            title.getBoundingClientRect().left
                        )
                    })
                    expect(badgeFirst).toBe(true)
                    await page.close()
                }, 60_000)

                it.concurrent("Try-it opens the playground modal and keeps form state across reopen", async ({
                    expect,
                }) => {
                    const page = await openConsole(expect)
                    // Attribute locator, not a role query: the open modal
                    // aria-hides the page behind it, bar button included.
                    const tryIt = page.locator(
                        ".api-endpoint-bar [data-endpoint-try-it]",
                    )
                    if (probe.tryIt) {
                        // Playground sites MUST render the button — a
                        // conditional skip would pass on the exact
                        // regression this test guards.
                        await tryIt.waitFor({ state: "visible" })
                    }
                    if ((await tryIt.count()) > 0) {
                        const dialog = page.getByRole("dialog")
                        await tryIt.click()
                        await dialog.waitFor({ state: "visible" })
                        expect(await tryIt.getAttribute("aria-expanded")).toBe(
                            "true",
                        )
                        const field = dialog
                            .locator("input[type='text'], input:not([type])")
                            .first()
                        if ((await field.count()) > 0) {
                            await field.fill("persistence-probe")
                            // Closing hides WITHOUT unmounting — the value
                            // must survive a close/reopen cycle.
                            await page.keyboard.press("Escape")
                            await dialog.waitFor({ state: "hidden" })
                            expect(
                                await tryIt.getAttribute("aria-expanded"),
                            ).toBe("false")
                            await tryIt.click()
                            await expect
                                .poll(() => field.inputValue())
                                .toBe("persistence-probe")
                        }
                    }
                    await page.close()
                }, 90_000)
            }

            if (site.articleProbe) {
                const probe = site.articleProbe
                it("previously-blank page renders its article", async () => {
                    const page = await ctx.newPage()
                    const response = await page.goto(
                        `${baseUrl}${probe.path}`,
                        {
                            waitUntil: "load",
                        },
                    )
                    expect(response?.status()).toBe(200)
                    await page.locator("h1").first().waitFor({
                        state: "visible",
                    })
                    await expect
                        .poll(
                            () =>
                                page
                                    .locator("article")
                                    .first()
                                    .innerText()
                                    .then((text) => text.trim().length),
                            { timeout: 20_000 },
                        )
                        .toBeGreaterThan(probe.minChars)
                    await page.close()
                }, 60_000)
            }

            if (site.stepsProbe) {
                const path = site.stepsProbe
                it("step numbers paint beside the step rail", async () => {
                    // Assert the rendered result, not merely the emitted counter
                    // CSS: the ::before number circle must paint in the
                    // gutter left of the first step.
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}${path}`, {
                        waitUntil: "networkidle",
                    })
                    const step = page.locator(".fd-step").first()
                    await step.waitFor({ state: "visible" })
                    const box = await step.boundingBox()
                    expect(box).not.toBeNull()
                    if (!box) throw new Error("unreachable")
                    const gutter = await page.screenshot({
                        clip: {
                            x: Math.max(0, box.x - 36),
                            y: box.y - 4,
                            width: 40,
                            height: 40,
                        },
                    })
                    expect(
                        dominantColorShare(gutter),
                        "step-number gutter is a uniform color (no painted counter)",
                    ).toBeLessThan(0.98)
                    await page.close()
                }, 45_000)
            }

            if (site.slug === "mintlify") {
                it("theme gallery renders its nine theme cards", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/customize/themes`, {
                        waitUntil: "load",
                    })
                    // Page-local <ThemeCard/> definitions must compile into images
                    // rather than an empty shell.
                    await expect
                        .poll(() => page.locator("article img").count(), {
                            timeout: 20_000,
                        })
                        .toBeGreaterThanOrEqual(9)
                    await page.close()
                }, 60_000)
            }

            if (site.slug === "e2b") {
                it("changelog entries show their category chips", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/docs/changelog`, {
                        waitUntil: "load",
                    })
                    // Update tags must retain their category chips and release labels.
                    await page
                        .locator("article")
                        .getByText("SDK", { exact: true })
                        .first()
                        .waitFor({ state: "visible", timeout: 20_000 })
                    await page.close()
                }, 60_000)
            }

            if (site.locales) {
                const locales = site.locales
                it("language selector offers the declared locales", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    const trigger = page.locator(
                        `${chromeRoot} button[aria-label^='Language']`,
                    )
                    await trigger.waitFor({ state: "visible" })
                    await trigger.click()
                    for (const locale of locales) {
                        await page
                            .getByRole("menuitem", { name: locale })
                            .waitFor({ state: "visible" })
                    }
                    await page.close()
                }, 45_000)
            } else {
                it("no language selector for a single-locale site", async () => {
                    const page = await ctx.newPage()
                    await page.goto(`${baseUrl}/`, {
                        waitUntil: "networkidle",
                    })
                    await expect
                        .poll(() =>
                            page
                                .locator(
                                    `${chromeRoot} button[aria-label^='Language']`,
                                )
                                .count(),
                        )
                        .toBe(0)
                    await page.close()
                }, 45_000)
            }
        })
    }
})
