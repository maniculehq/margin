// Shared scrubbers for Node and Next Sentry hooks. Collection settings already
// disable cookies, query strings, and bodies; these scrub headers, URLs, and
// logs. Structural typing avoids an SDK dependency, and zod/mini keeps browser
// instrumentation bundles small.

import {
    number,
    object,
    optional,
    record,
    safeParse,
    string,
    union,
    unknown,
} from "zod/mini"

const SENSITIVE_HEADER_KEYS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-review-token",
])

// Filter known extension errors from browser DSNs; this complements Sentry's
// third-party integration for injected scripts these patterns do not name.

/** `denyUrls` — drops events whose frames come from injected extension code. */
export const BROWSER_EXTENSION_DENY_URLS: RegExp[] = [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^safari(?:-web)?-extension:\/\//,
    /extensionServiceWorker\.js/,
    /extensionPageScript\.js/,
    /scripts\/inpage\.js/,
]

/** `ignoreErrors` — extension failures that arrive without a usable frame,
 *  plus browser-internal rejections the page cannot act on. */
export const BROWSER_IGNORE_ERRORS: (string | RegExp)[] = [
    "MetaMask extension not found",
    "Talisman extension has not been configured",
    "Attempting to use a disconnected port object",
    // An extension hooking history/pushState, not the page:
    /Object Not Found Matching Id:\d+/,
    "Invalid call to runtime.sendMessage",
    "Could not establish connection. Receiving end does not exist",
    // Extension-injected globals probed on pages that lack them:
    "__firefox__",
    "window.ethereum",
    // A view transition superseded by the next navigation (or started while
    // the document was hidden): the browser rejects its promises, the DOM
    // update itself still lands.
    /Transition was aborted because of invalid state/,
]

// Lowercased query/fragment param names that may carry a credential.
// posthog-scrub.ts shares this set so the two sinks redact identically.
export const TOKEN_PARAM_KEYS = new Set([
    "auditlogintoken",
    "token",
    "logintoken",
    // The workspace-invite signup capability (?invitation= on /invite).
    "invitation",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "api_key",
    "apikey",
    "secret",
    "password",
    "code",
    // PII, not a credential: an address in a link (the audit CTA once put
    // one in ?email=) must not reach either sink.
    "email",
])

// Keys whose VALUE is redacted when they appear as a log attribute /
// breadcrumb / span data key. Everything in TOKEN_PARAM_KEYS except "code":
// ?code= is an OAuth credential in a URL, but `code` as an attribute key is
// almost always an error code (the API's error middleware logs rely on it).
const SENSITIVE_ATTRIBUTE_KEYS = new Set(
    [...TOKEN_PARAM_KEYS].filter((key) => key !== "code"),
)

