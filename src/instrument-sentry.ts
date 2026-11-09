import * as Sentry from "@sentry/tanstackstart-react"
import { isNotFound } from "@tanstack/react-router"
import { waitUntil } from "@vercel/functions"
import { literal, object, safeParse } from "zod/mini"
import {
    isDatabaseLoginRejected,
    SENTRY_DATA_COLLECTION,
    scrubSentryEvent,
    scrubSentryLog,
    scrubSentrySpan,
} from "@/types/sentry-scrub"
import { deploymentEnvironment, env } from "./env"

let initialized = false

const VERCEL_PING_PATH = "/_vercel/ping"

/** Node's abortIncoming rejection when the browser closes the socket
 * mid-request (navigation, tab close): the client left, nothing failed. */
const clientAbortSchema = object({
    code: literal("ECONNRESET"),
    message: literal("aborted"),
})

export async function flushTelemetry(): Promise<void> {
    if (!Sentry.getClient()) return
    try {
        if (!(await Sentry.flush(2000))) {
            console.warn("Sentry telemetry flush timed out")
        }
    } catch (error) {
        console.warn("Sentry telemetry flush failed", error)
    }
}

// Keep Sentry server-only so docs pages do not gain injected browser JS.
// Call before handler construction; side-effect imports are tree-shaken.
// Vercel has no OTel preload, so request capture uses wrapFetchWithSentry and
// global middleware. An unset SENTRY_DSN disables Sentry, and so does local
// development unless SENTRY_ENVIRONMENT names it (debugging instrumentation).
export function initSentry() {
    if (
        initialized ||
        !env.SENTRY_DSN ||
        (!env.SENTRY_ENVIRONMENT && deploymentEnvironment === "development")
    ) {
        return
    }

    const environment = env.SENTRY_ENVIRONMENT ?? deploymentEnvironment
    const isProd = environment === "production"

    Sentry.init({
        dsn: env.SENTRY_DSN,
        environment,
        release: env.SENTRY_RELEASE,
        // Register Sentry's OTel tracer provider so @ai-sdk/otel spans become
        // Sentry spans (Sentry 11 defaults this off for Node-based SDKs).
        enableOpenTelemetrySetup: true,
        // This surface makes no Sentry.logger calls — console is its log
        // stream (this integration is what turns logging on in Sentry 11),
        // and without it console only ever became breadcrumbs (a 100-entry
        // ring buffer). beforeSendLog scrubs what ships.
        integrations: [Sentry.consoleLoggingIntegration()],
        // Vercel's own health check (GET /_vercel/ping from 127.0.0.1, no
        // user agent) is never a visit: dropped before a span exists, it
        // would otherwise fill the project with http.server spans. The incoming-request span is named just "GET" when it
        // starts, so the path comes from its url.path attribute. Everything
        // else keeps its parent's decision, or samples at 10% in prod and
        // fully elsewhere.
        tracesSampler: ({ attributes, inheritOrSampleWith }) =>
            attributes?.["url.path"] === VERCEL_PING_PATH
                ? 0
                : inheritOrSampleWith(isProd ? 0.1 : 1.0),
        // No outbound request continues this trace: the playground proxy
        // calls hosts a docs author chose, and sentry-trace/baggage would
        // hand them this deployment's trace ids, release and DSN key.
        tracePropagationTargets: [],
        // Sentry 11 collects every category by default; pin the restrictive
        // shared policy. The scrubbers cover what still ships (headers, URLs,
        // breadcrumbs, spans, logs).
        dataCollection: SENTRY_DATA_COLLECTION,
        // TanStack control flow rethrown through the sentryGlobal*
        // middleware arrives here as an exception: notFound() objects and
        // thrown Response redirects (llmMiddleware's 307, start.ts's 404)
        // are intended request outcomes, not errors. Outside production, a
        // database that rejects the login role (pg 28000/28P01) is usually a
        // preview whose database branch was deleted with its pull request —
        // expected state; in a production deployment the same signal is an
        // outage and still ships, whatever SENTRY_ENVIRONMENT labels it. A
        // client that disconnects mid-request is no error.
        beforeSend: (event, hint) => {
            const thrown = hint.originalException
            if (
                isNotFound(thrown) ||
                thrown instanceof Response ||
                safeParse(clientAbortSchema, thrown).success ||
                (deploymentEnvironment !== "production" &&
                    isDatabaseLoginRejected(thrown))
            ) {
                return null
            }
            return scrubSentryEvent(event)
        },
        // Spans stream individually (traceLifecycle 'stream'), so
        // beforeSendTransaction never runs; scrub each span instead.
        beforeSendSpan: scrubSentrySpan,
        beforeSendLog: scrubSentryLog,
    })

    // Keep Vercel alive until Sentry flushes after the root span
    // ends. Streaming routes also flush when the AI stream ends because its
    // spans finish after the response-head span.
    Sentry.getClient()?.on("spanEnd", (span) => {
        if (Sentry.getRootSpan(span) !== span) {
            return
        }
        waitUntil(
            new Promise((resolve) => setTimeout(resolve, 150)).then(
                flushTelemetry,
            ),
        )
    })

    initialized = true
}

let aiTelemetry: Promise<void> | undefined

/**
 * Turn the chat route's AI SDK calls into Sentry spans. AI SDK v7 needs its
 * OTel integration to emit GenAI spans (Sentry's vercelAI hook does not
 * support v7); it uses the global tracer, which is Sentry's. Without
 * SENTRY_DSN nothing loads. Call sites control input/output capture with
 * telemetry.recordInputs/recordOutputs.
 *
 * Only the chat route emits AI spans, so this loads the ai/otel stack on its
 * first request instead of on every cold start; await it before calling
 * `streamText`.
 */
export function registerAiTelemetry(): Promise<void> {
    aiTelemetry ??= (async () => {
        if (!initialized) return
        const [{ OpenTelemetry }, { registerTelemetry }] = await Promise.all([
            import("@ai-sdk/otel"),
            import("ai"),
        ])
        registerTelemetry(new OpenTelemetry())
    })()
    return aiTelemetry
}
