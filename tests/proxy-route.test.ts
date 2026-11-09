import type { LookupAddress, LookupAllOptions } from "node:dns"
import { createServer, type IncomingHttpHeaders } from "node:http"
import * as Sentry from "@sentry/tanstackstart-react"
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest"

/**
 * /api/proxy relays the API playground to the tenant's own servers, so the
 * tenant chooses where it connects and the visitor's request is what it
 * forwards. Name resolution is the external boundary: `api.acme.test`
 * resolves to loopback, where a real HTTP server stands in for the tenant's
 * API. The site and its spec are DB-backed and mocked, as in spec-route.
 * Sentry runs for real (its transport points at a closed port), because its
 * fetch instrumentation adds headers below the route's own.
 */
vi.hoisted(() => {
    vi.stubEnv("SENTRY_DSN", "http://public@127.0.0.1:9/1")
})

vi.mock("node:dns", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:dns")>()
    return {
        ...actual,
        lookup: (
            hostname: string,
            options: LookupAllOptions,
            callback: (
                error: NodeJS.ErrnoException | null,
                addresses: LookupAddress[],
            ) => void,
        ) =>
            hostname === "api.acme.test"
                ? callback(null, [{ address: "127.0.0.1", family: 4 }])
                : actual.lookup(hostname, options, callback),
    }
})

// The real address policy unless a case admits loopback as the tenant's
// public API (loopback is the only address a test server can listen on).
const publicAddress = vi.fn<(address: string) => boolean>()
vi.mock("@/ingest/remote-assets", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/ingest/remote-assets")>()),
    isPublicUnicastAddress: (address: string) => publicAddress(address),
}))
const { isPublicUnicastAddress } = await vi.importActual<
    typeof import("@/ingest/remote-assets")
>("@/ingest/remote-assets")

const resolveSiteVersion = vi.fn()
const openapiDocumentIndex = vi.fn()
const openapiDocument = vi.fn()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveSiteVersion: (...args: unknown[]) => resolveSiteVersion(...args),
    openapiDocumentIndex: (...args: unknown[]) => openapiDocumentIndex(...args),
    openapiDocument: (...args: unknown[]) => openapiDocument(...args),
}))

type Received = {
    method: string | undefined
    url: string | undefined
    headers: IncomingHttpHeaders
    body: string
}
let received: Received[] = []
let closers: (() => Promise<void>)[] = []
let origin = ""
/** Where the upstream's /cross redirects: another origin the spec lists. */
let crossTarget = ""

/** A tenant API on loopback that records each request. A fresh port per
 * server: a pooled connection is never re-checked, so a shared origin would
 * let one case's admitted socket serve the next. */
async function listen(): Promise<string> {
    const server = createServer(async (req, res) => {
        let body = ""
        for await (const chunk of req) body += chunk
        received.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
        })
        const redirects: Record<string, [number, string]> = {
            "/redirect": [302, "http://evil.example/collect"],
            "/move": [301, "/moved"],
            "/cross": [302, crossTarget],
        }
        const redirect = redirects[req.url ?? ""]
        if (redirect) {
            res.writeHead(redirect[0], { location: redirect[1] })
            res.end()
            return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
        throw new Error("upstream has no port")
    closers.push(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            }),
    )
    return `http://api.acme.test:${address.port}`
}

beforeEach(async () => {
    received = []
    publicAddress.mockReset().mockImplementation(isPublicUnicastAddress)
    origin = await listen()
    resolveSiteVersion.mockReset().mockResolvedValue({
        site: { id: "acme" },
        versionId: "v-1",
        config: null,
    })
    openapiDocumentIndex.mockReset().mockResolvedValue([
        {
            docId: "payments",
            sourcePath: "openapi.json",
            servers: [origin],
        },
    ])
    openapiDocument.mockReset().mockResolvedValue({
        openapi: "3.1.0",
        info: { title: "Payments", version: "1" },
        servers: [{ url: origin }],
        components: {
            securitySchemes: {
                apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
            },
        },
        paths: {
            "/payments": {
                get: {
                    parameters: [
                        { name: "X-Request-Id", in: "header" },
                        // A spec can name platform headers; they still stay.
                        { name: "x-vercel-oidc-token", in: "header" },
                        { name: "cf-connecting-ip", in: "header" },
                        { name: "x-forwarded-for", in: "header" },
                        { name: "x-real-ip", in: "header" },
                    ],
                },
            },
        },
    })
})

afterEach(async () => {
    await Promise.all(closers.map((close) => close()))
    closers = []
})
afterAll(async () => {
    await Sentry.close(0)
    vi.unstubAllEnvs()
})

// Sentry first, as the server entry does; then load the real route during
// module setup, so a cold import cannot time out a request assertion.
const { initSentry } = await import("@/instrument-sentry")
initSentry()
const { Route } = await import("@/routes/api/proxy")

