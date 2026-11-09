import { createHash } from "node:crypto"
import type { LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { z } from "zod"
import type { Diagnostic, DocsConfigSuperset, StoredSeo } from "../types/docs"
import { type PreparedAsset, prepareAssets } from "./assets"

/**
 * undici loads lazily and once: its module init touches web-platform APIs
 * newer runtimes provide (CacheStorage), and every test path injects hooks —
 * the dependency should only ever load where a REAL network fetch happens.
 */
let undiciModule: Promise<typeof import("undici")> | null = null
function loadUndici(): Promise<typeof import("undici")> {
    undiciModule ??= import("undici")
    return undiciModule
}

/**
 * Ingests tenant-controlled remote images so server-side renderers never
 * fetch tenant URLs. Hosts and every redirect are checked against public DNS
 * ranges, resolved addresses are pinned to prevent rebinding, and size and
 * image types are restricted; SVG is sanitized before hashing. Browser-loaded
 * images remain pass-through.
 */

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 10_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REMOTE_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
}
// Satori consumes ttf/otf (never woff2) — the css2 fetch below pins a UA
// that yields ttf, and these are the types fonts.gstatic.com serves for it.
const REMOTE_FONT_MIME_EXTENSIONS: Record<string, string> = {
    "font/ttf": "ttf",
    "font/otf": "otf",
    "font/sfnt": "ttf",
    "application/x-font-ttf": "ttf",
    "application/font-sfnt": "ttf",
}

/** Publicly routable unicast check for a literal IPv4/IPv6 address. */
export function isPublicUnicastAddress(address: string): boolean {
    const family = isIP(address)
    if (family === 4) {
        const octets = address.split(".").map(Number)
        const [a, b, c] = octets
        if (a === undefined || b === undefined || c === undefined) return false
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false
        if (a === 100 && b >= 64 && b <= 127) return false
        if (a === 169 && b === 254) return false
        if (a === 172 && b >= 16 && b <= 31) return false
        // 192.0.0.0/24 (protocol assignments), 192.0.2.0/24 (TEST-NET-1),
        // 192.88.99.0/24 (deprecated 6to4 anycast), 192.168.0.0/16.
        if (
            a === 192 &&
            ((b === 0 && (c === 0 || c === 2)) ||
                (b === 88 && c === 99) ||
                b === 168)
        )
            return false
        if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
            return false
        if (a === 203 && b === 0 && c === 113) return false
        return true
    }
    if (family === 6) {
        const normalized = address.toLowerCase()
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
        if (mapped?.[1]) return isPublicUnicastAddress(mapped[1])
        // Special-use carve-outs inside 2000::/3: 2001::/23 is the IETF
        // protocol-assignments block (Teredo 2001::/32, benchmarking
        // 2001:2::/48, ORCHID 2001:10::/28 + 2001:20::/28 all live there);
        // 2001:db8::/32 and 3fff::/20 are documentation ranges. Hextet
        // boundaries matter: 2001:db80::/28 stays globally routable.
        if (normalized.startsWith("2001:")) {
            const second = normalized.split(":")[1] ?? ""
            const value = Number.parseInt(second === "" ? "0" : second, 16)
            if (Number.isNaN(value) || value <= 0x01ff) return false
            if (second === "db8") return false
        }
        if (normalized.startsWith("3fff:")) return false
        if (normalized.startsWith("2002:")) return false
        // Global unicast is 2000::/3; everything else (loopback, link-local,
        // ULA fc00::/7, multicast, NAT64 64:ff9b::, v4-compatible, SRv6
        // 5f00::/16) rejects.
        return /^[23]/.test(normalized)
    }
    return false
}

export type RemoteImageResult =
    | { ok: true; bytes: Uint8Array; mimeType: string; extension: string }
    | { ok: false; reason: string }

/**
 * Minimal structural response so tests can hand in the global `Response`
 * and the default path can hand in undici's — no casts either way (their
 * ReadableStream generics disagree, so only the reader shape is required).
 */
type MinimalResponse = {
    status: number
    headers: { get(name: string): string | null }
    body: {
        getReader(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>
            cancel(): Promise<unknown>
        }
    } | null
}

