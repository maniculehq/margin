import { env } from "../env"
import { CONFIG_EXTENSION_KEY, type DocsAgents } from "../types/docs"
import { TRAFFIC_ENTRIES } from "../types/traffic"
import { appName, docsRoute } from "./shared"

/** A single agent-surface telemetry event (see src/lib/observability.ts). */
export interface AgentEvent {
    type: string
    route?: string
    tool?: string
    durationMs?: number
    [key: string]: unknown
}

/** The AI crawlers and assistants robots.txt names. The wildcard group
 * already allows them; a named group documents intent, survives stricter
 * default-deny tooling, and carries the site's Content-Signal to crawlers
 * that read only their own group. `Google-Extended` and `Applebot-Extended`
 * are robots.txt tokens only and never appear in a request. */
export const ROBOTS_AGENT_TOKENS = [
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "ClaudeBot",
    "Claude-User",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
] as const

/**
 * THE single source of truth for the agent surface. Every discovery / manifest /
 * skill / sitemap / MCP route reads enabled-flags, budgets, names, and origin
 * from here — nothing is hardcoded or duplicated elsewhere.
 */
export const agentConfig = {
    /** Absolute origin for sitemap / JSON-LD / manifest (`SITE_ORIGIN`). */
    siteOrigin: env.SITE_ORIGIN,
    appName,
    docsRoute,
    /** Vercel AI Gateway model slug for the Ask-AI chat route (api.chat.ts). */
    agentModel: env.DOCS_CHAT_MODEL,

    /**
     * CAP EVERYTHING: llms-full would otherwise be an unbounded dump. 4M
     * chars (~1M tokens) fits a whole large-site corpus — the old 600k
     * cap truncated a mirrored site mid-way — while the route streams
     * pages as they assemble, so the cap bounds memory, not time-to-first-byte.
     */
    llmsFull: {
        maxChars: 4_000_000,
        truncationMarker:
            "\n\n<!-- llms-full.txt truncated: byte budget reached. Fetch individual /<slug>.md pages for the rest. -->\n",
    },

    /**
     * Freshness knobs: an hour-long s-maxage — content is immutable per
     * version, and a host that publishes content outside a deploy purges the
     * site's `Vercel-Cache-Tag` (start.ts cacheTagMiddleware), so freshness
     * normally comes from the deploy or the purge; a 60 s TTL forced a cold
     * SSR (~1 s TTFB) every minute per page for nothing. A purge is
     * best-effort, so the TTL stays bounded at an hour as the
     * self-correcting fallback. The SWR window keeps the CDN serving
     * instantly while it revalidates in the background.
     * Vercel keys its CDN cache by host, so each host's responses cache
     * independently. CDN-cached repeats within s-maxage never invoke the
     * function and are invisible to observability.ts — resolved in favor of
     * perf.
     */
    cache: {
        swrSeconds: 3_600,
        swrWindowSeconds: 86_400,
        /** The one Cache-Control every cacheable surface emits. */
        header: "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },

    /**
     * REACHABILITY-ACCURATE: a surface is advertised in the discovery manifest
     * only when its flag is true AND a live content check passes. Flip these to
     * true as each surface lands.
     */
    surfaces: {
        markdown: true, // /{$}.md
        llms: true, // /llms.txt
        llmsFull: true, // /llms-full.txt (capped)
        search: true, // /api/search
        contextBundle: true, // /api/agent/context
        mcp: true, // /api/mcp
        sitemap: true, // /sitemap.{xml,md}
        changes: true, // /changes.md
        feedback: true, // /api/agent/feedback
        skill: true, // /skill.md, /AGENTS.md
        // Browser-side WebMCP tools registered on docs pages. Not an
        // HTTP surface: never advertised in the discovery manifest.
        webmcp: true,
    },

    /** Per-page agent signals injected through getLLMText. */
    signals: {
        readingTime: true,
        tokens: true,
        related: true,
        freshness: true,
    },

    /**
     * Agent-journeys analytics (observability.ts). Extremely light and never
     * blocking by design: the request path only snapshots header strings and
     * defers ALL work (classification, hashing, PostHog capture/flush) past the
     * response via waitUntil. Failures are swallowed — analytics can never slow
     * or fail a request.
     */
    observability: {
        /** Master switch. Without POSTHOG_KEY nothing is captured either way. */
        enabled: true,
        /** NEVER true without the central redactor — it would forward agent prompts. */
        includeInputs: false,
        /**
         * The PostHog project agent journeys go to (a public write-only key).
         * Unset — the default — captures nothing; the escape-hatch event tap
         * lives on the extension (`telemetry.onEvent`).
         */
        posthogKey: env.POSTHOG_KEY ?? "",
        /** Server-side capture goes direct — the browser ad-block proxy is unnecessary here. */
        posthogHost: env.POSTHOG_HOST,
        /** Journey window for the deterministic $session_id (30 min, PostHog's default). */
        sessionWindowMs: 30 * 60 * 1000,
    },

    /** Distinct (non-A2A) discovery path — avoids the /.well-known/agent.json collision. */
    discovery: {
        manifestPath: "/.well-known/llms-manifest.json",
        version: "1.0.0",
    },
}

export type AgentSurface = keyof typeof agentConfig.surfaces

/** Whether an agent surface is enabled. The manifest additionally checks for live content. */
export function isSurfaceEnabled(surface: AgentSurface): boolean {
    return agentConfig.surfaces[surface]
}

/**
 * A site's agent-surface settings (`agents` under CONFIG_EXTENSION_KEY in
 * docs.json) with
 * the framework defaults filled in: every content signal granted, the index
 * preamble on .md pages, markdown for live assistant fetchers, no YAML
 * frontmatter (the `# title (url)` header already carries the title).
 */
export function siteAgentSettings(
    config: { [CONFIG_EXTENSION_KEY]?: { agents?: DocsAgents } } | null,
) {
    const agents = config?.[CONFIG_EXTENSION_KEY]?.agents
    return {
        contentSignals: {
            search: agents?.contentSignals?.search ?? true,
            aiInput: agents?.contentSignals?.aiInput ?? true,
            aiTrain: agents?.contentSignals?.aiTrain ?? true,
        },
        indexPreamble: agents?.indexPreamble ?? true,
        assistantMarkdown: agents?.assistantMarkdown ?? true,
        markdownFrontmatter: agents?.markdownFrontmatter ?? false,
    }
}

/** The Content Signals line (https://contentsignals.org) for robots.txt and
 * the `Content-Signal` response header. */
export function contentSignalValue(
    signals: ReturnType<typeof siteAgentSettings>["contentSignals"],
): string {
    const flag = (granted: boolean) => (granted ? "yes" : "no")
    return `search=${flag(signals.search)}, ai-input=${flag(signals.aiInput)}, ai-train=${flag(signals.aiTrain)}`
}

/**
 * Agents that identify themselves (assistant and coding kinds in
 * types/traffic.ts): an AI product fetching a page because a person asked
 * right now, as opposed to a training or search crawler. These get markdown
 * without asking for it, since they hand the page to a model either way. A
 * Vercel route (vite.config.ts) rewrites them to `?__md=assistant` BEFORE
 * the CDN cache, so the markdown caches under its own key and HTML entries
 * never vary on User-Agent.
 */
export const ASSISTANT_MARKDOWN_PARAM = "__md"
export const ASSISTANT_USER_AGENT_PATTERN = TRAFFIC_ENTRIES.filter(
    (entry) =>
        entry.category === "agent" &&
        (entry.kind === "assistant" || entry.kind === "coding"),
)
    .map((entry) => entry.pattern)
    .join("|")

/** Link relation URIs for agent surfaces with no IANA-registered token
 * (RFC 8288 §2.1.2). The bare tokens existing docs sites use ride alongside. */
export const AGENT_LINK_RELATION_BASE = env.DOCS_LINK_RELATION_BASE
