/**
 * With Sentry on, a chat answer's AI SDK spans reach Sentry inside the
 * answer's `ai.docsChat` span, and that span names the answer, so an
 * operator can go from a docs_agent_feedback row's answer_id to its trace.
 * Sentry runs for real against an unreachable DSN and its client's spanEnd
 * hook records what it would ship; the model is a mock. The rate limiter
 * needs DATABASE_URL; the docs context is DB-backed and mocked.
 */
import { randomUUID } from "node:crypto"
import * as Sentry from "@sentry/tanstackstart-react"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { like } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { hasDocsDb } from "./context"

vi.hoisted(() => {
    vi.stubEnv("SENTRY_DSN", "http://public@127.0.0.1:9/1")
    vi.stubEnv("SENTRY_ENVIRONMENT", "test")
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key")
})

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>()
    return {
        ...actual,
        streamText: (
            options: Parameters<typeof actual.streamText>[0],
        ): ReturnType<typeof actual.streamText> =>
            actual.streamText({
                ...options,
                model: new MockLanguageModelV4({
                    doStream: async () => ({
                        stream: simulateReadableStream({
                            chunks: [
                                { type: "stream-start", warnings: [] },
                                { type: "text-start", id: "t" },
                                { type: "text-delta", id: "t", delta: "Hi." },
                                { type: "text-end", id: "t" },
                                {
                                    type: "finish",
                                    finishReason: {
                                        unified: "stop",
                                        raw: "stop",
                                    },
                                    usage: {
                                        inputTokens: {
                                            total: 1,
                                            noCache: 1,
                                            cacheRead: 0,
                                            cacheWrite: 0,
                                        },
                                        outputTokens: {
                                            total: 1,
                                            text: 1,
                                            reasoning: 0,
                                        },
                                    },
                                },
                            ],
                        }),
                    }),
                }),
            }),
    }
})

const SITE_ID = randomUUID()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveDocsContext: async () => ({
        siteId: "chat-sentry-trace",
        site: {
            id: SITE_ID,
            slug: "chat-sentry-trace",
            name: "Chat Sentry trace",
            description: "",
            repo: null,
            analyticsEnabled: false,
            webmcpEnabled: false,
        },
        versionId: null,
        config: null,
    }),
}))

const finishMetadata = z.object({
    type: z.literal("finish"),
    messageMetadata: z.object({ answerId: z.uuid() }),
})

describe.skipIf(!hasDocsDb)("a chat answer's Sentry trace", () => {
    const ended: {
        name: string
        traceId: string
        attributes: Record<string, unknown>
    }[] = []
    let answerId = ""

    beforeAll(async () => {
        const { initSentry } = await import("@/instrument-sentry")
        initSentry()
        const client = Sentry.getClient()
        if (!client) throw new Error("Sentry did not initialize")
        client.on("spanEnd", (span) => {
            const json = Sentry.spanToJSON(span)
            ended.push({
                name: json.name,
                traceId: json.trace_id,
                attributes: json.attributes ?? {},
            })
        })

        const { Route } = await import("@/routes/api.chat")
        const handlers = Route.options.server?.handlers
        if (!handlers || typeof handlers === "function")
            throw new Error("/api/chat declares no handler map")
        const post = handlers.POST
        if (typeof post !== "function")
            throw new Error("/api/chat declares no POST handler")
        const response = await post({
            request: new Request("http://placeholder.local/api/chat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    messages: [
                        {
                            id: "m1",
                            role: "user",
                            parts: [{ type: "text", text: "Hi" }],
                        },
                    ],
                }),
            }),
            params: {},
            pathname: "/api/chat",
            context: undefined,
            next: vi.fn(),
        })
        if (!(response instanceof Response)) throw new Error("no Response")
        const finish = (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => finishMetadata.safeParse(JSON.parse(line.slice(6))))
            .find((parsed) => parsed.success)
        if (!finish?.success) throw new Error("no finish part names the answer")
        answerId = finish.data.messageMetadata.answerId
        await vi.waitFor(() =>
            expect(ended.map((span) => span.name)).toContain("ai.docsChat"),
        )
    }, 30_000)

    afterAll(async () => {
        await Sentry.close(0)
        Sentry.getCurrentScope().setClient(undefined)
        const { db, schema } = await import("@/db")
        await db
            .delete(schema.publicRateLimit)
            .where(like(schema.publicRateLimit.key, `docs_chat:${SITE_ID}%`))
        vi.unstubAllEnvs()
    })

    it("names the answer on its ai.docsChat span", () => {
        expect(
            ended.find((span) => span.name === "ai.docsChat")?.attributes[
                "docs.answer_id"
            ],
        ).toBe(answerId)
    })

    // registerAiTelemetry's @ai-sdk/otel integration (origin "manual"), not
    // Sentry's own vercelAI channel spans, which ship either way.
    it("ships the AI SDK's model-call span in the answer's trace", () => {
        const answer = ended.find((span) => span.name === "ai.docsChat")
        expect(
            ended.filter(
                (span) =>
                    span.traceId === answer?.traceId &&
                    span.attributes["sentry.origin"] === "manual" &&
                    span.attributes["gen_ai.operation.name"] === "chat",
            ),
        ).toEqual([
            expect.objectContaining({
                attributes: expect.objectContaining({
                    "gen_ai.request.model": "mock-model-id",
                }),
            }),
        ])
    })
})