export type RemoteFetchHooks = {
    /** Override DNS resolution (tests). Must return every answer. */
    resolve?: (hostname: string) => Promise<LookupAddress[]>
    /** Override the socket-level fetch (tests). Pinning is skipped. */
    fetchImpl?: (
        url: string,
        init: { redirect: "manual"; signal: AbortSignal },
    ) => Promise<MinimalResponse>
    /** Override the Google Fonts css2 text fetch (tests). */
    fetchText?: (url: string) => Promise<string | null>
}

/**
 * A content-type header is CDN-controlled data — the bytes must actually
 * carry the claimed format's signature before they persist, or a stale or
 * misconfigured origin could poison every OG render for the version with
 * undecodable bytes. SVG has no magic bytes; sanitizeSvg parses and
 * validates it before hashing instead. Font signatures ride along for the
 * stacked thumbnails.fonts work.
 */
function matchesSignature(bytes: Uint8Array, extension: string): boolean {
    const ascii = (offset: number, text: string): boolean =>
        [...text].every(
            (char, index) => bytes[offset + index] === char.charCodeAt(0),
        )
    switch (extension) {
        case "png":
            return bytes[0] === 0x89 && ascii(1, "PNG")
        case "jpg":
            return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        case "gif":
            return ascii(0, "GIF8")
        case "webp":
            return ascii(0, "RIFF") && ascii(8, "WEBP")
        case "ico":
            return (
                bytes[0] === 0 &&
                bytes[1] === 0 &&
                bytes[2] === 1 &&
                bytes[3] === 0
            )
        case "svg":
            return true
        case "ttf":
            return (
                (bytes[0] === 0 &&
                    bytes[1] === 1 &&
                    bytes[2] === 0 &&
                    bytes[3] === 0) ||
                ascii(0, "true") ||
                ascii(0, "OTTO") ||
                ascii(0, "ttcf")
            )
        case "otf":
            return (
                ascii(0, "OTTO") ||
                (bytes[0] === 0 &&
                    bytes[1] === 1 &&
                    bytes[2] === 0 &&
                    bytes[3] === 0)
            )
        default:
            return false
    }
}

async function readBodyCapped(
    response: MinimalResponse,
): Promise<Uint8Array | { reason: string }> {
    const declared = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES)
        return { reason: "response exceeds the remote image size cap" }
    if (!response.body) return { reason: "response has no body" }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
            total += value.byteLength
            if (total > MAX_REMOTE_IMAGE_BYTES) {
                await reader.cancel()
                return { reason: "response exceeds the remote image size cap" }
            }
            chunks.push(value)
        }
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

export function fetchRemoteImage(
    rawUrl: string,
    hooks?: RemoteFetchHooks,
): Promise<RemoteImageResult> {
    return fetchRemoteBytes(rawUrl, REMOTE_IMAGE_MIME_EXTENSIONS, hooks)
}

