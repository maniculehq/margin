/** The request facts every telemetry event is built from: which surface a
 * path is, which paths are never recorded, and the cookieless visitor and
 * session ids. Pure and free of the framework's environment and
 * extensions, so a host that learns of a request some other way (a CDN's
 * request log) builds the same event the framework would. */

import { createHash } from "node:crypto"

/** Journey window for the deterministic $session_id (30 min, PostHog's
 *  default). */
export const SESSION_WINDOW_MS = 30 * 60 * 1000

/** Paths the analytics middleware never records: built assets, framework
 *  internals and the favicon. OPTIONS requests are skipped as well. */
export const UNTRACKED_PATH =
    /^\/(?:_margin(?:\/|$)|_build|favicon|__|_assets(?:\/|$)|_theme(?:\/|$)|og\/docs(?:\/|$))/

/** Cookieless visitor identity. 32 hex chars of sha256 — raw IP is never stored. */
export function visitorId(siteKey: string, ip: string, ua: string): string {
    return createHash("sha256")
        .update(`${siteKey}|${ip}|${ua}`)
        .digest("hex")
        .slice(0, 32)
}

/**
 * Deterministic $session_id — a valid UUIDv7 (PostHog session analytics require
 * v7): the 48-bit timestamp is the start of the visitor's 30-min bucket and the
 * remaining bits come from the visitor hash. Stateless: same visitor + bucket
 * → same id, so a journey that straddles a bucket boundary splits in two.
 */
export function sessionId(
    distinctId: string,
    now: number,
    windowMs: number,
): string {
    const bucket = now - (now % windowMs)
    const bytes = Buffer.alloc(16)
    bytes.writeUIntBE(bucket, 0, 6)
    Buffer.from(distinctId, "hex").copy(bytes, 6, 0, 10)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70 // version 7
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // RFC 9562 variant
    const hex = bytes.toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const EXACT_SURFACES: Record<string, string> = {
    "/llms.txt": "llms_txt",
    "/llms-full.txt": "llms_full",
    "/AGENTS.md": "agents_md",
    "/.well-known/AGENTS.md": "agents_md",
    "/skill.md": "skill_md",
    "/.well-known/skill.md": "skill_md",
    "/.well-known/llms-manifest.json": "discovery",
    "/.well-known/mcp.json": "mcp_manifest",
    "/.well-known/mcp": "mcp_manifest",
    "/.well-known/mcp/server-card.json": "mcp_manifest",
    "/.well-known/mcp/server-cards.json": "mcp_manifest",
    "/api/mcp/server-card": "mcp_manifest",
    "/.well-known/ai-catalog.json": "mcp_manifest",
    "/.well-known/llms.txt": "llms_txt",
    "/.well-known/llms-full.txt": "llms_full",
    "/.well-known/api-catalog": "api_catalog",
    "/.well-known/agent-skills/index.json": "skills_index",
    "/.well-known/skills/index.json": "skills_index",
    "/sitemap.xml": "sitemap_xml",
    "/sitemap.md": "sitemap_md",
    "/changes.md": "changes_md",
    "/robots.txt": "robots",
    "/manifest.webmanifest": "web_manifest",
    "/api/search": "search",
    "/api/chat": "chat",
    "/api/mcp": "mcp",
    "/api/agent/feedback": "feedback",
    "/api/agent/event": "browser_event",
}

/** Path → normalized surface name stamped on every event. */
export function surfaceOf(pathname: string): string {
    if (
        pathname.startsWith("/_assets/") ||
        pathname === "/og/docs" ||
        pathname.startsWith("/og/docs/")
    )
        return "other"
    const exact = EXACT_SURFACES[pathname]
    if (exact) return exact
    if (pathname.startsWith("/api/agent/context")) return "context_bundle"
    if (/^\/\.well-known\/(?:agent-)?skills\/[^/]+\/[^/]+$/.test(pathname))
        return "skill_md"
    // Path-scoped and split indexes (start.ts agentFilesMiddleware).
    if (pathname.endsWith("/llms.txt") || pathname.includes("/_llms/"))
        return "llms_txt"
    if (pathname.endsWith("/llms-full.txt")) return "llms_full"
    if (pathname.startsWith("/api/") || pathname.startsWith("/.well-known/"))
        return "other"
    // Docs serve at the root splat — every remaining path is a docs URL
    // (including root "/" and slugged 404s, which the splat route answers).
    // .pdf downloads are attachments, not page views — a $pageview per
    // download would inflate HTML view counts.
    if (pathname.endsWith(".pdf")) return "docs_pdf"
    // A changelog page's feed ({$}.rss.xml): a file, not a page read.
    if (pathname.endsWith(".rss.xml")) return "rss"
    return pathname.endsWith(".md") ? "docs_md" : "docs_html"
}

/** Content-fetch surfaces → emitted as $pageview so PostHog Paths works natively. */
export const PAGE_SURFACES: ReadonlySet<string> = new Set([
    "docs_html",
    "docs_md",
    "llms_txt",
    "llms_full",
    "agents_md",
    "skill_md",
    "skills_index",
    "api_catalog",
    "discovery",
    "mcp_manifest",
    "sitemap_xml",
    "sitemap_md",
    "changes_md",
    "robots",
    "rss",
    "context_bundle",
])
