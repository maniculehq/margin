import { createHash } from "node:crypto"
import { parse as parseYaml } from "yaml"
import type { Diagnostic } from "../types/docs"
import {
    type DocsSkillFrontmatter,
    docsSkillFrontmatterSchema,
} from "../types/docs-agent"
import type { DocsSnapshotFile } from "./compile"

export interface CompiledDocsSkill {
    name: string
    description: string
    frontmatter: DocsSkillFrontmatter
    /** The SKILL.md exactly as authored, frontmatter included. */
    body: string
    /** `sha256:<hex>` over the UTF-8 bytes of `body`. */
    digest: string
    /** Source path within the docs root — diagnostics only. */
    path: string
}

/** Rows over this go to blob storage by the storage rules; a SKILL.md that
 * large is not a skill, so it is skipped instead. */
const MAX_SKILL_BYTES = 1024 * 1024

/**
 * Where authored Agent Skills live, highest precedence first:
 * `.mintlify/skills/<name>/SKILL.md`, a top-level `skills/<name>/SKILL.md`,
 * then a root `SKILL.md`/`skill.md` (named by its frontmatter). These files
 * are skills, not pages — compileDocs keeps them out of the page set.
 */
export function isSkillPath(path: string): boolean {
    return skillLocation(path) !== null
}

function skillLocation(
    path: string,
): { rank: number; directoryName: string | null } | null {
    const mintlify = /^\.mintlify\/skills\/([^/]+)\/SKILL\.md$/.exec(path)
    if (mintlify?.[1]) return { rank: 0, directoryName: mintlify[1] }
    const skills = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)
    if (skills?.[1]) return { rank: 1, directoryName: skills[1] }
    if (path === "SKILL.md") return { rank: 2, directoryName: null }
    if (path === "skill.md") return { rank: 3, directoryName: null }
    return null
}

/**
 * Discover and validate the snapshot's authored skills
 * (https://agentskills.io/specification). An invalid skill is a warning
 * diagnostic, never a failed build — the pages still publish. A name claimed
 * twice keeps the higher-precedence location.
 */
export function discoverDocsSkills(files: readonly DocsSnapshotFile[]): {
    skills: CompiledDocsSkill[]
    diagnostics: Diagnostic[]
} {
    const diagnostics: Diagnostic[] = []
    const candidates = files
        .flatMap((file) => {
            if (file.kind !== "text") return []
            const location = skillLocation(file.path)
            return location ? [{ file, ...location }] : []
        })
        .sort(
            (a, b) => a.rank - b.rank || a.file.path.localeCompare(b.file.path),
        )
    const warn = (path: string, message: string) =>
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message,
            path,
        })
    const skills: CompiledDocsSkill[] = []
    for (const { file, directoryName } of candidates) {
        const body = file.content
        if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
            warn(file.path, "Agent skill exceeds 1 MB and was skipped.")
            continue
        }
        const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body)
        if (!block) {
            warn(
                file.path,
                "Agent skill has no YAML frontmatter (name, description) and was skipped.",
            )
            continue
        }
        let raw: unknown
        try {
            raw = parseYaml(block[1] ?? "")
        } catch (error) {
            warn(
                file.path,
                `Agent skill frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)}) and was skipped.`,
            )
            continue
        }
        const parsed = docsSkillFrontmatterSchema.safeParse(raw)
        if (!parsed.success) {
            const fields = [
                ...new Set(
                    parsed.error.issues.map(
                        (issue) => issue.path.join(".") || "frontmatter",
                    ),
                ),
            ]
            warn(
                file.path,
                `Agent skill frontmatter is invalid (${fields.join(", ")}) and was skipped.`,
            )
            continue
        }
        const frontmatter = parsed.data
        if (directoryName !== null && frontmatter.name !== directoryName) {
            warn(
                file.path,
                `Agent skill name "${frontmatter.name}" must match its directory "${directoryName}"; the skill was skipped.`,
            )
            continue
        }
        if (skills.some((skill) => skill.name === frontmatter.name)) {
            warn(
                file.path,
                `Agent skill "${frontmatter.name}" is already defined by a higher-precedence file; this one was skipped.`,
            )
            continue
        }
        skills.push({
            name: frontmatter.name,
            description: frontmatter.description,
            frontmatter,
            body,
            digest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
            path: file.path,
        })
    }
    return { skills, diagnostics }
}
