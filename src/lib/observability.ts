/** Shared PostHog agent-journey analytics. The request path only queues work
 * with `waitUntil`; classification, hashing, and delivery run afterward, so
 * analytics cannot affect the response. Identity hashes site/IP/UA; raw IP
 * never leaves the function. Hosts extend events through the extension's
 * telemetry hooks (extra properties, PostHog groups, an event tap). */

import { createHash } from "node:crypto"
import { waitUntil } from "@vercel/functions"
import { PostHog } from "posthog-node"
import { extensions } from "#docs-extensions"
import type { DocsSite, SiteResolution } from "@/extensions/types"
import { aiReferral, browserCheck } from "@/types/traffic"
import { env } from "../env"
import { type AgentEvent, agentConfig } from "./agent.config"
import { wantsMarkdown } from "./agent-content"
import { requestTraffic } from "./traffic"

declare global {
    var __frameworkPostHogClient: PostHog | undefined
}

/** Groups already groupIdentify-ed this cold start (metadata, not correctness). */
const identifiedGroups = new Set<string>()

function posthogClient(): PostHog | undefined {
    const { posthogKey, posthogHost } = agentConfig.observability
    if (posthogKey === "") return undefined
    globalThis.__frameworkPostHogClient ??= new PostHog(posthogKey, {
        host: posthogHost,
        // The function's IP would geolocate every agent to the datacenter.
        disableGeoip: true,
        // Only *Immediate sends are used (no queue/flush timer). Keep a PostHog
        // outage from pinning waitUntil work: one 3s attempt, no retries —
        // dropped events over ~50s of billed background retrying per request.
        requestTimeout: 3_000,
        fetchRetryCount: 0,
    })
    return globalThis.__frameworkPostHogClient
}

/**
 * Whether a site's pages register the WebMCP tools: the site row's own
 * opt-in, or a host's operator rollout (`webmcpRollout`, which must answer from
 * cache and never block the loader that calls this).
 */
export function webmcpEnabled(site: DocsSite): boolean {
    return (
        site.webmcpEnabled ||
        extensions.webmcpRollout?.(site, posthogClient()) === true
    )
}

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
 * → same id; the HogQL query in the header comment is the precise fallback for
 * journeys that straddle a bucket boundary.
 */
export function sessionId(distinctId: string, now: number): string {
    const windowMs = agentConfig.observability.sessionWindowMs
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
    "context_bundle",
])

/** Plain strings captured on the hot path — the Request itself is never retained. */
interface RequestSnapshot {
    url: string
    host: string | null
    ua: string
    referer: string | null
    ip: string
    /** Every header as plain pairs, for the extension's telemetry hooks. */
    headers: [string, string][]
    now: number
}

/**
 * HOT PATH — the only work before the response: read header strings, note the
 * time, enqueue deliver() via waitUntil (no-op-safe outside Vercel). Never throws.
 */
export function emitEvent(request: Request, event: AgentEvent): void {
    try {
        if (!agentConfig.observability.enabled) return
        // The build-time prerender crawl runs through the real handler; skip it.
        if (request.headers.get("x-prerender")) return
        const snapshot: RequestSnapshot = {
            url: request.url,
            host: request.headers.get("host"),
            ua: request.headers.get("user-agent") ?? "",
            referer: request.headers.get("referer"),
            ip:
                request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                request.headers.get("x-real-ip") ||
                request.headers.get("x-vercel-forwarded-for") ||
                "0.0.0.0",
            headers: [...request.headers],
            now: Date.now(),
        }
        waitUntil(deliver(snapshot, event).catch(() => undefined))
    } catch {
        // Analytics never fails a request.
    }
}

