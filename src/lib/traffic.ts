/** Request-time traffic classification: the pure rules in types/traffic.ts
 * plus the one check that needs the network, an operator's published
 * address ranges. Runs after the response (observability.ts), never on the
 * request path. */

import { BlockList, isIP } from "node:net"
import { z } from "zod"
import { extensions } from "#docs-extensions"
import {
    classifyTraffic,
    matchTrafficEntry,
    type TrafficClassification,
} from "@/types/traffic"
import { env } from "../env"

const rangeFileSchema = z.object({
    creationTime: z.string().optional(),
    prefixes: z.array(
        z.object({
            ipv4Prefix: z.string().optional(),
            ipv6Prefix: z.string().optional(),
        }),
    ),
})

interface RangeFile {
    list: BlockList
    /** When the operator last published the file; null when it does not say. */
    createdAt: number | null
}

const RANGE_TTL_MS = 24 * 60 * 60 * 1000
const RANGE_RETRY_MS = 10 * 60 * 1000
/** A file older than this can still verify an address but never condemns
 *  one: an operator that stopped updating it has likely moved. */
const RANGE_STALE_MS = 180 * 24 * 60 * 60 * 1000

/** One load per warm instance and URL, shared by concurrent requests. */
const rangeFiles = new Map<
    string,
    { expiresAt: number; file: Promise<RangeFile | null> }
>()

async function loadRangeFile(url: string): Promise<RangeFile | null> {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const parsed = rangeFileSchema.safeParse(await response.json())
    if (!parsed.success) return null
    const list = new BlockList()
    let count = 0
    for (const prefix of parsed.data.prefixes) {
        const cidr = prefix.ipv4Prefix ?? prefix.ipv6Prefix
        const [network = "", bits] = cidr?.split("/") ?? []
        const family = isIP(network)
        const width = family === 6 ? 128 : 32
        const prefixBits = bits === undefined ? width : Number(bits)
        // One malformed prefix is skipped, not allowed to discard the file.
        if (
            family === 0 ||
            !Number.isInteger(prefixBits) ||
            prefixBits < 0 ||
            prefixBits > width
        )
            continue
        list.addSubnet(network, prefixBits, family === 6 ? "ipv6" : "ipv4")
        count += 1
    }
    if (count === 0) return null
    const createdAt = Date.parse(parsed.data.creationTime ?? "")
    return { list, createdAt: Number.isNaN(createdAt) ? null : createdAt }
}

/**
 * Whether an address is in the ranges an operator publishes at `url`:
 * true inside, false outside a current file, null when the file could not
 * be loaded or is too old to condemn anyone.
 */
export async function ipInPublishedRanges(
    url: string,
    address: string,
    now = Date.now(),
): Promise<boolean | null> {
    // "::ffff:1.2.3.4" is an IPv4 client seen through a dual-stack socket.
    const ip = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "")
    const family = isIP(ip)
    if (family === 0) return null
    let cached = rangeFiles.get(url)
    if (!cached || cached.expiresAt <= now) {
        const file = loadRangeFile(url).catch(() => null)
        cached = { expiresAt: now + RANGE_TTL_MS, file }
        rangeFiles.set(url, cached)
        // A failed load is retried sooner than a good file is refreshed.
        const entry = cached
        void file.then((loaded) => {
            if (!loaded) entry.expiresAt = now + RANGE_RETRY_MS
        })
    }
    const file = await cached.file
    if (!file) return null
    if (file.list.check(ip, family === 6 ? "ipv6" : "ipv4")) return true
    return file.createdAt !== null && now - file.createdAt <= RANGE_STALE_MS
        ? false
        : null
}

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
