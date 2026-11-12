/**
 * The optional extension hooks a host supplies are what the framework keys
 * on: `clientIp` for the public rate limiter and the visitor's address,
 * `telemetry.visitorKey` for the
 * visitor/session hash, `telemetry.groups` (also when the site lookup
 * failed). The built-in extension supplies none of them; its behaviour is
 * covered by the suites that run against it.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, describe, expect, test, vi } from "vitest"
import { db, schema } from "@/db"
import type { DocsSite, SiteResolution } from "@/extensions/types"
import { agentConfig } from "@/lib/agent.config"
import { recordFeedback } from "@/lib/agent-feedback"
import { siteScope } from "@/lib/base-path"
import { emitEvent } from "@/lib/observability"
import { hasDocsDb } from "./context"

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

describe.skipIf(!hasDocsDb)("clientIp", () => {
    test("keys the feedback limiter on the extension's address", async () => {
        const id = randomUUID()
        await db.insert(schema.docsSite).values({
            id,
            slug: `hooks-${id.slice(0, 8)}`,
            name: "Hooks",
            analyticsMode: "off",
            status: "active",
        })
        const site: DocsSite = {
            id,
            slug: `hooks-${id.slice(0, 8)}`,
            name: "Hooks",
            description: "",
            repo: null,
            analyticsEnabled: true,
            webmcpEnabled: false,
        }
        const submit = (client: string, forwarded: string) =>
            recordFeedback(
                {
                    siteId: site.slug,
                    site,
                    versionId: null,
                    source: { getPage: () => undefined },
                },
                new Request("https://docs.test.invalid/api/agent/feedback", {
                    headers: {
                        "x-proxy-client": client,
                        "x-forwarded-for": forwarded,
                    },
                }),
                { url: "/guide", kind: "outdated", message: "Stale." },
            )
        const rows = () =>
            db
                .select({ id: schema.docsAgentFeedback.id })
                .from(schema.docsAgentFeedback)
                .where(eq(schema.docsAgentFeedback.siteId, id))
        try {
            // A rotating forwarded address would admit every one of these;
            // the hook's one address hits the ten-minute limit of 20.
            for (let n = 0; n < 21; n++)
                await submit("203.0.113.70", `192.0.2.${n}`)
            expect(await rows()).toHaveLength(20)
            await submit("203.0.113.71", "192.0.2.200")
            expect(await rows()).toHaveLength(21)
        } finally {
            await db.delete(schema.docsSite).where(eq(schema.docsSite.id, id))
        }
    })

    // Behind an organization's proxy every caller shares the proxy's address.
    test("admits a shared client address up to the site's limit only", async () => {
        const id = randomUUID()
        const slug = `hooks-${id.slice(0, 8)}`
        await db.insert(schema.docsSite).values({
            id,
            slug,
            name: "Hooks",
            analyticsMode: "off",
            status: "active",
        })
        const site: DocsSite = {
            id,
            slug,
            name: "Hooks",
            description: "",
            repo: null,
            analyticsEnabled: true,
            webmcpEnabled: false,
        }
        try {
            for (let n = 0; n < 21; n++)
                await siteScope().run(
                    {
                        basePath: "",
                        publicOrigin: null,
                        sharedClientAddress: true,
                    },
                    () =>
                        recordFeedback(
                            {
                                siteId: slug,
                                site,
                                versionId: null,
                                source: { getPage: () => undefined },
                            },
                            new Request(
                                "https://docs.test.invalid/api/agent/feedback",
                                {
                                    headers: {
                                        "x-proxy-client": "203.0.113.80",
                                    },
                                },
                            ),
                            {
                                url: "/guide",
                                kind: "outdated",
                                message: "Stale.",
                            },
                        ),
                )

            expect(
                await db
                    .select({ id: schema.docsAgentFeedback.id })
                    .from(schema.docsAgentFeedback)
                    .where(eq(schema.docsAgentFeedback.siteId, id)),
            ).toHaveLength(21)
        } finally {
            await db.delete(schema.docsSite).where(eq(schema.docsSite.id, id))
        }
    })
})
