import { lookup } from "node:dns"
import { isIP } from "node:net"
import { createFileRoute } from "@tanstack/react-router"
import { LRUCache } from "lru-cache"
import { isPublicUnicastAddress } from "@/ingest/remote-assets"
import { emitEvent } from "@/lib/observability"
import {
    openapiDocument,
    openapiDocumentIndex,
    resolveSiteVersion,
} from "@/lib/source"
import { isPublicDocsApiOrigin, resolveDocsApiConfig } from "@/types/docs"

/** Headers the playground sends for any operation; the rest must be declared
 * by the served spec (header parameters and apiKey schemes). */
const PLAYGROUND_HEADERS = [
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "user-agent",
]
/** The playground headers that carry no credential, kept across a redirect
 * to another origin (Authorization, cookies and API keys are dropped). */
const PORTABLE_HEADERS = new Set([
    "accept",
    "accept-language",
    "content-type",
    "user-agent",
])
/** Never forwarded, even when a spec declares the name: the platform's own
 * request headers (on Vercel, x-vercel-oidc-token authenticates this
 * deployment), visitor addresses, the docs origin's cookies, and the
 * connection's own (hop-by-hop) headers. */
const NEVER_FORWARDED =
    /^(?:x-vercel-|cf-|x-forwarded-|proxy-|x-real-ip$|forwarded$|true-client-ip$|cookie$|host$|connection$|keep-alive$|upgrade$|expect$|te$|trailer$|content-length$|transfer-encoding$)/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
/** Above the playground's own 10 s client timeout. */
const UPSTREAM_TIMEOUT_MS = 15_000

/** Header names each served version's specs declare, so a request does not
 * walk every bundled spec again. */
const declaredHeaders = new LRUCache<string, Set<string>>({ max: 64 })

/** Connects only to addresses that resolve public, checked inside the
 * socket's own lookup so the address checked is the address connected to —
 * a rebinding or private-resolving name fails here, redirects included. */
let publicOnlyAgent: import("undici").Agent | undefined

/** The playground proxy only allows origins from this site's served spec and
 * only reaches public addresses; it forwards only the headers the spec
 * declares. Sites without an enabled spec receive 404. */
