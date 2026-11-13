/** A site's name, its page titles and its analytics keys are site-controlled
 * text that the page writes into inline scripts: the head's JSON-LD graph
 * and the analytics snippets. Chromium opens a page of the `hostile-names`
 * fixture, where each of them carries a script end tag, and checks that
 * every value reads back as data and none runs as script. Run by
 * `bun run test:e2e`. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fromHtml } from "hast-util-from-html"
import { type Browser, chromium } from "playwright"
import { visit } from "unist-util-visit"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { env } from "@/env"

const SERVER_ENTRY = ".output/server/index.mjs"

const runnable =
    process.env.BROWSER_E2E === "1" &&
    existsSync(SERVER_ENTRY) &&
    Boolean(env.DATABASE_URL)

const config = z
    .object({
        name: z.string(),
        integrations: z.object({
            ga4: z.object({ measurementId: z.string() }),
            intercom: z.object({ appId: z.string() }),
        }),
    })
    .parse(
        JSON.parse(
            readFileSync("tests/fixtures/hostile-names/docs.json", "utf8"),
        ),
    )
const guideTitle = z
    .string()
    .parse(
        readFileSync("tests/fixtures/hostile-names/guide.mdx", "utf8").match(
            /^title: "(.*)"$/m,
        )?.[1],
    )
const jsonLdSchema = z.object({
    "@graph": z.array(
        z.object({ "@type": z.unknown(), name: z.string().optional() }),
    ),
})

describe.skipIf(!runnable)("site-controlled text in inline scripts", () => {
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
                SITE_SLUG: "hostile-names",
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

    it("sends one JSON-LD block that reads the names back", async () => {
        // A spec-conformant HTML parser, as a crawler reads the page.
        const tree = fromHtml(await (await fetch(`${baseUrl}/guide`)).text())
        const blocks: string[] = []
        visit(tree, "element", (element) => {
            if (element.properties.type !== "application/ld+json") return
            blocks.push(
                element.children
                    .map((child) => (child.type === "text" ? child.value : ""))
                    .join(""),
            )
        })
        expect(blocks).toHaveLength(1)
        const graph = jsonLdSchema.parse(JSON.parse(blocks[0] ?? ""))["@graph"]
        expect(graph.find((node) => node["@type"] === "WebSite")?.name).toBe(
            config.name,
        )
        expect(graph.find((node) => node["@type"] === "WebPage")?.name).toBe(
            guideTitle,
        )
    })

    it("runs the analytics snippets with their keys and nothing else", async () => {
        const context = await browser.newContext()
        // The snippets fetch their vendors' scripts; the test needs none.
        await context.route(
            (url) => url.hostname !== "127.0.0.1",
            (route) => route.abort(),
        )
        const page = await context.newPage()
        const dialogs: string[] = []
        page.on("dialog", (dialog) => {
            dialogs.push(dialog.message())
            void dialog.dismiss()
        })
        try {
            await page.goto(`${baseUrl}/guide`, { waitUntil: "load" })
            const seen = await page.evaluate(() => ({
                gtagConfig: Array.from(
                    Reflect.get(window, "dataLayer") ?? [],
                    (call: ArrayLike<unknown>) => Array.from(call),
                ).find((call) => call[0] === "config")?.[1],
                intercomAppId: Reflect.get(
                    Reflect.get(window, "intercomSettings") ?? {},
                    "app_id",
                ),
            }))
            expect(seen.gtagConfig).toBe(config.integrations.ga4.measurementId)
            expect(seen.intercomAppId).toBe(config.integrations.intercom.appId)
            expect(dialogs).toEqual([])
        } finally {
            await context.close()
        }
    }, 60_000)
})
