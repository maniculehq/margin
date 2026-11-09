import { and, asc, eq } from "drizzle-orm"
import { LRUCache } from "lru-cache"
import { db, schema } from "@/db"
import { type DocsSkill, docsSkillSchema } from "@/types/docs-agent"

/** One authored Agent Skill of a content version, as stored at ingest. */
export type DocsSkillRow = DocsSkill

/**
 * A version's skills are immutable, so the rows are memoized per version
 * like source.ts's per-version memos: `fetchMethod` coalesces concurrent
 * cold reads and drops a rejected read so the next request retries.
 */
const versionSkills = new LRUCache<
    string,
    DocsSkillRow[],
    { siteId: string; versionId: string }
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: { siteId, versionId } }) => {
        const rows = await db
            .select({
                name: schema.docsSkill.name,
                description: schema.docsSkill.description,
                frontmatter: schema.docsSkill.frontmatter,
                body: schema.docsSkill.body,
                digest: schema.docsSkill.digest,
            })
            .from(schema.docsSkill)
            .where(
                and(
                    eq(schema.docsSkill.versionId, versionId),
                    eq(schema.docsSkill.siteId, siteId),
                ),
            )
            .orderBy(asc(schema.docsSkill.name))
        return rows.map((row) => docsSkillSchema.parse(row))
    },
})

/**
 * Authored Agent Skills (https://agentskills.io) for one content version,
 * ordered by name. src/ingest/skills.ts validates them at ingest; body is the
 * exact SKILL.md bytes and digest is sha256:<hex> over them. A plain row read.
 */
export async function skillsForVersion(ctx: {
    site: { id: string }
    versionId: string | null
}): Promise<DocsSkillRow[]> {
    if (!ctx.versionId) return []
    const rows = await versionSkills.fetch(`${ctx.site.id}:${ctx.versionId}`, {
        context: { siteId: ctx.site.id, versionId: ctx.versionId },
    })
    return rows ?? []
}
