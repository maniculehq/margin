/**
 * The optional extension hooks a host supplies are what the framework keys
 * on: `clientIp` for the visitor's address, `telemetry.visitorKey` for the
 * visitor/session hash, `telemetry.groups` (also when the site lookup
 * failed). The built-in extension supplies none of them; its behaviour is
 * covered by the suites that run against it.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import type { SiteResolution } from "@/extensions/types"
import { agentConfig } from "@/lib/agent.config"
import { emitEvent } from "@/lib/observability"

const state = vi.hoisted(
    (): {
        events: Record<string, unknown>[]
        groupCalls: { resolution: unknown; host: string | null }[]
        captures: Record<string, unknown>[]
        lookupFails: boolean
    } => ({ events: [], groupCalls: [], captures: [], lookupFails: false }),
)

// PostHog is the third-party boundary: record what would have been sent.
vi.mock("posthog-node", () => ({
    PostHog: class {
        async captureImmediate(message: Record<string, unknown>) {
            state.captures.push(message)
        }
        async groupIdentifyImmediate() {}
    },
}))

vi.mock("#docs-extensions", () => ({
    extensions: {
        resolveSite: async (): Promise<SiteResolution> => {
            if (state.lookupFails) throw new Error("registry unavailable")
            return {
                site: null,
                versionSelector: "current",
                preview: false,
                canonicalHost: null,
                basePath: "",
                publicOrigin: null,
            }
        },
        requestPolicy: () => ({
            hstsPreload: false,
            cacheTag: null,
            preview: false,
            shortCircuit: null,
        }),
        clientIp: (request: Request) =>
            request.headers.get("x-proxy-client") ?? undefined,
        telemetry: {
            onEvent: (event: Record<string, unknown>) => {
                state.events.push(event)
            },
            visitorKey: (request: Request) =>
                request.headers.get("x-visitor-scope") ?? "none",
            groups: (resolution: SiteResolution | null, request?: Request) => {
                state.groupCalls.push({
                    resolution,
                    host: request?.headers.get("host") ?? null,
                })
                return { groupType: "site", groupKey: "hooked" }
            },
        },
    },
}))

afterEach(() => {
    state.events.length = 0
    state.groupCalls.length = 0
    state.captures.length = 0
    state.lookupFails = false
    agentConfig.observability.posthogKey = ""
})

/** Emit one event and return the properties the onEvent tap received. */
async function deliver(headers: Record<string, string>) {
    const before = state.events.length
    emitEvent(new Request("https://docs.test.invalid/guide", { headers }), {
        type: "api_request",
    })
    await vi.waitFor(() => expect(state.events.length).toBe(before + 1))
    return state.events[before] ?? {}
}

describe("telemetry hooks", () => {
    test("visitorKey, not the host, decides the visitor's session", async () => {
        const visitor = {
            "x-forwarded-for": "198.51.100.9",
            "user-agent": "ua",
        }
        const first = await deliver({
            ...visitor,
            host: "one.docs.test",
            "x-visitor-scope": "a",
        })
        const otherHost = await deliver({
            ...visitor,
            host: "two.docs.test",
            "x-visitor-scope": "a",
        })
        const otherKey = await deliver({
            ...visitor,
            host: "one.docs.test",
            "x-visitor-scope": "b",
        })
        expect(otherHost.$session_id).toBe(first.$session_id)
        expect(otherKey.$session_id).not.toBe(first.$session_id)
    })

    // Behind a host's proxy the first forwarded-for value is a proxy hop,
    // not the visitor: keying on it gave each hop its own visitor.
    test("clientIp, not the first forwarded hop, identifies the visitor", async () => {
        const visit = (client: string, hop: string) =>
            deliver({
                "x-proxy-client": client,
                "x-forwarded-for": `${hop}, ${client}`,
                "user-agent": "ua",
            })
        const first = await visit("203.0.113.5", "54.0.0.1")
        const otherHop = await visit("203.0.113.5", "54.0.0.2")
        const otherClient = await visit("203.0.113.6", "54.0.0.1")
        expect(otherHop.$session_id).toBe(first.$session_id)
        expect(otherClient.$session_id).not.toBe(first.$session_id)
    })

    test("groups is consulted with a null resolution when the site lookup fails", async () => {
        agentConfig.observability.posthogKey = "phc_test"
        state.lookupFails = true
        await deliver({ host: "outage.docs.test" })
        await vi.waitFor(() => expect(state.captures).toHaveLength(1))
        expect(state.groupCalls).toEqual([
            { resolution: null, host: "outage.docs.test" },
        ])
        expect(state.captures[0]?.groups).toEqual({ site: "hooked" })
    })
})