async function proxy(
    target: string,
    {
        method = "GET",
        headers = {},
        body,
        cookie = "session=playground",
    }: {
        method?: "GET" | "PUT"
        headers?: Record<string, string>
        body?: string
        cookie?: string
    } = {},
) {
    const handlers = Route.options.server?.handlers
    if (!handlers || typeof handlers === "function")
        throw new Error("/api/proxy declares no handler map")
    const handler = handlers[method]
    if (typeof handler !== "function")
        throw new Error(`/api/proxy has no ${method}`)
    const response = await handler({
        request: new Request(
            `https://acme.docs.test/api/proxy?url=${encodeURIComponent(target)}&cookie=${encodeURIComponent(cookie)}`,
            { method, headers, body },
        ),
        params: {},
        pathname: "/api/proxy",
        context: undefined,
        next: vi.fn(),
    })
    if (!(response instanceof Response)) throw new Error("no Response")
    return response
}

/** Loopback stands in for the tenant's public API. */
const admitLoopback = () =>
    publicAddress.mockImplementation((address) => address === "127.0.0.1")

describe("API playground proxy", () => {
    it("forwards only the headers the playground sends and the spec declares", async () => {
        admitLoopback()
        expect(Sentry.getClient()).toBeDefined()
        const response = await proxy(`${origin}/payments`, {
            headers: {
                authorization: "Bearer reader-token",
                "x-api-key": "reader-key",
                "x-request-id": "req-1",
                "user-agent": "reader-browser",
                "x-vercel-oidc-token": "deployment-oidc-token",
                "cf-connecting-ip": "203.0.113.9",
                "x-forwarded-for": "203.0.113.9",
                "x-real-ip": "203.0.113.9",
                cookie: "docs_session=visitor",
                referer: "https://acme.docs.test/api-reference",
                "x-undeclared": "nope",
            },
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(received).toHaveLength(1)
        const headers = received[0]?.headers
        expect(headers).toMatchObject({
            authorization: "Bearer reader-token",
            "x-api-key": "reader-key",
            "x-request-id": "req-1",
            "user-agent": "reader-browser",
            cookie: "session=playground",
        })
        for (const name of [
            "x-vercel-oidc-token",
            "cf-connecting-ip",
            "x-forwarded-for",
            "x-real-ip",
            "referer",
            "x-undeclared",
            "sentry-trace",
            "baggage",
        ])
            expect(headers).not.toHaveProperty(name)
    })

    it("refuses a target whose name resolves to a private address", async () => {
        const response = await proxy(`${origin}/payments`)

        expect(response.status).toBe(502)
        expect(await response.json()).toContain(
            "api.acme.test resolves to a non-public address",
        )
        expect(received).toHaveLength(0)
    })

    it("refuses an IP-literal target outside public unicast", async () => {
        // NAT64-mapped loopback: past the origin string check, so only the
        // address policy stands between it and a connection attempt.
        const nat64 = "http://[64:ff9b::7f00:1]"
        openapiDocumentIndex.mockResolvedValue([
            { docId: "payments", sourcePath: "openapi.json", servers: [nat64] },
        ])

        const response = await proxy(`${nat64}/payments`)

        expect(response.status).toBe(400)
        expect(await response.json()).toContain("not public")
    })

    it("refuses to follow a redirect off the spec's origins", async () => {
        admitLoopback()

        const response = await proxy(`${origin}/redirect`)

        // Positive control: the allowed origin was reached and redirected.
        expect(received).toHaveLength(1)
        expect(response.status).toBe(400)
        expect(await response.json()).toContain(
            "redirect origin is not allowed",
        )
    })

    it("keeps a redirected write a write", async () => {
        admitLoopback()

        const response = await proxy(`${origin}/move`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: '{"amount":5}',
        })

        expect(response.status).toBe(200)
        expect(received.map(({ method, url }) => `${method} ${url}`)).toEqual([
            "PUT /move",
            "PUT /moved",
        ])
        expect(received[1]?.body).toBe('{"amount":5}')
    })

    it("drops credentials on a redirect to another origin the spec lists", async () => {
        admitLoopback()
        const second = await listen()
        crossTarget = `${second}/landing`
        openapiDocumentIndex.mockResolvedValue([
            {
                docId: "payments",
                sourcePath: "openapi.json",
                servers: [origin, second],
            },
        ])

        const response = await proxy(`${origin}/cross`, {
            headers: {
                authorization: "Bearer reader-token",
                "x-api-key": "reader-key",
                "user-agent": "reader-browser",
            },
        })

        expect(response.status).toBe(200)
        expect(received.map(({ url }) => url)).toEqual(["/cross", "/landing"])
        // Positive control: the first origin received the credentials.
        expect(received[0]?.headers).toMatchObject({
            authorization: "Bearer reader-token",
            "x-api-key": "reader-key",
            cookie: "session=playground",
        })
        const landed = received[1]?.headers
        expect(landed).toMatchObject({ "user-agent": "reader-browser" })
        for (const name of ["authorization", "x-api-key", "cookie"])
            expect(landed).not.toHaveProperty(name)
    })

    // Regression: an unencodable cookie threw out of the handler (a 500 and
    // a Sentry event) instead of refusing the request.
    it("refuses a cookie parameter that is not a header value", async () => {
        const response = await proxy(`${origin}/payments`, {
            cookie: "a=1\r\nX: y",
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toContain("cookie parameter")
        expect(received).toHaveLength(0)
    })
})
