// Zod-free by contract: client components import from here so they never
// bundle a schema module.

/**
 * The vendor-prefixed key that carries this framework's extensions to
 * docs.json (and the per-page version keys in meta.json). Lives
 * here, zod-free, so browser chrome can read config extensions.
 */
export const CONFIG_EXTENSION_KEY = "x-margin"

/** Lifecycle of a docs site row. Backs the docs_site_status enum. */
export const DOCS_SITE_STATUSES = [
    "provisioning",
    "active",
    "suspended",
] as const

/**
 * PostHog feature flag key for the experimental WebMCP tools. An operator
 * rollout targets it by site group in the PostHog project the server
 * reports to.
 */
export const WEBMCP_FEATURE_FLAG = "webmcp"

/**
 * What a docs reader or agent can say about a page (`POST
 * /api/agent/feedback`). helpful/not_helpful are the thumbs widgets; the
 * rest are agent-authored reports. Backs the docs_agent_feedback_kind
 * enum — append only.
 */
export const DOCS_AGENT_FEEDBACK_KINDS = [
    "incorrect",
    "missing",
    "outdated",
    "unclear",
    "other",
    "helpful",
    "not_helpful",
] as const
export type DocsAgentFeedbackKind = (typeof DOCS_AGENT_FEEDBACK_KINDS)[number]

/**
 * Who submitted docs feedback: the page thumbs widget, the Assistant's
 * answer thumbs, an agent over HTTP, or an agent through the docs MCP
 * server. Self-reported — it labels traffic, it does not authenticate it.
 */
export const DOCS_AGENT_FEEDBACK_SOURCES = [
    "page_widget",
    "chat_answer",
    "agent",
    "mcp",
] as const
export type DocsAgentFeedbackSource =
    (typeof DOCS_AGENT_FEEDBACK_SOURCES)[number]
