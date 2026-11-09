import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extensions } from "#docs-extensions"

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
})

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
