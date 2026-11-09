import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { normalizeDocUrl } from "@/lib/agent-content"
import {
    feedbackJsonSchema,
    feedbackSchema,
    MAX_FEEDBACK_BODY_BYTES,
    pageExists,
    recordFeedback,
} from "@/lib/agent-feedback"
import { emitEvent } from "@/lib/observability"
import { resolveDocsContext } from "@/lib/source"

function json(
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...extraHeaders,
        },
    })
}

// File-route server handlers run with handlerType "router", which the CSRF middleware
// (serverFn-only) does not gate — so agents can POST without a CSRF token.
export const Route = createFileRoute("/api/agent/feedback")({
    server: {
        handlers: {
            GET: ({ request }) => {
                if (!isSurfaceEnabled("feedback"))
                    return new Response("Not Found", { status: 404 })
                const url = new URL(request.url)
                if (url.searchParams.has("schema")) {
                    return json({
                        schema: feedbackJsonSchema(),
                        example: {
                            url: "/test",
                            kind: "outdated",
                            message: "The install step is stale.",
                        },
                    })
                }
                return json(
                    {
                        error: "method_not_allowed",
                        hint: "POST feedback, or GET ?schema for the input schema.",
                    },
                    405,
                    { Allow: "POST" },
                )
            },
            POST: async ({ request }) => {
                if (!isSurfaceEnabled("feedback"))
                    return new Response("Not Found", { status: 404 })
                if (
                    Number(request.headers.get("content-length") ?? 0) >
                    MAX_FEEDBACK_BODY_BYTES
                )
                    return json({ error: "too_large" }, 413)
                const text = await request.text().catch(() => "")
                if (text.length > MAX_FEEDBACK_BODY_BYTES)
                    return json({ error: "too_large" }, 413)
                const body: unknown = (() => {
                    try {
                        return JSON.parse(text)
                    } catch {
                        return null
                    }
                })()
                const parsed = feedbackSchema.safeParse(body)
                if (!parsed.success) {
                    return json(
                        { error: "invalid", issues: parsed.error.issues },
                        400,
                    )
                }
                // Resolve the tree the page lives in (its locale/version),
                // not the endpoint's own path, so pageExists is judged there.
                const ctx = await resolveDocsContext(
                    request,
                    normalizeDocUrl(parsed.data.url),
                )
                // Best-effort: recordFeedback never rejects and hands its
                // row insert to waitUntil, so the 202 never waits on it.
                void recordFeedback(ctx, request, parsed.data)
                emitEvent(request, {
                    type: "agent_feedback_submitted",
                    kind: parsed.data.kind,
                    source: parsed.data.source,
                    page_url: parsed.data.url,
                    page_exists: pageExists(ctx, parsed.data.url),
                    ...(agentConfig.observability.includeInputs
                        ? { message: parsed.data.message }
                        : {}),
                })
                return json({ ok: true, received: true }, 202)
            },
        },
    },
})
