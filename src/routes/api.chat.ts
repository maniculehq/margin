import { randomUUID } from "node:crypto"
import type { GatewayProviderOptions } from "@ai-sdk/gateway"
import * as Sentry from "@sentry/tanstackstart-react"
import { createFileRoute } from "@tanstack/react-router"
import { waitUntil } from "@vercel/functions"
import { z } from "zod"
import { extensions } from "#docs-extensions"
import { enforceRateLimit } from "@/db/rate-limit"
import { flushTelemetry, registerAiTelemetry } from "@/instrument-sentry"
import { agentConfig } from "@/lib/agent.config"
import { normalizeDocUrl, searchServerFor } from "@/lib/agent-content"
import { emitEvent } from "@/lib/observability"
import { type DocsContext, resolveDocsContext } from "@/lib/source"
import { CONFIG_EXTENSION_KEY, searchModeSchema } from "@/types/docs"
import type { ChatUIMessage, SearchTool } from "../components/ai/search"
import { assistantAvailable } from "../env"

/** The envelope only: messages are validated by the AI SDK once it loads, and
 *  their content never enters analytics. */
const chatBodyShape = z.looseObject({
    messages: z.array(z.unknown()).optional(),
    path: z.string().optional(),
})

/** Every refusal the chat panel can show: JSON whose `message` the panel
 *  renders as is (components/ai/search.tsx). */
const chatErrorSchema = z.object({
    error: z.enum([
        "assistant_not_configured",
        "conversation_too_long",
        "invalid_request",
        "rate_limited",
    ]),
    message: z.string(),
    /** Rate limits only; mirrors the Retry-After header. */
    retryAfterSeconds: z.number().int().positive().optional(),
})

const conversationTooLong = {
    error: "conversation_too_long",
    message: "This conversation is too long. Start a new chat to keep asking.",
} satisfies z.infer<typeof chatErrorSchema>

/** A body that is not the chat panel's JSON is the caller's error (400), not
 *  a server fault that pages Sentry. */
const invalidRequest = {
    error: "invalid_request",
    message: "This message could not be read. Start a new chat to keep asking.",
} satisfies z.infer<typeof chatErrorSchema>

/** Read from the stored config itself: the chrome's layout parse can fail on
 *  an unrelated field and would otherwise default a disabled site to "ai". */
const searchModeConfigSchema = z.object({
    [CONFIG_EXTENSION_KEY]: z.object({
        search: z.object({ mode: searchModeSchema }),
    }),
})

/**
 * The route is unauthenticated and every request spends a model call, so it
 * is bounded before any work: the body's size, the history the model reads,
 * and how many questions one site's Assistant answers a day. The ceiling is
 * per site, not per caller, so one caller can spend a site's whole day.
 */
const MAX_CHAT_BODY_BYTES = 512 * 1024
/** The stream's error text. With onEnd set, the AI SDK replays every error
 * chunk through onError as `new Error(errorText)`, so this text comes back. */
const CHAT_ERROR_TEXT = "The AI assistant hit an error — please retry."
const MAX_CHAT_MESSAGES = 24
const DAY_MS = 24 * 60 * 60 * 1000
const SITE_DAILY_LIMIT = 3000
/** Per model step (reasoning included), so one request spends at most
 *  MAX_CHAT_STEPS × this. A ceiling well above a cited docs answer, not a
 *  target: without it one step could run to the model's own output limit. */
const MAX_OUTPUT_TOKENS = 8192
const MAX_CHAT_STEPS = 5

/** Site-independent assistant instructions, passed as `instructions`. */
const systemPrompt = [
    "You are an AI assistant for a documentation site.",
    "Use the `search` tool to retrieve relevant docs context before answering when needed.",
    // The model used to fire ~8 sequential searches before its first token
    // (15-25s to first text) — cap the exploration explicitly.
    "Run at most two searches before answering: one well-chosen query usually suffices, and answers should start promptly.",
    "The `search` tool returns raw JSON results from documentation. Use those results to ground your answer and cite sources as markdown links using the document `url` field when available.",
    "If you cannot find the answer in search results, say you do not know and suggest a better search query.",
].join("\n")

