import { createHash, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { db, schema } from "@/db"
import { skillsForVersion } from "@/lib/agent/skills"
import { hasDocsDb } from "./context"

const skillBody = (name: string) =>
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`

/**
 * The served SKILL.md must verify against its advertised digest: an agent
 * downloading a skill checks sha256(body) against the index entry.
 */
describe.skipIf(!hasDocsDb)("skillsForVersion", () => {
    let siteId: string
    let versionId: string

    beforeEach(async () => {
        siteId = randomUUID()
        versionId = randomUUID()
        await db.insert(schema.docsSite).values({
            id: siteId,
            slug: `skills-read-${siteId.slice(0, 8)}`,
            name: "Docs",
            analyticsMode: "off",
            status: "active",
        })
        await db.insert(schema.docsContentVersion).values({
            id: versionId,
            siteId: siteId,
            commitSha: "f".repeat(40),
            seq: 1,
            status: "ready",
            searchCorpus: new Uint8Array(0),
        })
        // Inserted out of name order: the accessor orders by name.
        for (const name of ["zeta-skill", "alpha-skill"]) {
            const body = skillBody(name)
            await db.insert(schema.docsSkill).values({
                id: randomUUID(),
                siteId: siteId,
                versionId,
                name,
                description: `The ${name} skill.`,
                frontmatter: { name, description: `The ${name} skill.` },
                body,
                digest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
            })
        }
    })

    afterEach(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
    })

    it("returns the version's skills by name with bodies that verify against their digests", async () => {
        const skills = await skillsForVersion({
            site: { id: siteId },
            versionId,
        })
        expect(skills.map((skill) => skill.name)).toEqual([
            "alpha-skill",
            "zeta-skill",
        ])
        for (const skill of skills) {
            expect(skill.body).toBe(skillBody(skill.name))
            expect(skill.digest).toBe(
                `sha256:${createHash("sha256").update(skill.body, "utf8").digest("hex")}`,
            )
        }
    })
})
