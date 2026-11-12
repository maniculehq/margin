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

    it("drops a visitor's submissions past the ten-minute limit", async () => {
        const submit = (ip: string) =>
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
                new Request(
                    "https://acme.docs.test.invalid/api/agent/feedback",
                    {
                        headers: { "x-forwarded-for": ip },
                    },
                ),
                { url: "/guides/install", kind: "outdated", message: "Stale." },
            )
        await Promise.all(
            Array.from({ length: 21 }, () => submit("203.0.113.7")),
        )
        const admitted = await db
            .select({ id: schema.docsAgentFeedback.id })
            .from(schema.docsAgentFeedback)
            .where(eq(schema.docsAgentFeedback.siteId, siteId))
        expect(admitted).toHaveLength(20)
        // Another visitor on the same site is still admitted.
        await submit("203.0.113.8")
        const rows = await db
            .select({ id: schema.docsAgentFeedback.id })
            .from(schema.docsAgentFeedback)
            .where(eq(schema.docsAgentFeedback.siteId, siteId))
        expect(rows).toHaveLength(21)
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