export const Route = createFileRoute("/api/chat")({
    server: {
        handlers: {
            POST: async (ctx) => {
                const req = ctx.request
                // No AI Gateway credential (AI_GATEWAY_API_KEY, or the OIDC
                // token on Vercel): the chrome shows static search. An
                // already-open client receives an actionable error.
                if (!assistantAvailable())
                    return Response.json(
                        {
                            error: "assistant_not_configured",
                            message:
                                "The assistant is not configured. Use documentation search instead.",
                        } satisfies z.infer<typeof chatErrorSchema>,
                        { status: 503 },
                    )
                // Refused on the declared length when there is one, and read
                // with a running byte count otherwise — an oversized body is
                // never buffered whole.
                if (
                    Number(req.headers.get("content-length") ?? 0) >
                    MAX_CHAT_BODY_BYTES
                )
                    return Response.json(conversationTooLong, { status: 413 })
                const chunks: Uint8Array[] = []
                let received = 0
                const reader = req.body?.getReader()
                for (;;) {
                    const chunk = await reader?.read()
                    if (!chunk || chunk.done) break
                    received += chunk.value.byteLength
                    if (received > MAX_CHAT_BODY_BYTES) {
                        await reader?.cancel()
                        return Response.json(conversationTooLong, {
                            status: 413,
                        })
                    }
                    chunks.push(chunk.value)
                }
                let reqJson: unknown
                try {
                    reqJson = JSON.parse(
                        new TextDecoder().decode(Buffer.concat(chunks)),
                    )
                } catch {
                    return Response.json(invalidRequest, { status: 400 })
                }
                const chatBody = chatBodyShape.safeParse(reqJson)
                if (!chatBody.success)
                    return Response.json(invalidRequest, { status: 400 })
                const slugs = normalizeDocUrl(chatBody.data.path ?? "")
                const docsCtx = await resolveDocsContext(req, slugs)
                // The chrome hides the Assistant for "static"/"off" sites;
                // the route must refuse them too, or the model stays callable.
                const configured = searchModeConfigSchema.safeParse(
                    docsCtx.config,
                )
                if (
                    configured.success &&
                    configured.data[CONFIG_EXTENSION_KEY].search.mode !== "ai"
                )
                    return new Response("Not Found", { status: 404 })
                const limited = await enforceRateLimit({
                    bucket: "docs_chat_site_day",
                    key: `docs_chat:${extensions.rateLimitScope?.(docsCtx.site) ?? docsCtx.site.id}`,
                    limit: SITE_DAILY_LIMIT,
                    windowMs: DAY_MS,
                })
                if (!limited.allowed) {
                    const retryAfterSeconds = limited.retryAfterSeconds ?? 60
                    // The ceiling is daily, so the wait can run to hours.
                    const minutes = Math.max(
                        1,
                        Math.ceil(retryAfterSeconds / 60),
                    )
                    const hours = Math.ceil(retryAfterSeconds / 3600)
                    const wait =
                        minutes < 60
                            ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
                            : `${hours} ${hours === 1 ? "hour" : "hours"}`
                    return Response.json(
                        {
                            error: "rate_limited",
                            message: `This site's assistant has reached its daily limit. Try again in ${wait}.`,
                            retryAfterSeconds,
                        } satisfies z.infer<typeof chatErrorSchema>,
                        {
                            status: 429,
                            headers: {
                                "Retry-After": String(retryAfterSeconds),
                            },
                        },
                    )
                }
                // The AI SDK stack loads on the first chat request, not on
                // every cold start; telemetry registers before streamText.
                const [
                    {
                        convertToModelMessages,
                        safeValidateUIMessages,
                        stepCountIs,
                        streamText,
                    },
                ] = await Promise.all([import("ai"), registerAiTelemetry()])
                // Only the recent turns: an old conversation never grows the
                // prompt without bound.
                const messages = await safeValidateUIMessages<ChatUIMessage>({
                    messages: (chatBody.data.messages ?? []).slice(
                        -MAX_CHAT_MESSAGES,
                    ),
                })
                // The panel sends user text and client context and echoes the
                // assistant's own turns, so a system turn or a file part is
                // forged: the model call refuses the first only mid-stream (a
                // 200 that pages Sentry) and would fetch the second's URL.
                if (
                    !messages.success ||
                    messages.data.some(
                        (message) =>
                            message.role === "system" ||
                            message.parts.some((part) => part.type === "file"),
                    )
                )
                    return Response.json(invalidRequest, { status: 400 })
                emitEvent(req, {
                    type: "chat_message_sent",
                    message_count: chatBody.data.messages?.length ?? 0,
                    model: agentConfig.agentModel,
                })

                // Names this answer: thumbs feedback sends it back, so a
                // docs_agent_feedback row says which answer it rates, and the
                // span below carries it, so the row leads to the trace.
                const answerId = randomUUID()
                // Keep this AI-named Sentry span open through stream close so
                // SDK spans appear as its children in Sentry.
                return Sentry.startSpanManual(
                    {
                        name: "ai.docsChat",
                        attributes: { "docs.answer_id": answerId },
                    },
                    async (span) => {
                        // The page the question was asked on — votes report
                        // this instead of wherever the visitor navigated to
                        // by the time they clicked a thumb.
                        const pageUrl = chatBody.data.path

                        try {
                            // Plain model string → Vercel AI Gateway (the ai package's
                            // default provider). On Vercel the deployment's OIDC token
                            // authenticates automatically — no provider API key exists or
                            // is needed. Local dev needs `vercel env pull` (for the OIDC
                            // token) or an AI_GATEWAY_API_KEY in the env.
                            const result = streamText({
                                model: agentConfig.agentModel,
                                stopWhen: stepCountIs(MAX_CHAT_STEPS),
                                maxOutputTokens: MAX_OUTPUT_TOKENS,
                                telemetry: {
                                    functionId: "docs-chat",
                                    // Same input-capture gate as the PostHog
                                    // event and the feedback comment: visitor
                                    // prompts, completions, and tool payloads
                                    // ride the exported spans only when
                                    // includeInputs is on. Structure, model,
                                    // latency, and token usage always ship.
                                    recordInputs:
                                        agentConfig.observability.includeInputs,
                                    recordOutputs:
                                        agentConfig.observability.includeInputs,
                                },
                                // Ignored by non-OpenAI models if DOCS_CHAT_MODEL overrides.
                                providerOptions: {
                                    gateway: {
                                        disallowPromptTraining: true,
                                        tags: [
                                            "framework",
                                            "feature:docs-chat",
                                        ],
                                    } satisfies GatewayProviderOptions,
                                    openai: {
                                        reasoningEffort: "medium",
                                        store: false,
                                    },
                                },
                                tools: {
                                    search: await makeSearchTool(
                                        docsCtx,
                                        slugs,
                                    ),
                                },
                                // ai v7 forbids system-role entries inside `messages`;
                                // system content goes through `instructions`.
                                instructions: systemPrompt,
                                messages:
                                    await convertToModelMessages<ChatUIMessage>(
                                        messages.data,
                                        {
                                            convertDataPart(part) {
                                                if (part.type === "data-client")
                                                    return {
                                                        type: "text",
                                                        text: `[Client Context: ${JSON.stringify(part.data)}]`,
                                                    }
                                            },
                                        },
                                    ),
                                toolChoice: "auto",
                                // A step stopped by MAX_OUTPUT_TOKENS is an
                                // answer cut short; report it so the cap is
                                // tuned from real answers, not guessed.
                                onStepEnd(step) {
                                    if (step.finishReason !== "length") return
                                    Sentry.captureMessage(
                                        "Docs assistant answer reached its output-token cap",
                                        {
                                            level: "warning",
                                            extra: {
                                                maxOutputTokens:
                                                    MAX_OUTPUT_TOKENS,
                                                outputTokens:
                                                    step.usage.outputTokens,
                                            },
                                        },
                                    )
                                    waitUntil(flushTelemetry())
                                },
                            })

                            return result.toUIMessageStreamResponse({
                                // Trailing metadata the useChat client already
                                // parses — rides the assistant message so each
                                // answer carries its own id and originating
                                // page back with thumbs feedback.
                                messageMetadata: ({ part }) => {
                                    if (part.type !== "finish") return undefined
                                    return {
                                        answerId,
                                        ...(pageUrl ? { pageUrl } : {}),
                                    }
                                },
                                onEnd: () => {
                                    span.end()
                                    // The root span ends at response headers,
                                    // before AI stream spans. Flush again after
                                    // the stream or Vercel may drop their batch.
                                    waitUntil(
                                        new Promise((resolve) =>
                                            setTimeout(resolve, 150),
                                        ).then(flushTelemetry),
                                    )
                                },
                                // streamText never rejects — provider failures surface
                                // only here, and the default handler masks them with no
                                // capture (the route still returns 200, so the global
                                // Sentry middleware never sees the error either).
                                onError(error) {
                                    // Our own text echoed back is the error
                                    // already captured, not a second one.
                                    if (
                                        error instanceof Error &&
                                        error.message === CHAT_ERROR_TEXT
                                    )
                                        return CHAT_ERROR_TEXT
                                    Sentry.captureException(error)
                                    waitUntil(flushTelemetry())
                                    return CHAT_ERROR_TEXT
                                },
                            })
                        } catch (error) {
                            // onEnd never fires when stream setup throws
                            // (malformed messages, provider construction) —
                            // close the span here or it leaks unfinished.
                            span.end()
                            throw error
                        }
                    },
                )
            },
        },
    },
})

// Reuse the per-version Orama index instead of a second flexsearch index. Built
// per request so the tool searches the requesting site's docs only. Returns
// SortedResult[] (page/heading/text entries with `url` deep-links + breadcrumbs).
async function makeSearchTool(ctx: DocsContext, slugs: string[]) {
    const { tool } = await import("ai")
    return tool({
        description: "Search the docs content and return raw JSON results.",
        inputSchema: z.object({
            query: z.string(),
            limit: z.number().int().min(1).max(100).default(10),
        }),
        async execute({ query, limit }) {
            // slugs scope the index to the version the visitor is reading —
            // without them a /docs/v1 reader searched the default version.
            return (await searchServerFor(ctx, slugs)).search(query, {
                limit,
            })
        },
    }) satisfies SearchTool
}
