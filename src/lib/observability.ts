/** Shared PostHog agent-journey analytics. The request path only queues work
 * with `waitUntil`; classification, hashing, and delivery run afterward, so
 * analytics cannot affect the response. Identity hashes site/IP/UA; raw IP
 * never leaves the function. Hosts extend events through the extension's
 * telemetry hooks (extra properties, PostHog groups, an event tap). */

import { waitUntil } from "@vercel/functions"
import { PostHog } from "posthog-node"
import { extensions } from "#docs-extensions"
import type { DocsSite, SiteResolution } from "@/extensions/types"
import {
    CLASSIFICATION_VERSION,
    sessionId,
    surfaceOf,
    visitorId,
} from "@/types/telemetry"
import {
    aiReferral,
    browserCheck,
    type TrafficClassification,
} from "@/types/traffic"
import { env } from "../env"
import { type AgentEvent, agentConfig } from "./agent.config"
import { wantsMarkdown } from "./agent-content"
import { clientAddress, requestTraffic } from "./traffic"

declare global {
    var __frameworkPostHogClient: PostHog | undefined
}

/** Groups already groupIdentify-ed this cold start (metadata, not correctness). */
const identifiedGroups = new Set<string>()

export function posthogClient(): PostHog | undefined {
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

/** Plain strings captured on the hot path — the Request itself is never retained. */
interface RequestSnapshot {
    url: string
    host: string | null
    ua: string
    referer: string | null
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
    const { type, uuid, ...rest } = event
    const surface =
        typeof rest.surface === "string"
            ? rest.surface
            : surfaceOf(url.pathname)
    // Who is asking (human, crawler, agent or other automation), and for a
    // human, the AI product whose answer sent them. Reports read both back
    // over HogQL. Only the referrer's host is kept.
    const classified = await requestTraffic(
        request,
        resolution?.sharedClientAddress ?? false,
    )
    // Since classification version 3 a person's page view is the one their
    // browser reports (docs_page_viewed): a script that sends a browser
    // user agent requests pages but runs none of their code, and a page
    // the CDN serves from cache never reaches this function. A page read by
    // a browser user agent is therefore automation unless a report counts
    // it, and a report the extension's check judged a bot is automation
    // too. Every other request keeps its own category, so a crawler or AI
    // browser that runs the page's code and reports keeps its own (the API
    // counts reports from browsers only, so it is not counted twice).
    const traffic: TrafficClassification =
        classified.category !== "human"
            ? classified
            : type === "$pageview" &&
                (surface === "docs_html" || surface === "docs_md")
              ? {
                    ...classified,
                    category: "automation",
                    kind: "unreported_browser",
                }
              : type === "docs_page_viewed" && rest.view_verdict === "bot"
                ? { ...classified, category: "automation", kind: "headless" }
                : classified
    const referral = aiReferral({
        referer: snapshot.referer,
        requestPath: `${url.pathname}${url.search}`,
    })
    const referringDomain =
        snapshot.referer && URL.canParse(snapshot.referer)
            ? new URL(snapshot.referer).hostname.toLowerCase()
            : null
    // The visitor's own address (clientAddress), read here from the rebuilt
    // request so the hot path stays header copies only.
    const distinctId = visitorId(
        siteKey,
        clientAddress(request)?.ip ?? "0.0.0.0",
        snapshot.ua,
    )

    const properties = {
        ...rest,
        $session_id: sessionId(
            distinctId,
            snapshot.now,
            agentConfig.observability.sessionWindowMs,
        ),
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
        // A diagnostic, never counted: whether a browser user agent's
        // headers look like a browser's (types/traffic.ts browserCheck).
        browser_check: browserCheck(snapshot.ua, (name) =>
            request.headers.get(name),
        ),
        ai_referral_platform: referral?.platform ?? null,
        ai_referral_detection: referral?.detection ?? null,
        // The one header besides the user agent that classification reads,
        // kept so a later rule change can be applied to stored events.
        accept_header: request.headers.get("accept")?.slice(0, 256) ?? null,
        classification_version: CLASSIFICATION_VERSION,
        $referring_domain: referringDomain,
        environment:
            resolution?.preview || env.VERCEL_ENV !== "production"
                ? "preview"
                : "production",
        surface,
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
        ...(uuid ? { uuid } : {}),
    })
}
