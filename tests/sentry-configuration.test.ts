import { beforeEach, expect, it, vi } from "vitest"
import { z } from "zod"

const sentryMocks = vi.hoisted(() => {
    const state: {
        options: unknown
        startConfig: unknown
        wrappedKeys: string[]
    } = {
        options: undefined,
        startConfig: undefined,
        wrappedKeys: [],
    }

    return state
})

vi.mock("@sentry/tanstackstart-react/vite", () => ({
    sentryTanstackStart: (options: unknown) => {
        sentryMocks.options = options
        return []
    },
}))

vi.mock("@sentry/tanstackstart-react", () => ({
    sentryGlobalFunctionMiddleware: "sentry-function",
    sentryGlobalRequestMiddleware: "sentry-request",
    wrapMiddlewaresWithSentry: (middlewares: Record<string, unknown>) => {
        const keys = Object.keys(middlewares)
        sentryMocks.wrappedKeys.push(...keys)
        return keys.map((key) => `wrapped:${key}`)
    },
}))

// Only the Start/Sentry seams are replaced: the application modules
// start.ts imports load for real (none of them queries at import time), so
// this test survives renames inside them.
vi.mock("@tanstack/react-start", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tanstack/react-start")>()),
    createStart: (factory: () => unknown) => {
        const config = factory()
        sentryMocks.startConfig = config
        return config
    },
}))

const SENTRY_BUILD_ENV = {
    SENTRY_DSN: "https://public@sentry.example.test/1",
    SENTRY_ORG: "example-org",
    SENTRY_PROJECT: "example-docs",
    SENTRY_AUTH_TOKEN: "sntrys_example",
}

beforeEach(() => {
    sentryMocks.options = undefined
    sentryMocks.startConfig = undefined
    sentryMocks.wrappedKeys.length = 0
    vi.resetModules()
    vi.unstubAllEnvs()
})

it("uploads source maps to the Sentry org and project named in the environment", async () => {
    for (const [key, value] of Object.entries(SENTRY_BUILD_ENV)) {
        vi.stubEnv(key, value)
    }
    await import("../vite.config")

    const options = z
        .object({
            org: z.string(),
            project: z.string(),
            authToken: z.string(),
            autoInstrumentMiddleware: z.boolean(),
        })
        .parse(sentryMocks.options)
    expect(options).toEqual({
        org: "example-org",
        project: "example-docs",
        authToken: "sntrys_example",
        // start.ts wraps every middleware explicitly.
        autoInstrumentMiddleware: false,
    })
})

it.for(Object.keys(SENTRY_BUILD_ENV))(
    "leaves the Sentry Vite plugin out when %s is unset",
    async (missing) => {
        for (const [key, value] of Object.entries(SENTRY_BUILD_ENV)) {
            vi.stubEnv(key, key === missing ? "" : value)
        }
        await import("../vite.config")

        expect(sentryMocks.options).toBeUndefined()
    },
)

it("keeps global Sentry middleware outside the ordered application wrappers", async () => {
    await import("../src/start")

    // Every application middleware goes through Sentry's wrapper, in order,
    // behind the global request middleware. The policy middlewares must stay
    // registered; others may come and go without touching this test.
    expect(sentryMocks.wrappedKeys).toEqual(
        expect.arrayContaining([
            "securityHeadersMiddleware",
            "previewMiddleware",
            "csrfMiddleware",
        ]),
    )
    const startConfig = z
        .object({
            functionMiddleware: z.array(z.string()),
            requestMiddleware: z.array(z.string()),
        })
        .parse(sentryMocks.startConfig)
    expect(startConfig.requestMiddleware).toEqual([
        "sentry-request",
        ...sentryMocks.wrappedKeys.map((key) => `wrapped:${key}`),
    ])
    expect(startConfig.functionMiddleware).toEqual(["sentry-function"])
})