// Invitation tokens ride the URL PATH, not a query param
// (/invite/<256-bit token>). Redact the segment wherever a URL or bare
// pathname appears.
export const TOKEN_PATH_RE = /(\/invite\/)[^/?#]+/g

const REDACTED = "[redacted]"

// URL userinfo (`postgres://user:secret@host`): connection strings surface in
// driver/ORM error messages, and `new URL()` keeps the password on the
// parsed object, so strip the whole userinfo before any other handling.
const URL_USERINFO_RE = /(\/\/)[^/@\s]+@/g

interface SentryEventLike {
    message?: string
    exception?: { values?: Array<{ value?: string }> }
    request?: {
        url?: string
        query_string?: unknown
        headers?: Record<string, unknown>
        cookies?: unknown
    }
    breadcrumbs?: Array<{ data?: Record<string, unknown> }> | undefined
}

// Next.js Server Action ids are hex digests (40+ chars); scanners send junk.
const NEXT_ACTION_ID_RE = /^[0-9a-f]{40,}$/i

/** beforeSend: drops never-actionable server noise,
 *  then scrubs what is left. Returns null for a dropped event. */
export function scrubSentryEvent<T extends SentryEventLike>(
    event: T,
): T | null {
    // Dropped: scanners probing the Server Action handler — the action
    // failure a forged Next-Action id provokes, or a CMS probe of a .php
    // path — and a client that disconnected mid-response ("The destination
    // stream closed early"). Any other error on a forged request still ships.
    const nextAction = Object.entries(event.request?.headers ?? {}).find(
        ([key]) => key.toLowerCase() === "next-action",
    )
    const messages = [
        event.message,
        ...(event.exception?.values ?? []).map((value) => value.value),
    ]
    if (
        (nextAction !== undefined &&
            !(
                typeof nextAction[1] === "string" &&
                NEXT_ACTION_ID_RE.test(nextAction[1])
            ) &&
            messages.some((message) =>
                /Server Action|resumable slots/.test(message ?? ""),
            )) ||
        messages.some((message) =>
            message?.includes("The destination stream closed early"),
        ) ||
        (messages.some((message) =>
            message?.includes("Failed to find Server Action"),
        ) &&
            /^[^?#]*\.php/i.test(event.request?.url ?? ""))
    ) {
        return null
    }

    if (event.request) {
        if (event.request.headers) {
            redactSensitiveKeys(event.request.headers)
        }
        if (typeof event.request.url === "string") {
            event.request.url = redactUrl(event.request.url)
        }
        // The query string / cookies can both carry secrets; drop wholesale.
        if (event.request.query_string != null) {
            event.request.query_string = undefined
        }
        if (event.request.cookies != null) {
            event.request.cookies = undefined
        }
    }

    if (Array.isArray(event.breadcrumbs)) {
        for (const crumb of event.breadcrumbs) {
            redactDataBag(crumb?.data)
        }
    }

    return event
}

interface SentrySpanLike {
    name?: string
    attributes?: Record<string, unknown>
}

// beforeSendSpan scrubber: Sentry 11 streams spans by default, so
// beforeSendTransaction never runs and each span (segment and child alike)
// passes through here instead. Span names carry URLs (`GET /invite/<token>`)
// and attributes carry url.full / url.query / http.*.header.* values.
// beforeSendSpan cannot drop a span; drops belong in ignoreSpans/tracesSampler.
export function scrubSentrySpan<T extends SentrySpanLike>(span: T): T {
    if (typeof span.name === "string") {
        span.name = looksLikeUrl(span.name)
            ? redactUrl(span.name)
            : redactText(span.name)
    }
    if (span.attributes) {
        redactDataBag(span.attributes)
    }
    return span
}

// Sentry 11 collects every category unless told otherwise. Pin the v10
// defaults (user info stays on; query strings stay off as before): no
// cookies, bodies, AI I/O, DB/queue payloads, GraphQL data, or frame locals;
// IP/forwarding headers denied, credential headers scrubbed above and by
// Sentry's built-in filter.
const HEADER_DENY = ["forwarded", "-ip", "remote-", "via", "-user"]
export const SENTRY_DATA_COLLECTION = {
    userInfo: true,
    cookies: false,
    httpHeaders: {
        request: { deny: HEADER_DENY },
        response: { deny: HEADER_DENY },
    },
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
    stackFrameVariables: false,
}

interface SentryLogLike {
    message?: unknown
    attributes?: Record<string, unknown>
}

// beforeSendLog scrubber: Sentry Logs bypass beforeSend/beforeSendSpan,
// so token-bearing URLs logged as message text or attributes (e.g. the API's
// request logger passing c.req.url) need their own pass.
export function scrubSentryLog<T extends SentryLogLike>(log: T): T {
    if (typeof log.message === "string") {
        log.message = redactText(log.message)
    }
    if (log.attributes) {
        redactDataBag(log.attributes)
    }
    return log
}

function redactSensitiveKeys(bag: Record<string, unknown>): void {
    for (const key of Object.keys(bag)) {
        if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
            bag[key] = REDACTED
        }
    }
}

// Plain objects only: class instances, Dates, Maps and the like are left
// as-is rather than flattened through Object.entries.
const plainRecordSchema = record(string(), unknown())

// Data bags are not flat: console-capture log attributes nest whole argument
// structures (`sentry.message.parameter.N` holds a normalize()d object or
// array), and breadcrumb/span data can carry nested payloads too. Rebuild the
// value tree, redacting sensitive keys and every string — a token can hide in
// a stringified JSON blob that doesn't look like a URL. Depth mirrors
// Sentry's normalizeDepth default of 3.
function redactValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
        return looksLikeUrl(value) ? redactUrl(value) : redactText(value)
    }
    if (depth <= 0) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, depth - 1))
    }
    const record = safeParse(plainRecordSchema, value)
    if (record.success) {
        const rebuilt: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(record.data)) {
            const lowered = key.toLowerCase()
            rebuilt[key] =
                SENSITIVE_HEADER_KEYS.has(lowered) ||
                SENSITIVE_ATTRIBUTE_KEYS.has(lowered)
                    ? REDACTED
                    : redactValue(item, depth - 1)
        }
        return rebuilt
    }
    return value
}

