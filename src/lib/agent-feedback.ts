import { createHash, randomUUID } from "node:crypto"
import * as Sentry from "@sentry/tanstackstart-react"
import { waitUntil } from "@vercel/functions"
import { z } from "zod"
import { extensions } from "#docs-extensions"
import { db, schema } from "@/db"
import { resolveEnv } from "@/db/env"
import { enforceRateLimits } from "@/db/rate-limit"
import type { DocsSite } from "@/extensions/types"
import {
    DOCS_AGENT_FEEDBACK_KINDS,
    DOCS_AGENT_FEEDBACK_SOURCES,
} from "@/types/constants"
import { env as frameworkEnv } from "../env"
import { normalizeDocUrl } from "./agent-content"
import { siteScope } from "./base-path"
import { classifyAgent } from "./observability"
import type { SiteSource } from "./source"

export const feedbackSchema = z
    .object({
        url: z
            .string()
            .min(1)
            .max(2048)
            .describe("The docs page URL or .md URL the feedback is about."),
        kind: z.enum(DOCS_AGENT_FEEDBACK_KINDS),
        message: z
            .string()
            .min(1)
            .max(2000)
            .describe(
                "What is wrong or missing. Required unless kind is helpful or not_helpful.",
            )
            .optional(),
        suggestedFix: z.string().max(2000).optional(),
        // Who is grading: the docs page thumbs widget, the Assistant's answer
        // thumbs, the docs MCP server, or (absent — every external caller) an
        // agent. Analytics splits human votes from agent reports on this; it is
        // self-reported, so it labels traffic rather than authenticating it.
        source: z
            .enum(DOCS_AGENT_FEEDBACK_SOURCES)
            .default("agent")
            .describe("Leave unset when an agent submits feedback."),
        // Chat-answer thumbs (components/ai/search.tsx) send back the id
        // /api/chat minted for the answer. Client-supplied and unauthenticated,
        // like `source`: it labels the row, it grants nothing.
        answerId: z
            .uuid()
            .describe("Id of the Assistant answer this feedback grades.")
            .optional(),
    })
    // helpful/not_helpful are thumbs votes and carry no message; every other
    // kind is a report that must say what is wrong, as the MCP tool requires.
    .refine(
        (f) =>
            f.kind === "helpful" ||
            f.kind === "not_helpful" ||
            f.message !== undefined,
        {
            path: ["message"],
            message:
                "Describe the problem: incorrect, missing, outdated, unclear and other reports need a message.",
        },
    )

// The pre-parse shape: the sink applies the `source` default itself.
export type FeedbackInput = z.input<typeof feedbackSchema>

/** A feedback POST is a few kilobytes of JSON; anything past this is refused
 * before it is parsed. */
export const MAX_FEEDBACK_BODY_BYTES = 16 * 1024

const TEN_MINUTES_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** JSON Schema for GET ?schema discovery, derived from the same zod schema (no drift). */
export function feedbackJsonSchema() {
    return z.toJSONSchema(feedbackSchema, { io: "input" })
}

// Params are the DocsContext slice actually read, so the sink's tests
// (tests/agent-feedback-persist.test.ts) can build one without a resolved
// site source.
export function pageExists(
    ctx: { source: Pick<SiteSource, "getPage"> },
    url: string,
): boolean {
    return Boolean(ctx.source.getPage(normalizeDocUrl(url)))
}

/**
 * The feedback sink: a docs_agent_feedback row and a metadata log line.
 * Best-effort telemetry from a public endpoint: nothing here throws or
 * rejects. The row insert runs under `waitUntil` so the response never waits
 * on it; its failure is Sentry-captured and flushed. The returned promise
 * settles with the insert.
 * The submitting agent is classified from the request's User-Agent
 * (Accept negotiation does not apply to a JSON POST or an MCP call).
 */
export function recordFeedback(
    ctx: {
        /** Site slug — the public id logs key on. */
        siteId: string
        site: DocsSite
        versionId: string | null
        source: Pick<SiteSource, "getPage">
    },
    request: Request,
    input: FeedbackInput,
): Promise<void> {
    const exists = pageExists(ctx, input.url)
    const agent = classifyAgent(request.headers.get("user-agent") ?? "", false)
    // Async IIFE: the db client resolves lazily and may throw synchronously
    // (no DATABASE_URL); that must land in the catch below, not the caller.
    const persisted = (async () => {
        // A host naming no site serves the placeholder (source.ts
        // emptySite), whose empty id no docs_site row carries.
        if (ctx.site.id === "") return
        // A public, unauthenticated write: rows are admitted per visitor and
        // per site (the shared Postgres limiter the Ask-AI chat uses), and
        // a submission over the limit is dropped — feedback is best-effort,
        // so the caller still sees it accepted. The visitor is the caller's
        // address — the extension's answer, else Vercel's forwarded-for —
        // hashed.
        const visitorIp =
            extensions.clientIp?.(request) ||
            request.headers
                .get("x-vercel-forwarded-for")
                ?.split(",")[0]
                ?.trim() ||
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            "unknown"
        const visitor = createHash("sha256")
            .update(
                `docs-feedback:${frameworkEnv.SITE_SECRET ?? resolveEnv().DATABASE_URL}:${visitorIp}`,
            )
            .digest("hex")
            .slice(0, 32)
        const siteKey = `docs_feedback:${extensions.rateLimitScope?.(ctx.site) ?? ctx.site.id}`
        // Behind its owner's proxy every caller has the proxy's address:
        // there the site's daily ceiling alone applies.
        const visitorLimits = siteScope().getStore()?.sharedClientAddress
            ? []
            : [
                  {
                      bucket: "docs_feedback_visitor_10min",
                      key: `${siteKey}:${visitor}`,
                      limit: 20,
                      windowMs: TEN_MINUTES_MS,
                  },
                  {
                      bucket: "docs_feedback_visitor_day",
                      key: `${siteKey}:${visitor}`,
                      limit: 100,
                      windowMs: DAY_MS,
                  },
              ]
        const admitted = await enforceRateLimits([
            ...visitorLimits,
            {
                bucket: "docs_feedback_site_day",
                key: siteKey,
                limit: 2000,
                windowMs: DAY_MS,
            },
        ])
        if (!admitted.allowed) return
        await db.insert(schema.docsAgentFeedback).values({
            id: randomUUID(),
            siteId: ctx.site.id,
            versionId: ctx.versionId,
            pageUrl: input.url,
            pageExists: exists,
            kind: input.kind,
            source: input.source ?? "agent",
            message: input.message ?? null,
            suggestedFix: input.suggestedFix ?? null,
            answerId: input.answerId ?? null,
            agentName: agent.agentName?.slice(0, 255) ?? null,
            agentKind: agent.agentKind,
        })
    })().catch(async (error: unknown) => {
        Sentry.captureException(error)
        await Sentry.flush(2000)
    })
    waitUntil(persisted)
    // Metadata only — message/suggestedFix are agent-authored free text, the
    // same class of input the feedback route's PostHog event only ships when
    // agentConfig.observability.includeInputs is on. Platform logs shouldn't
    // be the unredacted exception, so they get lengths, not content.
    console.log(
        "[agent-feedback]",
        JSON.stringify({
            url: input.url,
            kind: input.kind,
            messageLength: input.message?.length ?? 0,
            suggestedFixLength: input.suggestedFix?.length ?? 0,
            site: ctx.siteId,
            pageExists: exists,
            answerId: input.answerId ?? null,
        }),
    )

    return persisted
}