async function fetchRemoteBytes(
    rawUrl: string,
    mimeExtensions: Record<string, string>,
    hooks?: RemoteFetchHooks,
): Promise<RemoteImageResult> {
    const fail = (reason: string): RemoteImageResult => ({ ok: false, reason })
    let fetched: Extract<RemoteImageResult, { ok: true }> | undefined
    let current = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let url: URL
        try {
            url = new URL(current)
        } catch {
            return fail(`invalid URL: ${current}`)
        }
        if (url.protocol !== "https:") return fail("only https URLs admit")
        if (url.username || url.password)
            return fail("URLs with embedded credentials are rejected")
        const bareHost = url.hostname.replace(/^\[|\]$/g, "")
        const literalFamily = isIP(bareHost)
        let addresses: LookupAddress[]
        if (literalFamily) {
            addresses = [{ address: bareHost, family: literalFamily }]
        } else {
            try {
                // node's lookup has no timeout knob — race it against the
                // same deadline the fetch gets, so a stalling resolver can't
                // hold the ingest workflow beyond FETCH_TIMEOUT_MS per hop.
                addresses = hooks?.resolve
                    ? await hooks.resolve(bareHost)
                    : await Promise.race([
                          lookup(bareHost, { all: true, verbatim: true }),
                          new Promise<never>((_, reject) => {
                              setTimeout(
                                  () => reject(new Error("dns timeout")),
                                  FETCH_TIMEOUT_MS,
                              ).unref()
                          }),
                      ])
            } catch {
                return fail(`hostname did not resolve: ${bareHost}`)
            }
        }
        if (addresses.length === 0)
            return fail(`hostname did not resolve: ${bareHost}`)
        // EVERY answer must be public — a single private A record is a
        // rebinding/split-horizon vector even when siblings are public.
        if (!addresses.every((entry) => isPublicUnicastAddress(entry.address)))
            return fail(`host resolves to a non-public address: ${bareHost}`)

        const init: { redirect: "manual"; signal: AbortSignal } = {
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
        let response: MinimalResponse
        // Pin the validated DNS answers into the connection so the socket
        // can only reach addresses that passed the check above.
        const undici = hooks?.fetchImpl ? null : await loadUndici()
        const agent = undici
            ? new undici.Agent({
                  connect: {
                      lookup: (_hostname, _options, callback) =>
                          callback(null, addresses),
                  },
              })
            : null
        try {
            if (hooks?.fetchImpl) {
                response = await hooks.fetchImpl(url.href, init)
            } else if (undici && agent) {
                response = await undici.fetch(url.href, {
                    ...init,
                    dispatcher: agent,
                })
            } else {
                return fail("fetch unavailable")
            }
            if (REDIRECT_STATUSES.has(response.status)) {
                const location = response.headers.get("location")
                if (!location) return fail("redirect without a location")
                current = new URL(location, url).href
                continue
            }
            if (response.status !== 200)
                return fail(`unexpected status ${response.status}`)
            const contentType = (response.headers.get("content-type") ?? "")
                .split(";")[0]
                ?.trim()
                .toLowerCase()
            const extension = contentType
                ? mimeExtensions[contentType]
                : undefined
            if (!contentType || !extension)
                return fail(`unsupported content-type: ${contentType || "?"}`)
            const body = await readBodyCapped(response)
            if (!(body instanceof Uint8Array)) return fail(body.reason)
            if (!matchesSignature(body, extension))
                return fail(
                    `response bytes do not match the claimed ${contentType}`,
                )
            fetched = {
                ok: true,
                bytes: body,
                mimeType: contentType,
                extension,
            }
            break
        } catch {
            return fail(`fetch failed: ${url.hostname}`)
        } finally {
            // destroy(), not graceful close(): every early exit above
            // (redirect, non-200, bad content-type, size reject) leaves the
            // response body unread, and close() would wait on that in-flight
            // request forever. The per-hop agent has nothing to keep alive.
            await agent?.destroy()
        }
    }
    if (!fetched) return fail("too many redirects")
    // Magic bytes catch mislabeled bodies; a TRUNCATED payload still has them
    // and would only fail inside the renderer, poisoning every OG card for
    // the version — probe the full decode here. (svg is parsed by sanitizeSvg
    // later, ico/fonts have no sharp decoder.) sharp loads only for raster
    // bodies and outside the fetch catch-all: a missing native binary fails
    // the ingest instead of reading as "fetch failed".
    if (["png", "jpg", "webp", "gif"].includes(fetched.extension)) {
        const { default: sharp } = await import("sharp")
        try {
            await sharp(fetched.bytes).stats()
        } catch {
            return fail(`response bytes do not decode as ${fetched.mimeType}`)
        }
    }
    return fetched
}

/**
 * Post-compile ingest step (compile stays a pure function of the tree, like
 * resolveFontCss): fetch the allow-listed external images that server-side
 * rendering would otherwise fetch at serve time — today that is the OG
 * thumbnail background — store them as content-hashed docs assets, and
 * rewrite the stored config/seo to /_assets URLs. On any failure the field
 * drops with a diagnostic; the OG route no longer renders remote URLs.
 * Never throws for a remote failure; only a missing sharp binary fails the
 * ingest.
 */
type CompiledForRemoteAssets = {
    assets: PreparedAsset[]
    config: DocsConfigSuperset | null
    seo: StoredSeo
    diagnostics: Diagnostic[]
}