// Streamed span attributes name headers `http.request.header.<name>`.
const HEADER_ATTRIBUTE_PREFIX_RE = /^http\.(?:request|response)\.header\./

function redactDataBag(data: Record<string, unknown> | undefined): void {
    if (!data) return
    for (const key of Object.keys(data)) {
        const lowered = key
            .toLowerCase()
            .replace(HEADER_ATTRIBUTE_PREFIX_RE, "")
        if (
            SENSITIVE_HEADER_KEYS.has(lowered) ||
            SENSITIVE_ATTRIBUTE_KEYS.has(lowered)
        ) {
            data[key] = REDACTED
            continue
        }
        data[key] = redactValue(data[key], 3)
    }
}

function looksLikeUrl(value: string): boolean {
    return value.includes("://") || value.startsWith("/")
}

// Free-text redaction for log messages: token query params and invite path
// segments, without requiring the whole string to parse as a URL. The prefix
// class also covers key=value pairs at string start, after whitespace, or in
// cookie-style lists — Sentry Logs bypass beforeSend, so this is the only
// barrier for a logged "token=..." string.
const TOKEN_PARAM_TEXT_RE = new RegExp(
    `((?:^|[?&#;,\\s])(?:${[...TOKEN_PARAM_KEYS].join("|")})=)[^&#;\\s]+`,
    "gi",
)

export function redactText(value: string): string {
    return value
        .replace(URL_USERINFO_RE, `$1${REDACTED}@`)
        .replace(TOKEN_PATH_RE, `$1${REDACTED}`)
        .replace(TOKEN_PARAM_TEXT_RE, `$1${REDACTED}`)
}

export function redactUrl(value: string): string {
    const pathRedacted = value
        .replace(URL_USERINFO_RE, `$1${REDACTED}@`)
        .replace(TOKEN_PATH_RE, `$1${REDACTED}`)
    try {
        const url = new URL(pathRedacted, "http://redacted.invalid")
        let changed = pathRedacted !== value
        for (const key of [...url.searchParams.keys()]) {
            if (TOKEN_PARAM_KEYS.has(key.toLowerCase())) {
                url.searchParams.set(key, REDACTED)
                changed = true
            }
        }
        // Drop the fragment outright — the audit login token rides there.
        if (url.hash) {
            url.hash = ""
            changed = true
        }
        if (!changed) return value
        return pathRedacted.startsWith("/")
            ? `${url.pathname}${url.search}`
            : url.toString()
    } catch {
        return pathRedacted
    }
}

const errorChainLinkSchema = object({
    code: optional(union([string(), number()])),
    message: optional(string()),
    cause: optional(unknown()),
})

/** The database rejected the login role: pg 28000, pg 28P01 (Neon's answer
 *  for a deleted branch's role), or Neon's "endpoint could not be found",
 *  anywhere in the `cause` chain (Drizzle wraps the pg error as
 *  "Failed query: ..."). Outside production this is a torn-down preview
 *  database (its PR merged or closed) — expected state, not a bug. In
 *  production the same signal is an outage, so callers gate on environment. */
export function isDatabaseLoginRejected(error: unknown): boolean {
    let current = error
    for (let depth = 0; depth < 5 && current; depth += 1) {
        const link = safeParse(errorChainLinkSchema, current)
        if (!link.success) return false
        if (
            String(link.data.code) === "28000" ||
            String(link.data.code) === "28P01" ||
            /endpoint could not be found/i.test(link.data.message ?? "")
        ) {
            return true
        }
        current = link.data.cause
    }
    return false
}