async function handleProxy({ request }: { request: Request }) {
    const ctx = await resolveSiteVersion(request)
    // docs.json api.playground: only an interactive playground with the proxy
    // enabled has a proxy surface at all (display "simple"/"none"/"auth" and
    // proxy:false sites fetch nothing through the docs origin).
    const apiConfig = resolveDocsApiConfig(ctx.config?.api)
    if (
        apiConfig.playground.display !== "interactive" ||
        !apiConfig.playground.proxy
    ) {
        return new Response("Not Found", { status: 404 })
    }
    const docs = await openapiDocumentIndex(ctx)
    const allowedOrigins = new Set(
        docs.flatMap((doc) => doc.servers).filter(isPublicDocsApiOrigin),
    )
    if (allowedOrigins.size === 0) {
        return new Response("Not Found", { status: 404 })
    }
    const params = new URL(request.url).searchParams
    const target = URL.parse(params.get("url") ?? "")

    const relay = async (): Promise<Response> => {
        if (!target || !allowedOrigins.has(target.origin)) {
            return Response.json("[Proxy] The target origin is not allowed.", {
                status: 400,
            })
        }
        const versionKey = `${ctx.site.id}:${ctx.versionId}`
        let declared = declaredHeaders.get(versionKey)
        if (!declared) {
            const names = new Set(PLAYGROUND_HEADERS)
            const collect = (node: unknown): void => {
                if (Array.isArray(node)) {
                    for (const item of node) collect(item)
                    return
                }
                if (typeof node !== "object" || node === null) return
                if (
                    "in" in node &&
                    node.in === "header" &&
                    "name" in node &&
                    typeof node.name === "string"
                )
                    names.add(node.name.toLowerCase())
                for (const value of Object.values(node)) collect(value)
            }
            for (const spec of await Promise.all(
                docs.map((doc) => openapiDocument(ctx, doc.docId)),
            ))
                collect(spec)
            declaredHeaders.set(versionKey, names)
            declared = names
        }
        const undici = await import("undici")
        const headers = new undici.Headers()
        for (const [name, value] of request.headers)
            if (declared.has(name) && !NEVER_FORWARDED.test(name))
                headers.set(name, value)
        // Intentional playground cookies arrive in the proxy protocol's
        // `cookie` query parameter; the docs origin's own cookies never leave.
        const cookie = params.get("cookie")
        if (cookie) {
            try {
                headers.set("cookie", cookie)
            } catch {
                return Response.json(
                    "[Proxy] The cookie parameter is not a valid header value.",
                    { status: 400 },
                )
            }
        }

        publicOnlyAgent ??= new undici.Agent({
            connect: {
                lookup: (hostname, options, callback) =>
                    lookup(
                        hostname,
                        { ...options, all: true },
                        (error, found) => {
                            if (error) return callback(error, [])
                            const first = found[0]
                            if (
                                !first ||
                                !found.every((entry) =>
                                    isPublicUnicastAddress(entry.address),
                                )
                            )
                                return callback(
                                    new Error(
                                        `${hostname} resolves to a non-public address`,
                                    ),
                                    [],
                                )
                            if (options.all) callback(null, found)
                            else callback(null, first.address, first.family)
                        },
                    ),
            },
        })

        let method = request.method
        let body =
            method !== "GET" && method !== "HEAD"
                ? await request.arrayBuffer()
                : undefined
        const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        let url = target
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            // The socket lookup never runs for an IP literal; check it here.
            const literal = url.hostname.replace(/^\[|\]$/g, "")
            if (isIP(literal) && !isPublicUnicastAddress(literal)) {
                return Response.json(
                    "[Proxy] The target address is not public.",
                    { status: 400 },
                )
            }
            let upstream: Awaited<ReturnType<typeof undici.fetch>>
            try {
                upstream = await undici.fetch(url.href, {
                    method,
                    headers,
                    body,
                    redirect: "manual",
                    signal,
                    dispatcher: publicOnlyAgent,
                })
            } catch (error) {
                // undici reports the socket's reason (refused, timed out,
                // or the lookup's non-public refusal) as the cause.
                const reason =
                    error instanceof Error && error.cause instanceof Error
                        ? error.cause.message
                        : error instanceof Error
                          ? error.message
                          : "connection failed"
                return Response.json(
                    `[Proxy] Could not reach ${url.origin}: ${reason}`,
                    { status: 502 },
                )
            }
            const location = upstream.headers.get("location")
            const next = location ? URL.parse(location, url) : null
            if (!REDIRECT_STATUSES.has(upstream.status) || !next) {
                // undici has already decoded the body; the browser must not
                // decode it again, and CORS is the docs origin's, not
                // upstream's.
                const responseHeaders = new Headers([...upstream.headers])
                responseHeaders.delete("content-encoding")
                responseHeaders.delete("content-length")
                for (const name of [...responseHeaders.keys()])
                    if (name.startsWith("access-control-"))
                        responseHeaders.delete(name)
                // Re-streamed through the global ReadableStream: undici's
                // stream type is the same class at runtime but not to the
                // compiler.
                const reader = upstream.body?.getReader()
                return new Response(
                    reader &&
                        new ReadableStream<Uint8Array>({
                            async pull(controller) {
                                const { done, value } = await reader.read()
                                if (done) controller.close()
                                else if (value instanceof Uint8Array)
                                    controller.enqueue(value)
                            },
                            cancel: (reason) => reader.cancel(reason),
                        }),
                    {
                        status: upstream.status,
                        statusText: upstream.statusText,
                        headers: responseHeaders,
                    },
                )
            }
            // A redirect's body is never read; release its connection.
            await upstream.body?.cancel()
            if (!allowedOrigins.has(next.origin)) {
                return Response.json(
                    "[Proxy] The redirect origin is not allowed.",
                    { status: 400 },
                )
            }
            // Fetch's redirect rules: 301/302 turn only a POST into a GET,
            // 303 turns anything but GET/HEAD into one.
            if (
                ((upstream.status === 301 || upstream.status === 302) &&
                    method === "POST") ||
                (upstream.status === 303 &&
                    method !== "GET" &&
                    method !== "HEAD")
            ) {
                method = "GET"
                body = undefined
                headers.delete("content-type")
            }
            // Another origin the spec lists is not the one the reader gave
            // credentials to: only the credential-free headers go on.
            if (next.origin !== url.origin)
                for (const name of [...headers.keys()])
                    if (!PORTABLE_HEADERS.has(name)) headers.delete(name)
            url = next
        }
        return Response.json("[Proxy] Too many redirects.", { status: 508 })
    }

    const started = Date.now()
    const response = await relay()
    // Shape only — never the target path, query, headers, or body, which
    // carry the reader's API keys and payloads. The host is reported only
    // when the proxy allowed it, so a forged `url` cannot write arbitrary
    // hostnames into analytics; a rejected target shows as a null host.
    emitEvent(request, {
        type: "api_playground_request_sent",
        method: request.method,
        target_host:
            target && allowedOrigins.has(target.origin)
                ? target.hostname
                : null,
        upstream_status: response.status,
        duration_ms: Date.now() - started,
    })
    return response
}

// Concrete method map (the methods the playground sends) rather than a
// catch-all — explicit and portable across TanStack Start versions.
export const Route = createFileRoute("/api/proxy")({
    server: {
        handlers: {
            GET: handleProxy,
            POST: handleProxy,
            PUT: handleProxy,
            PATCH: handleProxy,
            DELETE: handleProxy,
            HEAD: handleProxy,
        },
    },
})
