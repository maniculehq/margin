import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, schema } from "@/db"
import { recordFeedback } from "@/lib/agent-feedback"
import { hasDocsDb } from "./context"

/** Sentry is the telemetry boundary; a failed insert reports through it. */
const sentryExceptions = vi.hoisted((): unknown[] => [])
vi.mock("@sentry/tanstackstart-react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@sentry/tanstackstart-react")>()),
    captureException: (error: unknown) => {
        sentryExceptions.push(error)
        return "event-id"
    },
}))

/**
 * Submitted feedback is stored in docs_agent_feedback under the site's
 * database id (not its public slug), with the claimed source and the
 * User-Agent's agent classification.
 */
describe.skipIf(!hasDocsDb)("recordFeedback → docs_agent_feedback", () => {
    let siteId: string

    beforeEach(async () => {
        sentryExceptions.length = 0
        siteId = randomUUID()
        await db.insert(schema.docsSite).values({
            id: siteId,
            slug: `feedback-${siteId.slice(0, 8)}`,
            name: "Docs",
            analyticsMode: "off",
            status: "active",
        })
    })

    afterEach(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
    })

    it("persists the submission with the agent's classification", async () => {
        await recordFeedback(
            {
                siteId: "acme",
                site: {
                    id: siteId,
                    slug: "acme",
                    name: "Acme",
                    description: "",
                    repo: null,
                    analyticsEnabled: true,
                    webmcpEnabled: false,
                },
                versionId: null,
                source: { getPage: () => undefined },
            },
            new Request("https://acme.docs.test.invalid/api/agent/feedback", {
                headers: {
                    "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
                },
            }),
            {
                url: "/guides/install",
                kind: "outdated",
                message: "Step 2 references the old CLI.",
                suggestedFix: "Use `acme deploy`.",
                source: "mcp",
            },
        )
        const rows = await db
            .select()
            .from(schema.docsAgentFeedback)
            .where(eq(schema.docsAgentFeedback.siteId, siteId))
        expect(rows).toEqual([
            expect.objectContaining({
                versionId: null,
                pageUrl: "/guides/install",
                pageExists: false,
                kind: "outdated",
                source: "mcp",
                message: "Step 2 references the old CLI.",
                suggestedFix: "Use `acme deploy`.",
                answerId: null,
                agentName: "claudebot",
                agentKind: "training",
            }),
        ])
    })

    it("stores the answer a chat-answer thumb rates", async () => {
        const answerId = randomUUID()
        await recordFeedback(
            {
                siteId: "acme",
                site: {
                    id: siteId,
                    slug: "acme",
                    name: "Acme",
                    description: "",
                    repo: null,
                    analyticsEnabled: true,
                    webmcpEnabled: false,
                },
                versionId: null,
                source: { getPage: () => undefined },
            },
            new Request("https://acme.docs.test.invalid/api/agent/feedback"),
            {
                url: "/guides/install",
                kind: "not_helpful",
                source: "chat_answer",
                answerId,
            },
        )
        const rows = await db
            .select({ answerId: schema.docsAgentFeedback.answerId })
            .from(schema.docsAgentFeedback)
            .where(eq(schema.docsAgentFeedback.siteId, siteId))
        expect(rows).toEqual([{ answerId }])
    })

    const submitFrom = (ip: string) =>
        recordFeedback(
            {
                siteId: "acme",
                site: {
                    id: siteId,
                    slug: "acme",
                    name: "Acme",
                    description: "",
                    repo: null,
                    analyticsEnabled: true,
                    webmcpEnabled: false,
                },
                versionId: null,
                source: { getPage: () => undefined },
            },
            new Request("https://acme.docs.test.invalid/api/agent/feedback", {
                headers: { "x-forwarded-for": ip },
            }),
            { url: "/guides/install", kind: "outdated", message: "Stale." },
        )
    const storedRows = () =>
        db
            .select({ id: schema.docsAgentFeedback.id })
            .from(schema.docsAgentFeedback)
            .where(eq(schema.docsAgentFeedback.siteId, siteId))

    // The old per-visitor limit dropped the 21st submission in ten minutes.
    it("stores one caller's submissions past the old per-visitor limit", async () => {
        await Promise.all(
            Array.from({ length: 21 }, () => submitFrom("203.0.113.7")),
        )
        expect(await storedRows()).toHaveLength(21)
    })

    it("drops submissions once the site's daily ceiling is spent", async () => {
        await submitFrom("203.0.113.7")
        expect(await storedRows()).toHaveLength(1)
        await db
            .update(schema.publicRateLimit)
            .set({ count: 2000 })
            .where(eq(schema.publicRateLimit.key, `docs_feedback:${siteId}`))

        await submitFrom("203.0.113.8")

        expect(await storedRows()).toHaveLength(1)
    })

    // A host naming no site serves the placeholder site, whose empty id
    // failed the site foreign key and paged Sentry on every submission.
    it("drops feedback for the placeholder site without reporting", async () => {
        await recordFeedback(
            {
                siteId: "unknown",
                site: {
                    id: "",
                    slug: "unknown",
                    name: "Docs",
                    description: "",
                    repo: null,
                    analyticsEnabled: true,
                    webmcpEnabled: false,
                },
                versionId: null,
                source: { getPage: () => undefined },
            },
            new Request("https://unknown.docs.test.invalid/api/agent/feedback"),
            { url: "/guides/install", kind: "outdated", message: "Stale." },
        )

        expect(sentryExceptions).toEqual([])
    })
})
