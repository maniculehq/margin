import { z } from "zod"
import {
    DOCS_AGENT_FEEDBACK_KINDS,
    DOCS_AGENT_FEEDBACK_SOURCES,
} from "./constants"

/**
 * Agent Skill name (https://agentskills.io/specification): 1-64 lowercase
 * alphanumerics and single hyphens, never leading, trailing or doubled.
 */
export const DOCS_SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * SKILL.md frontmatter: the agentskills.io fields plus Mintlify's `groups`
 * and `public` extensions. Unknown keys are kept (passthrough) — the stored
 * frontmatter is what the author wrote, and serving hands back the exact
 * body bytes anyway.
 */
export const docsSkillFrontmatterSchema = z
    .object({
        name: z.string().min(1).max(64).regex(DOCS_SKILL_NAME_PATTERN),
        description: z.string().min(1).max(1024),
        license: z.string().optional(),
        compatibility: z.string().min(1).max(500).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        "allowed-tools": z.string().optional(),
        groups: z.array(z.string()).optional(),
        public: z.boolean().optional(),
    })
    .passthrough()
export type DocsSkillFrontmatter = z.infer<typeof docsSkillFrontmatterSchema>

/** `sha256:<64 lowercase hex>` over the exact UTF-8 bytes of a SKILL.md. */
export const docsSkillDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const docsSkillSchema = z.object({
    name: z.string(),
    description: z.string(),
    frontmatter: docsSkillFrontmatterSchema,
    body: z.string(),
    digest: docsSkillDigestSchema,
})
export type DocsSkill = z.infer<typeof docsSkillSchema>

/** GET /api/orgs/:orgId/docs-skills — the served version's skills. */
export const docsSkillsResponseSchema = z.object({
    versionId: z.string().nullable(),
    skills: z.array(docsSkillSchema),
})
export type DocsSkillsResponse = z.infer<typeof docsSkillsResponseSchema>

export const docsAgentFeedbackSchema = z.object({
    id: z.string(),
    createdAt: z.string(),
    pageUrl: z.string(),
    pageExists: z.boolean(),
    kind: z.enum(DOCS_AGENT_FEEDBACK_KINDS),
    source: z.enum(DOCS_AGENT_FEEDBACK_SOURCES),
    message: z.string().nullable(),
    suggestedFix: z.string().nullable(),
    agentName: z.string().nullable(),
    agentKind: z.string().nullable(),
})
export type DocsAgentFeedback = z.infer<typeof docsAgentFeedbackSchema>

export const docsAgentFeedbackQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque keyset from the previous page's `nextCursor`:
     *  `<microsecond createdAt>|<id>`. */
    cursor: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\|.{1,36}$/)
        // A real calendar instant (round-trips through Date unchanged), or
        // Postgres's timestamp cast fails at query time instead of here.
        .refine((cursor) => {
            const instant = new Date(`${cursor.slice(0, 19)}Z`)
            return (
                !Number.isNaN(instant.getTime()) &&
                instant.toISOString().slice(0, 19) === cursor.slice(0, 19)
            )
        }, "cursor must be a previous page's cursor")
        .optional(),
})

/** GET /api/orgs/:orgId/docs-agent-feedback — newest first, keyset paged. */
export const docsAgentFeedbackResponseSchema = z.object({
    feedback: z.array(docsAgentFeedbackSchema),
    /** Pass back as `cursor` for the next (older) page; null on the last. */
    nextCursor: z.string().nullable(),
})
export type DocsAgentFeedbackResponse = z.infer<
    typeof docsAgentFeedbackResponseSchema
>
