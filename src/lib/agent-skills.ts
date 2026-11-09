import { createHash } from "node:crypto"
import { skillsForVersion } from "./agent/skills"
import { renderSkill } from "./agent-skill"
import type { DocsContext } from "./source"

/** One served Agent Skill: the exact SKILL.md bytes and their digest. */
export interface ServedSkill {
    name: string
    description: string
    body: string
    /** `sha256:<64 lowercase hex>` over the UTF-8 bytes of `body`. */
    digest: string
    origin: "authored" | "generated"
}

/**
 * The generated skill every site has: how to use these docs as an agent,
 * as an agentskills.io SKILL.md. Its name is the site slug made spec-safe;
 * its links are absolute for the requesting host, so the digest is per host
 * (the CDN keys the index per host too).
 */
export function generatedSkill(ctx: DocsContext, origin: string): ServedSkill {
    const name =
        ctx.site.slug
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 52)
            .replace(/-+$/, "") || "docs"
    const skillName = `${name}-docs`
    const description = `Use the ${ctx.identity.name} documentation: find the right page, read it as clean markdown, search it, and call its MCP server. Use when a task involves ${ctx.identity.name}.`
    const body = [
        "---",
        `name: ${skillName}`,
        // JSON string literals are valid YAML double-quoted scalars, so any
        // site name round-trips without a YAML emitter.
        `description: ${JSON.stringify(description.slice(0, 1024))}`,
        "---",
        "",
        renderSkill(origin, ctx),
    ].join("\n")
    return {
        name: skillName,
        description,
        body,
        digest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
        origin: "generated",
    }
}

/**
 * The skills a site serves: the site's authored SKILL.md files when it has
 * any (they replace the generated one), else the generated
 * guide. A skill restricted to reader `groups` is never served — this
 * framework has no reader sign-in to check membership against — unless it
 * is explicitly `public: true`.
 */
export async function skillCatalog(
    ctx: DocsContext,
    origin: string,
): Promise<ServedSkill[]> {
    const authored = (await skillsForVersion(ctx))
        .filter(
            (skill) =>
                !skill.frontmatter.groups?.length ||
                skill.frontmatter.public === true,
        )
        .map(
            (skill): ServedSkill => ({
                name: skill.name,
                description: skill.description,
                body: skill.body,
                digest: skill.digest,
                origin: "authored",
            }),
        )
    return authored.length > 0 ? authored : [generatedSkill(ctx, origin)]
}

/**
 * `/skill.md`: the generated guide, plus — when the site authored its own
 * skills — a list of them with the one-line install. Served directly rather
 * than redirecting to the index, so an agent that fetched it already has
 * usable instructions.
 */
export async function skillDocument(
    ctx: DocsContext,
    origin: string,
): Promise<string> {
    const generated = generatedSkill(ctx, origin)
    const authored = (await skillCatalog(ctx, origin)).filter(
        (skill) => skill.origin === "authored",
    )
    if (authored.length === 0) return generated.body
    return [
        generated.body,
        "## Skills",
        "",
        ...authored.map(
            (skill) =>
                `- [${skill.name}](${origin}/.well-known/agent-skills/${skill.name}/SKILL.md): ${skill.description}`,
        ),
        "",
        `Install them all: \`npx skills add ${origin}\``,
        "",
    ].join("\n")
}

/**
 * Agent Skills discovery (https://github.com/cloudflare/agent-skills-discovery-rfc):
 * the v0.2.0 index at `/.well-known/agent-skills/index.json`, with each
 * digest over the exact bytes the skill URL serves, or the legacy v0.1.0
 * `/.well-known/skills/index.json` older clients probe.
 */
export function skillsIndexBody(
    skills: ServedSkill[],
    origin: string,
    format: "v0.2.0" | "legacy",
) {
    return format === "v0.2.0"
        ? {
              $schema:
                  "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
              skills: skills.map((skill) => ({
                  name: skill.name,
                  type: "skill-md",
                  description: skill.description.slice(0, 1024),
                  url: `${origin}/.well-known/agent-skills/${skill.name}/SKILL.md`,
                  digest: skill.digest,
              })),
          }
        : {
              skills: skills.map((skill) => ({
                  name: skill.name,
                  description: skill.description.slice(0, 1024),
                  files: ["SKILL.md"],
              })),
          }
}

/** One skill's SKILL.md (any case of the file name), or 404. */
export function skillFileResponse(
    skills: ServedSkill[],
    name: string,
    file: string,
    cacheHeader: string,
): Response {
    const skill = skills.find((s) => s.name === name)
    if (!skill || file.toLowerCase() !== "skill.md")
        return new Response("Not Found", { status: 404 })
    return new Response(skill.body, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "X-Robots-Tag": "noindex",
            "Cache-Control": cacheHeader,
        },
    })
}
