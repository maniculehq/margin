import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { extensions } from "#docs-extensions"

/**
 * /api/agent/feedback tags who graded: the two UI widgets name themselves,
 * every other caller is an agent. Docs-context resolution is DB-backed and
 * mocked; emitEvent runs for real behind the extension's `onEvent` tap.
 */
const resolveDocsContext = vi.fn()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveDocsContext: (...args: unknown[]) => resolveDocsContext(...args),
}))

const { Route } = await import("@/routes/api/agent.feedback")

const events: Record<string, unknown>[] = []

async function submit(body: Record<string, unknown>): Promise<Response> {
    const handlers = Route.options.server?.handlers
    if (!handlers || typeof handlers === "function")
        throw new Error("/api/agent/feedback declares no handler map")
    const post = handlers.POST
    if (typeof post !== "function")
        throw new Error("/api/agent/feedback declares no POST handler")
    const result = await post({
        request: new Request(
            "https://acme.docs.test.invalid/api/agent/feedback",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    host: "acme.docs.test.invalid",
                },
                body: JSON.stringify(body),
            },
        ),
        params: {},
        pathname: "/api/agent/feedback",
        context: undefined,
        next: vi.fn(),
    })
    if (!(result instanceof Response)) throw new Error("no Response")
    return result
}

beforeEach(() => {
    events.length = 0
    resolveDocsContext.mockReset().mockResolvedValue({
        siteId: "acme",
        site: {
            id: "acme-site-id",
            slug: "acme",
            name: "Acme",
            description: "",
            repo: null,
            analyticsEnabled: true,
            webmcpEnabled: false,
        },
        versionId: null,
        source: { getPage: () => undefined },
    })
    extensions.telemetry.onEvent = (event) => events.push(event)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
    extensions.telemetry.onEvent = undefined
    vi.restoreAllMocks()
})

it.each([
    ["the page widget", { source: "page_widget" }, "page_widget"],
    ["a chat answer", { source: "chat_answer" }, "chat_answer"],
    ["a caller that names no source", {}, "agent"],
])("tags feedback from %s", async (_label, extra, expected) => {
    const response = await submit({
        url: "/guides/install",
        kind: "helpful",
        ...extra,
    })
    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
        type: "agent_feedback_submitted",
        source: expected,
    })
})

it("refuses feedback that names no page", async () => {
    const message = "The install step is stale."
    const accepted = await submit({
        url: "/guides/install",
        kind: "missing",
        message,
    })
    expect(accepted.status).toBe(202)
    const refused = await submit({ url: "", kind: "missing", message })
    expect(refused.status).toBe(400)
})

// Votes carry no message (the "tags feedback from" rows above); a report
// from an agent must say what is wrong, as the MCP tool already requires.
it("refuses an agent report that describes no problem", async () => {
    const accepted = await submit({
        url: "/guides/install",
        kind: "outdated",
        message: "The install step is stale.",
    })
    expect(accepted.status).toBe(202)
    const refused = await submit({ url: "/guides/install", kind: "outdated" })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
        error: "invalid",
        issues: [expect.objectContaining({ path: ["message"] })],
    })
})

it("refuses an agent report whose message is only whitespace", async () => {
    const accepted = await submit({
        url: "/guides/install",
        kind: "outdated",
        message: " The install step is stale. ",
    })
    expect(accepted.status).toBe(202)
    const refused = await submit({
        url: "/guides/install",
        kind: "outdated",
        message: "   ",
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
        error: "invalid",
        issues: [expect.objectContaining({ path: ["message"] })],
    })
})

// A chat panel loaded before the answer id shipped still sends the retired
// Braintrust span id and signature with its thumbs.
it("accepts a chat thumb from a client that predates answer ids", async () => {
    const response = await submit({
        url: "/guides/install",
        kind: "helpful",
        source: "chat_answer",
        braintrustSpanId: "0123456789abcdef",
        braintrustSpanSig: "f".repeat(64),
    })
    expect(response.status).toBe(202)
})

it("refuses an answer id that is not one the chat route mints", async () => {
    const accepted = await submit({
        url: "/guides/install",
        kind: "helpful",
        source: "chat_answer",
        answerId: "5f0c2b8e-4f7a-4d1e-9b3c-2a6d8e1f0a47",
    })
    expect(accepted.status).toBe(202)
    const refused = await submit({
        url: "/guides/install",
        kind: "helpful",
        source: "chat_answer",
        answerId: "answer-1",
    })
    expect(refused.status).toBe(400)
})