async function deliver(
    snapshot: RequestSnapshot,
    event: AgentEvent,
): Promise<void> {
    // Yield to a macrotask first so nothing below shares the request's turn.
    await new Promise((resolve) => setImmediate(resolve))

    const url = new URL(snapshot.url)
    const lowered = (snapshot.host ?? "").toLowerCase()
    // Bracket-aware port strip: "[::1]:3000" → "[::1]", "a.com:443" → "a.com".
    const host =
        (lowered.startsWith("[")
            ? lowered.slice(0, lowered.indexOf("]") + 1)
            : lowered.split(":")[0]) || "unknown"
    // A bodiless rebuild of the request: the extension resolves the site
    // from it (memoized, post-response) and its telemetry hooks read it;
    // negotiation reads its Accept.
    const request = new Request(snapshot.url, { headers: snapshot.headers })
    const resolution: SiteResolution | null = await extensions
        .resolveSite(request)
        .catch(() => null)
    const siteKey =
        extensions.telemetry.visitorKey?.(request, resolution) ??
        resolution?.site?.slug ??
        host
    const acceptsMarkdown = wantsMarkdown(request)
    // Who is asking (human, crawler, agent or other automation), and for a
    // human, the AI product whose answer sent them. Reports read both back
    // over HogQL. Only the referrer's host is kept.
    const traffic = await requestTraffic(
        request,
        resolution?.sharedClientAddress ?? false,
    )
    const referral = aiReferral({
        referer: snapshot.referer,
        requestPath: `${url.pathname}${url.search}`,
    })
    const referringDomain =
        snapshot.referer && URL.canParse(snapshot.referer)
            ? new URL(snapshot.referer).hostname.toLowerCase()
            : null
    const distinctId = visitorId(siteKey, snapshot.ip, snapshot.ua)

    const { type, ...rest } = event
    const properties = {
        ...rest,
        $session_id: sessionId(distinctId, snapshot.now),
        // Query strings are inputs (?query=..., tokens): they ride along only
        // when includeInputs is on, same gate as tool args and search terms.
        $current_url: `${url.protocol}//${host}${url.pathname}${
            agentConfig.observability.includeInputs ? url.search : ""
        }`,
        $host: host,
        $pathname: url.pathname,
        $raw_user_agent: snapshot.ua,
        site_id: resolution?.site?.slug ?? null,
        traffic_category: traffic.category,
        traffic_kind: traffic.kind,
        traffic_id: traffic.id,
        traffic_name: traffic.name,
        traffic_operator: traffic.operator,
        traffic_verified: traffic.verified,
        traffic_signal: traffic.signal,
        // Recorded, not yet counted: whether a browser user agent's headers
        // look like a browser's (types/traffic.ts browserCheck).
        browser_check: browserCheck(snapshot.ua, (name) =>
            request.headers.get(name),
        ),
        ai_referral_platform: referral?.platform ?? null,
        ai_referral_detection: referral?.detection ?? null,
        // The one header besides the user agent that classification reads,
        // kept so a later rule change can be applied to stored events.
        accept_header: request.headers.get("accept")?.slice(0, 256) ?? null,
        classification_version: 2,
        $referring_domain: referringDomain,
        environment:
            resolution?.preview || env.VERCEL_ENV !== "production"
                ? "preview"
                : "production",
        surface:
            typeof rest.surface === "string"
                ? rest.surface
                : surfaceOf(url.pathname),
        // The llmMiddleware answered a docs URL (not a .md path) with
        // markdown inline: a 200 whose content type is text/markdown on a
        // path that did not ask for it by suffix.
        ...(rest.status === 200 &&
        typeof rest.content_type === "string" &&
        rest.content_type.includes("text/markdown") &&
        !url.pathname.endsWith(".md") &&
        surfaceOf(url.pathname) === "docs_html"
            ? { markdown_negotiated: acceptsMarkdown }
            : {}),
        ...extensions.telemetry.eventProperties?.(request, resolution),
    }

    try {
        extensions.telemetry.onEvent?.({ type, ...properties })
    } catch {
        // A throwing tap must not cost the PostHog capture below.
    }

    const client = posthogClient()
    if (!client) return
    const group = extensions.telemetry.groups?.(resolution, request) ?? null
    const groupId = group ? `${group.groupType}:${group.groupKey}` : null
    if (group && groupId && !identifiedGroups.has(groupId)) {
        // Mark identified only on success so a transient failure retries on
        // the group's next event instead of being suppressed for the whole
        // warm instance.
        await client
            .groupIdentifyImmediate({
                groupType: group.groupType,
                groupKey: group.groupKey,
                properties: group.properties,
            })
            .then(() => identifiedGroups.add(groupId))
            .catch(() => undefined)
    }
    // The Immediate variant awaits the actual send: plain capture() enqueues
    // behind an internal promise, so a flush() right after it races the enqueue
    // and ships nothing until flushInterval. Awaiting here is fine — deliver
    // already runs post-response inside waitUntil.
    await client.captureImmediate({
        distinctId,
        event: type,
        properties,
        ...(group ? { groups: { [group.groupType]: group.groupKey } } : {}),
        timestamp: new Date(snapshot.now),
    })
}
