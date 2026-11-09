/**
 * The custom server entry (src/server.ts). A page render that throws is
 * captured after the request span may already have ended (so the spanEnd
 * flush hook has run): the entry must hand Vercel a drain for that event
 * before the error leaves the handler, or a frozen instance drops it. It
 * also places every request under the site's base path before the handler
 * runs; tests/base-path-e2e.test.ts proves that against the built server,
 * and the cases here cover what the default extension cannot produce.
 */
import { afterEach, expect, it, vi } from "vitest"
import type { SiteResolution } from "@/extensions/types"
import { withBase } from "@/lib/base-path"

const calls = vi.hoisted(() => {
    const events: string[] = []
    const scheduled: unknown[] = []
    const drained = Promise.resolve()
    const seen: { path: string; prefixed: string }[] = []
    return {
        events,
        drained,
        scheduled,
        seen,
        // What the Start handler answers; each case sets its own.
        respond: (_request: Request): Response => {
            throw new Error("render failed")
        },
        basePath: "",
        lookupFails: false,
    }
})

vi.mock("@tanstack/react-start/server", () => ({
    defaultStreamHandler: () => undefined,
    createStartHandler: () => (request: Request) => {
        calls.events.push("render")
        calls.seen.push({
            path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
            prefixed: withBase("/y"),
        })
        return calls.respond(request)
    },
}))
vi.mock("@tanstack/react-start/server-entry", () => ({
    createServerEntry: (entry: unknown) => entry,
}))
vi.mock("#docs-extensions", () => ({
    extensions: {
        resolveSite: async (): Promise<SiteResolution> => {
            if (calls.lookupFails) throw new Error("registry unavailable")
            return {
                site: null,
                versionSelector: "current",
                preview: false,
                canonicalHost: null,
                basePath: calls.basePath,
                publicOrigin: null,
            }
        },
        // Answers the exact path the hosted plugin's proxy check uses.
        requestPolicy: (request: Request) => ({
            hstsPreload: false,
            cacheTag: null,
            preview: false,
            shortCircuit:
                new URL(request.url).pathname === "/_margin/proxy-check"
                    ? Response.json({ site: "acme" })
                    : null,
        }),
        telemetry: {},
    },
}))
vi.mock("@sentry/tanstackstart-react", () => ({
    captureException: () => calls.events.push("capture"),
    wrapFetchWithSentry: (wrapped: unknown) => wrapped,
}))
vi.mock("@vercel/functions", () => ({
    waitUntil: (promise: unknown) => {
        calls.events.push("waitUntil")
        calls.scheduled.push(promise)
    },
}))
vi.mock("../src/instrument-sentry", () => ({
    initSentry: () => {},
    flushTelemetry: () => {
        calls.events.push("flush")
        return calls.drained
    },
}))

afterEach(() => {
    calls.events.length = 0
    calls.scheduled.length = 0
    calls.seen.length = 0
    calls.basePath = ""
    calls.lookupFails = false
    calls.respond = () => {
        throw new Error("render failed")
    }
})

const entry = async () => (await import("../src/server")).default

it("schedules a telemetry drain for a captured page error before rethrowing", async () => {
    const server = await entry()
    await expect(
        server.fetch(new Request("https://docs.test.invalid/guide")),
    ).rejects.toThrow("render failed")
    expect(calls.events).toEqual(["render", "capture", "flush", "waitUntil"])
    expect(calls.scheduled).toEqual([calls.drained])
})

it("places the extension's short-circuits behind the base path", async () => {
    calls.basePath = "/docs"
    calls.respond = () => new Response("handled")
    const server = await entry()
    const outside = await server.fetch(
        new Request("https://docs.test.invalid/_margin/proxy-check"),
    )
    expect(outside.status).toBe(308)
    expect(outside.headers.get("location")).toBe("/docs/_margin/proxy-check")
    await server.fetch(
        new Request("https://docs.test.invalid/docs/_margin/proxy-check"),
    )
    expect(calls.seen).toEqual([
        { path: "/_margin/proxy-check", prefixed: "/docs/y" },
    ])
})

it("serves at the root when the site lookup fails", async () => {
    calls.basePath = "/docs"
    calls.lookupFails = true
    calls.respond = () => new Response("handled")
    const server = await entry()
    const res = await server.fetch(
        new Request("https://docs.test.invalid/guide?tab=1"),
    )
    expect(await res.text()).toBe("handled")
    expect(calls.seen).toEqual([{ path: "/guide?tab=1", prefixed: "/y" }])
})
