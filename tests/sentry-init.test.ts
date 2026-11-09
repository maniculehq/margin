import * as Sentry from "@sentry/tanstackstart-react"
import { afterEach, expect, it, vi } from "vitest"

// The real SDK, with only the parsed environment replaced: the zero-env e2e
// sees what leaves the process, this sees whether a client exists at all.
const settings = vi.hoisted(() => {
    const env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string } = {}
    return { env, deploymentEnvironment: "test" }
})

vi.mock("@/env", () => ({
    get deploymentEnvironment() {
        return settings.deploymentEnvironment
    },
    env: settings.env,
}))

const DSN = "http://public@127.0.0.1:9/1"

afterEach(async () => {
    await Sentry.close(0)
    // close() leaves the client on the scope; the next test starts clean.
    Sentry.getCurrentScope().setClient(undefined)
    settings.env.SENTRY_DSN = undefined
    settings.env.SENTRY_ENVIRONMENT = undefined
    settings.deploymentEnvironment = "test"
})

/** A fresh instrument-sentry module initialized against `settings`. */
async function init() {
    vi.resetModules()
    const module = await import("../src/instrument-sentry")
    module.initSentry()
}

/** What the initialized client's beforeSend does with `thrown`. */
function beforeSend(thrown: unknown) {
    const hook = Sentry.getClient()?.getOptions().beforeSend
    if (!hook) throw new Error("no Sentry client with a beforeSend")
    return hook({ type: undefined }, { originalException: thrown })
}

it("creates a Sentry client only when SENTRY_DSN is set", async () => {
    await init()
    expect(Sentry.getClient()).toBeUndefined()

    // Positive control: the same module with a DSN does initialize, so the
    // assertion above fails if the no-DSN guard is removed.
    settings.env.SENTRY_DSN = DSN
    await init()
    expect(Sentry.getClient()).toBeDefined()
})

it("keeps local development out of Sentry unless SENTRY_ENVIRONMENT names it", async () => {
    settings.env.SENTRY_DSN = DSN
    settings.deploymentEnvironment = "development"
    await init()
    expect(Sentry.getClient()).toBeUndefined()

    settings.env.SENTRY_ENVIRONMENT = "development"
    await init()
    expect(Sentry.getClient()?.getOptions().environment).toBe("development")
})

it("drops a client that disconnected mid-request", async () => {
    settings.env.SENTRY_DSN = DSN
    await init()

    const kept = new Error("aborted")
    expect(beforeSend(kept)).not.toBeNull()
    expect(
        beforeSend(Object.assign(new Error("aborted"), { code: "ECONNRESET" })),
    ).toBeNull()
})

it("drops a preview database login a deleted Neon branch rejects", async () => {
    settings.env.SENTRY_DSN = DSN
    settings.deploymentEnvironment = "preview"
    await init()

    const failedQuery = (code: string) =>
        new Error("Failed query: select 1", {
            cause: Object.assign(
                new Error(
                    "password authentication failed for user 'neondb_owner'",
                ),
                { code },
            ),
        })
    expect(beforeSend(failedQuery("28P02"))).not.toBeNull()
    expect(beforeSend(failedQuery("28P01"))).toBeNull()
})

it("reports a production database login a custom SENTRY_ENVIRONMENT labels", async () => {
    settings.env.SENTRY_DSN = DSN
    settings.env.SENTRY_ENVIRONMENT = "prod"
    settings.deploymentEnvironment = "production"
    await init()

    expect(Sentry.getClient()?.getOptions().environment).toBe("prod")
    expect(
        beforeSend(
            new Error("Failed query: select 1", {
                cause: Object.assign(
                    new Error(
                        "password authentication failed for user 'neondb_owner'",
                    ),
                    { code: "28P01" },
                ),
            }),
        ),
    ).not.toBeNull()
})

it("never traces Vercel's health check but keeps real requests", async () => {
    settings.env.SENTRY_DSN = DSN
    settings.deploymentEnvironment = "production"
    await init()

    const sampler = Sentry.getClient()?.getOptions().tracesSampler
    if (!sampler) throw new Error("no Sentry client with a tracesSampler")
    const rate = (path: string) =>
        sampler({
            name: "GET",
            attributes: { "url.path": path },
            inheritOrSampleWith: (fallback) => fallback,
        })

    // Positive controls first: an ordinary page, and the path's near
    // neighbours, still sample at the production rate.
    expect(rate("/docs/quickstart")).toBe(0.1)
    expect(rate("/_vercel/insights")).toBe(0.1)
    expect(rate("/_vercel/ping")).toBe(0)
})
