import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extensions } from "#docs-extensions"
import type { PageViewVerdict } from "@/extensions/types"

/**
 * /api/agent/event — the reader-interaction channel. Site head resolution
 * is DB-backed and mocked; emitEvent runs for real and is observed through
 * the extension's `onEvent` tap (no PostHog key in tests, so nothing is
 * sent anywhere).
 */
const resolveSiteVersion = vi.fn()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveSiteVersion: (...args: unknown[]) => resolveSiteVersion(...args),
}))

const { handleBrowserEvent } = await import("@/routes/api/agent.event")

const events: Record<string, unknown>[] = []

function post(body: unknown, headers: Record<string, string> = {}) {
    return handleBrowserEvent({
        request: new Request("https://acme.docs.test.invalid/api/agent/event", {
            method: "POST",
            // sendBeacon's string body arrives as text/plain.
            headers: {
                "content-type": "text/plain;charset=UTF-8",
                host: "acme.docs.test.invalid",
                ...headers,
            },
            body: JSON.stringify(body),
        }),
    })
}

const codeCopied = {
    type: "code_copied",
    page_path: "/guides/install",
    language: "bash",
    in_code_group: true,
}

beforeEach(() => {
    events.length = 0
    resolveSiteVersion.mockReset().mockResolvedValue({})
    extensions.telemetry.onEvent = (event) => events.push(event)
})

afterEach(() => {
    extensions.telemetry.onEvent = undefined
    extensions.pageViewCheck = undefined
})

const CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

const pageViewed = {
    type: "docs_page_viewed",
    page_path: "/guides/install",
    view_id: "6f1c2a4e-9b3d-4c8e-a1f2-3b4c5d6e7f80",
    referrer_host: null,
    utm_source: null,
}

/** Installs a page-view check whose verdict is `verify`'s. */
function checkWith(verify: (request: Request) => Promise<PageViewVerdict>) {
    extensions.pageViewCheck = { enabled: () => true, verify }
}

describe("browser event route", () => {
    it("emits an allowlisted event with the page's surface", async () => {
        const response = await post(codeCopied)
        expect(response.status).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).toMatchObject({
            ...codeCopied,
            surface: "docs_html",
        })
    })

    it.each([
        ["an unknown event name", { ...codeCopied, type: "code_pasted" }],
        ["a prop outside the allowlist", { ...codeCopied, query: "secret" }],
        [
            "a page view whose id is not a UUID",
            {
                type: "docs_page_viewed",
                page_path: "/guides/install",
                view_id: "view-1",
                referrer_host: null,
                utm_source: null,
            },
        ],
        [
            "an off-site path",
            {
                type: "docs_search_result_clicked",
                page_path: "/guides/install",
                result_position: 1,
                result_count: 3,
                result_type: "page",
                target_path: "//evil.example/phish",
            },
        ],
    ])("rejects %s without emitting", async (_label, body) => {
        expect((await post(body)).status).toBe(400)
        // A valid event sent afterwards proves the pipeline delivered
        // everything queued before it, so the rejected one would have
        // landed by now had it been emitted.
        expect((await post(codeCopied)).status).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events.map((event) => event.type)).toEqual(["code_copied"])
    })

    it("refuses a body over the byte limit with no declared length", async () => {
        // No content-length: the running byte count is what refuses it.
        const response = await post({
            ...codeCopied,
            language: "x".repeat(5000),
        })
        expect(response.status).toBe(413)
        expect((await post(codeCopied)).status).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events.map((event) => event.type)).toEqual(["code_copied"])
    })

    it("refuses requests the browser marks cross-site", async () => {
        const response = await post(codeCopied, {
            "sec-fetch-site": "cross-site",
        })
        expect(response.status).toBe(403)
        expect((await post(codeCopied)).status).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
    })
})

describe("reported page views", () => {
    it("records a report as the page's own read, with the referrer that sent it", async () => {
        const response = await post(
            {
                ...pageViewed,
                referrer_host: "chatgpt.com",
                utm_source: "chatgpt.com",
            },
            { "user-agent": CHROME_UA },
        )
        expect(response.status).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).toMatchObject({
            type: "docs_page_viewed",
            $pathname: "/guides/install",
            surface: "docs_html",
            $referring_domain: "chatgpt.com",
            ai_referral_platform: "openai",
            ai_referral_detection: "referrer",
        })
    })

    it("records a report the extension's check judged a bot as automation", async () => {
        checkWith(async () => ({
            verdict: "bot",
            properties: { check_detail: "scripted" },
        }))
        expect(
            (await post(pageViewed, { "user-agent": CHROME_UA })).status,
        ).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).toMatchObject({
            traffic_category: "automation",
            traffic_kind: "headless",
            view_verdict: "bot",
            check_detail: "scripted",
        })
    })

    it("keeps a browser's report a person's view when the check passes it", async () => {
        checkWith(async () => ({ verdict: "human" }))
        expect(
            (await post(pageViewed, { "user-agent": CHROME_UA })).status,
        ).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).toMatchObject({
            traffic_category: "human",
            view_verdict: "human",
        })
    })

    it("hands the check the report's body, which the route has already read", async () => {
        const read: unknown[] = []
        checkWith(async (request) => {
            read.push(await request.json())
            return { verdict: "human" }
        })
        expect(
            (await post(pageViewed, { "user-agent": CHROME_UA })).status,
        ).toBe(204)
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(read).toEqual([pageViewed])
        expect(events[0]).toMatchObject({ view_verdict: "human" })
    })

    it.each([
        ["fails", () => Promise.reject(new Error("check unavailable"))],
        ["never answers", () => new Promise<PageViewVerdict>(() => {})],
    ])(
        "records skipped when the check %s, without failing the report",
        async (_label, verify) => {
            checkWith(verify)
            const started = Date.now()
            expect(
                (await post(pageViewed, { "user-agent": CHROME_UA })).status,
            ).toBe(204)
            expect(Date.now() - started).toBeLessThan(2_000)
            await vi.waitFor(() => expect(events).toHaveLength(1))
            expect(events[0]).toMatchObject({
                traffic_category: "human",
                view_verdict: "skipped",
            })
        },
    )
})
