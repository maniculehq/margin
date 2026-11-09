import { agentConfig } from "./agent.config"
import {
    orderedPages,
    siteInstructionsBlock,
    slugsToMarkdownPath,
} from "./agent-content"
import type { DocsContext } from "./source"

function mdLink(
    origin: string,
    page: ReturnType<typeof orderedPages>[number],
    sep: string,
): string {
    const url = origin + slugsToMarkdownPath(page.slugs).url
    const desc = page.data.description ? `${sep}${page.data.description}` : ""
    return `- [${page.data.pageTitle}](${url})${desc}`
}

/** /skill.md — concise "how to use these docs as an agent" guide. No self-promotion. */
export function renderSkill(origin: string, ctx: DocsContext): string {
    const pages = orderedPages(ctx)
    return [
        `# ${ctx.identity.name} — agent guide`,
        "",
        "These docs are built for AI agents. Prefer clean markdown over HTML:",
        "",
        `- Append \`.md\` to any docs URL (e.g. \`${origin}${agentConfig.docsRoute}/<slug>.md\`), or send \`Accept: text/markdown\`.`,
        `- Discover every machine surface: \`${origin}${agentConfig.discovery.manifestPath}\``,
        `- Page index: \`${origin}/llms.txt\` · full corpus: \`${origin}/llms-full.txt\``,
        `- Search: \`${origin}/api/search?query=...\` · one-fetch page bundle: \`${origin}/api/agent/context/<slug>\``,
        `- MCP server (streamable-http): \`${origin}/api/mcp\``,
        "",
        "## Start here",
        "",
        ...pages.slice(0, 5).map((p) => mdLink(origin, p, " — ")),
        siteInstructionsBlock(ctx),
        "",
    ].join("\n")
}

/** /AGENTS.md — a medium-depth page index with .md links. */
export function renderAgents(origin: string, ctx: DocsContext): string {
    return [
        `# ${ctx.identity.name}`,
        "",
        "Documentation index for coding agents — each link returns clean markdown.",
        "",
        ...orderedPages(ctx).map((p) => mdLink(origin, p, ": ")),
        "",
        `Machine-readable manifest: ${origin}${agentConfig.discovery.manifestPath}`,
        siteInstructionsBlock(ctx),
        "",
    ].join("\n")
}

export function agentDocResponse(body: string): Response {
    return new Response(body, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "X-Robots-Tag": "noindex",
            "Cache-Control": agentConfig.cache.header,
        },
    })
}