export async function resolveRemoteBrandingAssets(
    compiled: CompiledForRemoteAssets,
    hooks?: RemoteFetchHooks,
): Promise<void> {
    const isExternal = (value: unknown): value is string =>
        typeof value === "string" && /^(?:https?:)?\/\//i.test(value)
    // dropOnFailure: backgrounds drop (the OG route refuses remote URLs, so
    // a kept external would render nothing anyway); logos keep the authored
    // URL — the browser header still loads it, only the OG card skips it,
    // and the object logo schema requires both variants to stay strings.
    const sites: Array<{
        field: string
        read: () => unknown
        write: (next: string | undefined) => void
        dropOnFailure: boolean
    }> = [
        {
            field: "thumbnails.background",
            read: () => compiled.config?.thumbnails?.background,
            write: (next) => {
                if (!compiled.config?.thumbnails) return
                compiled.config.thumbnails = {
                    ...compiled.config.thumbnails,
                    background: next,
                }
            },
            dropOnFailure: true,
        },
        {
            field: "seo.ogDefaults.background",
            read: () => compiled.seo.ogDefaults.background,
            write: (next) => {
                compiled.seo.ogDefaults = {
                    ...compiled.seo.ogDefaults,
                    background: next,
                }
            },
            dropOnFailure: true,
        },
        {
            field: "logo",
            read: () =>
                typeof compiled.config?.logo === "string"
                    ? compiled.config.logo
                    : undefined,
            write: (next) => {
                if (
                    compiled.config &&
                    typeof compiled.config.logo === "string" &&
                    next
                )
                    compiled.config.logo = next
            },
            dropOnFailure: false,
        },
        {
            field: "logo.light",
            read: () => {
                const logo = compiled.config?.logo
                return logo && typeof logo === "object" ? logo.light : undefined
            },
            write: (next) => {
                const logo = compiled.config?.logo
                if (compiled.config && logo && typeof logo === "object" && next)
                    compiled.config.logo = { ...logo, light: next }
            },
            dropOnFailure: false,
        },
        {
            field: "logo.dark",
            read: () => {
                const logo = compiled.config?.logo
                return logo && typeof logo === "object" ? logo.dark : undefined
            },
            write: (next) => {
                const logo = compiled.config?.logo
                if (compiled.config && logo && typeof logo === "object" && next)
                    compiled.config.logo = { ...logo, dark: next }
            },
            dropOnFailure: false,
        },
    ]
    const resolved = new Map<string, string | undefined>()
    for (const site of sites) {
        const value = site.read()
        if (!isExternal(value)) continue
        if (!resolved.has(value)) {
            const fetched = await fetchRemoteImage(value, hooks)
            if (!fetched.ok) {
                compiled.diagnostics.push({
                    code: "asset_missing",
                    severity: "warn",
                    // The consequence differs per field: backgrounds drop
                    // (the OG route refuses remote URLs), logos keep the
                    // authored URL for the browser and only the OG card
                    // skips them — say which one actually happened.
                    message: site.dropOnFailure
                        ? `External image could not be admitted at ingest (${fetched.reason}); "${site.field}" was dropped: ${value}`
                        : `External image could not be admitted at ingest (${fetched.reason}); "${site.field}" is unavailable — site chrome falls back to the site name and the OG card renders without it: ${value}`,
                    path: "docs.json",
                })
                resolved.set(value, undefined)
            } else {
                const prepared = await prepareAssets([
                    {
                        path: `_remote/${createHash("sha256").update(value).digest("hex")}.${fetched.extension}`,
                        bytes: fetched.bytes,
                    },
                ])
                compiled.diagnostics.push(...prepared.diagnostics)
                const asset = prepared.assets[0]
                if (asset) {
                    compiled.assets.push(asset)
                    resolved.set(value, `/_assets/${asset.contentHash}`)
                } else {
                    resolved.set(value, undefined)
                }
            }
        }
        const next = resolved.get(value)
        if (next !== undefined) site.write(next)
        else if (site.dropOnFailure) site.write(undefined)
    }
    // ── thumbnails.fonts (single consumer, inlined per the repo's
    // helper-extraction rule): Google Fonts family resolved through
    // css2 (legacy UA → ttf for satori, bare-family fallback), 400/700
    // binaries stored as assets, config/seo rewritten to /_assets URLs.
    // Any failure degrades to a diagnostic + the default font.
    // biome-ignore lint/suspicious/noConfusingLabels: block-scoped early exits from the inlined single-use resolver (AGENTS.md no-wrapper rule)
    fonts: {
        const authored =
            compiled.config?.thumbnails?.fonts ?? compiled.seo.ogDefaults.fonts
        if (authored === undefined) break fonts
        const fail = (message: string) =>
            compiled.diagnostics.push({
                code: "asset_missing",
                severity: "warn",
                message,
                path: "docs.json",
            })
        const parsed = thumbnailFontsSchema.safeParse(authored)
        if (!parsed.success || !GOOGLE_FONT_FAMILY.test(parsed.data.family)) {
            fail(
                "thumbnails.fonts requires a Google Fonts { family } name; the generated OG image uses the default font.",
            )
            break fonts
        }
        const family = parsed.data.family
        const encodedFamily = encodeURIComponent(family).replaceAll("%20", "+")
        // css2 rejects an axes query the family doesn't expose (regular-only
        // families have no 700 face), so fall back to the bare-family request;
        // bold then falls back to the regular face at render time.
        const cssCandidates = [
            `https://fonts.googleapis.com/css2?family=${encodedFamily}:wght@400;700&display=swap`,
            `https://fonts.googleapis.com/css2?family=${encodedFamily}&display=swap`,
        ]
        let css: string | null = null
        for (const cssUrl of cssCandidates) {
            css = hooks?.fetchText
                ? await hooks.fetchText(cssUrl)
                : await (async () => {
                      const response = await fetch(cssUrl, {
                          // Deliberately legacy UA: css2 varies by UA and only
                          // pre-woff2 agents receive ttf sources satori can read.
                          headers: { "user-agent": "Mozilla/5.0" },
                          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                      }).catch(() => null)
                      if (!response?.ok) return null
                      const text = await response.text().catch(() => "")
                      return text &&
                          text.length <= 512 * 1024 &&
                          !text.includes("<")
                          ? text
                          : null
                  })()
            if (css) break
        }
        if (!css) {
            fail(
                `thumbnails.fonts family "${family}" did not resolve on Google Fonts; the generated OG image uses the default font.`,
            )
            break fonts
        }
        // Last block per weight wins — css2 emits the latin subset last.
        const faces = new Map<string, string>()
        for (const block of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
            const weight = /font-weight:\s*(\d+)/.exec(block[0])?.[1]
            const url =
                /url\((https:\/\/fonts\.gstatic\.com\/[^)]+?\.(?:ttf|otf))\)/i.exec(
                    block[0],
                )?.[1]
            if (weight && url) faces.set(weight, url)
        }
        const regularUrl = faces.get("400")
        const boldUrl = faces.get("700")
        if (!regularUrl) {
            fail(
                `thumbnails.fonts family "${family}" returned no ttf sources; the generated OG image uses the default font.`,
            )
            break fonts
        }
        // Stage locally and append only after EVERY requested weight admits —
        // a bold failure must not leave an orphaned regular asset persisting
        // while the config stays unresolved and the renderer uses Geist.
        const stored = new Map<string, string>()
        const staged: PreparedAsset[] = []
        for (const url of new Set([
            regularUrl,
            ...(boldUrl ? [boldUrl] : []),
        ])) {
            const fetched = await fetchRemoteBytes(
                url,
                REMOTE_FONT_MIME_EXTENSIONS,
                hooks,
            )
            if (!fetched.ok) {
                fail(
                    `thumbnails.fonts binary could not be admitted at ingest (${fetched.reason}); the generated OG image uses the default font.`,
                )
                break fonts
            }
            const prepared = await prepareAssets([
                {
                    path: `_remote/${createHash("sha256").update(url).digest("hex")}.${fetched.extension}`,
                    bytes: fetched.bytes,
                },
            ])
            compiled.diagnostics.push(...prepared.diagnostics)
            const asset = prepared.assets[0]
            if (!asset) break fonts
            staged.push(asset)
            stored.set(url, `/_assets/${asset.contentHash}`)
        }
        compiled.assets.push(...staged)
        const resolvedFonts = {
            family,
            regular: stored.get(regularUrl),
            ...(boldUrl ? { bold: stored.get(boldUrl) } : {}),
        }
        if (compiled.config?.thumbnails)
            compiled.config.thumbnails = {
                ...compiled.config.thumbnails,
                fonts: resolvedFonts,
            }
        compiled.seo.ogDefaults = {
            ...compiled.seo.ogDefaults,
            fonts: resolvedFonts,
        }
    }
}

const GOOGLE_FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/
const thumbnailFontsSchema = z.object({ family: z.string() })
