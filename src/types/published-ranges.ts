/** Whether a client address belongs to the operator that a crawler's or
 * assistant's user agent names, read from the address ranges the operator
 * publishes (`TrafficEntry.ipRanges`). Imports nothing from the framework's
 * environment or extensions, so a host can verify the addresses it learns
 * elsewhere (a CDN's request log) with the framework's own answer. */

import { BlockList, isIP } from "node:net"
import { z } from "zod"

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
