/** Request-time traffic classification: the pure rules in types/traffic.ts
 * plus the one check that needs the network, an operator's published
 * address ranges (types/published-ranges.ts). Runs after the response
 * (observability.ts), never on the request path. */

import { extensions } from "#docs-extensions"
import { ipInPublishedRanges } from "@/types/published-ranges"
import {
    classifyTraffic,
    matchTrafficEntry,
    type TrafficClassification,
} from "@/types/traffic"
import { env } from "../env"

/**
 * The caller's address and where it came from. `extension` is the
 * extension's answer and `platform` Vercel's forwarded address on Vercel,
 * which Vercel overwrites, so both are the connecting client's. `header` is
 * a forwarded header anywhere else, which the caller can forge: it still
 * tells visitors apart for analytics and per-visitor rate limits (each
 * site's own ceiling holds whatever it says), but never verifies anyone.
 * The first x-forwarded-for value is not read before Vercel's: behind
 * another proxy it is that proxy's hop, not the visitor.
 */
export function clientAddress(
    request: Request,
): { ip: string; source: "extension" | "platform" | "header" } | null {
    const fromExtension = extensions.clientIp?.(request)
    if (fromExtension) return { ip: fromExtension, source: "extension" }
    const forwarded = (name: string) =>
        request.headers.get(name)?.split(",")[0]?.trim() || undefined
    const vercel = forwarded("x-vercel-forwarded-for")
    if (vercel)
        return {
            ip: vercel,
            source: env.VERCEL_ENV === undefined ? "header" : "platform",
        }
    const ip = forwarded("x-forwarded-for") ?? forwarded("x-real-ip")
    return ip ? { ip, source: "header" } : null
}

/**
 * Classify a request, verifying a crawler's or assistant's claimed identity
 * against its operator's published ranges when the client address is
 * trustworthy (clientAddress: the extension's, or the platform's). A
 * forwarded header is the caller's to forge, so the identity stays
 * unverified. So does every request to a site whose visitors share one
 * address (its owner's proxy hides theirs) unless the extension names the
 * caller: the platform's address is the proxy's, and a real crawler behind
 * it must not read as an impersonator.
 */
export async function requestTraffic(
    request: Request,
    sharedClientAddress: boolean,
): Promise<TrafficClassification> {
    const userAgent = request.headers.get("user-agent") ?? ""
    const entry = matchTrafficEntry(userAgent)
    const client = entry?.ipRanges ? clientAddress(request) : null
    const address =
        client?.source === "extension" ||
        (client?.source === "platform" && !sharedClientAddress)
            ? client.ip
            : undefined
    return classifyTraffic({
        userAgent,
        accept: request.headers.get("accept"),
        signatureAgent:
            request.headers.get("signature") &&
            request.headers.get("signature-input")
                ? request.headers.get("signature-agent")
                : null,
        ipInRanges:
            entry?.ipRanges && address
                ? await ipInPublishedRanges(entry.ipRanges, address)
                : null,
    })
}
