/**
 * Docs helpers shared by ingest, the docs server, and the docs-site browser
 * bundle: zod-free or built on zod/mini. `./docs` re-exports everything here;
 * browser code imports this module directly so the classic-zod docs schema
 * barrel stays server-side.
 */

import {
    _default,
    array,
    boolean,
    type infer as Infer,
    object,
    optional,
    record,
    string,
    unknown,
    catch as zodCatch,
    enum as zodEnum,
} from "zod/mini"

const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
    "http",
    "https",
    "mailto",
    // Editor deep links — docs pages ship MCP one-click installs
    // (for example, `cursor://anysphere.cursor-deeplink/mcp/install?...`).
    // Inert outside the matching app.
    "cursor",
    "vscode",
    "vscode-insiders",
])

/** Scheme allow-list shared by untrusted MDX and config URL validation. */
export function isAllowedUrl(value: string): boolean {
    let startIndex = 0
    while (startIndex < value.length) {
        const character = value[startIndex] ?? ""
        const code = value.charCodeAt(startIndex)
        if (
            code > 0x20 &&
            (code < 0x7f || code > 0x9f) &&
            !/\s/u.test(character)
        )
            break
        startIndex += 1
    }
    const candidate = value.slice(startIndex)

    for (const character of candidate) {
        const code = character.charCodeAt(0)
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
    }

    if (candidate.startsWith("#")) return true

    const colonIndex = candidate.indexOf(":")
    const pathBoundaryIndexes = [
        candidate.indexOf("/"),
        candidate.indexOf("?"),
        candidate.indexOf("#"),
    ].filter((index) => index !== -1)
    const firstPathBoundary = Math.min(...pathBoundaryIndexes, Infinity)

    if (colonIndex !== -1 && colonIndex < firstPathBoundary) {
        const scheme = candidate.slice(0, colonIndex).toLowerCase()
        if (!ALLOWED_URL_SCHEMES.has(scheme)) return false
        // VS Code's official MCP deep link is authority-less
        // ("vscode:mcp/install?…") — the built-in contextual menu emits
        // exactly that form, so authored copies must pass too.
        const authorityless =
            scheme === "mailto" ||
            ((scheme === "vscode" || scheme === "vscode-insiders") &&
                !candidate.startsWith(`${scheme}://`))
        if (!authorityless && !candidate.startsWith(`${scheme}://`))
            return false

        try {
            const parsed = new URL(candidate)
            if (parsed.protocol !== `${scheme}:`) return false
            return authorityless || parsed.host.length > 0
        } catch {
            return false
        }
    }

    try {
        const parsed = new URL(candidate, "https://relative.invalid/")
        if (candidate.startsWith("//")) return parsed.host.length > 0
        return parsed.origin === "https://relative.invalid"
    } catch {
        return false
    }
}

/**
 * docs.json redirect grammar, shared by ingest validation and the serving
 * matcher so a rule admitted at ingest always fires at request time:
 *   /a/b            exact
 *   /a/:name        one segment, substitutable as `:name`
 *   /a/:name*       the rest of the path (may be empty), substitutable
 *   /a/*            the rest of the path, substitutable as `*` (or `:splat`)
 *   /a/prefix-*     partial wildcard: a segment starting with `prefix-`,
 *                   the captured tail substitutable as `*`
 * Sources match case-sensitively; destinations may carry `#fragment` or
 * `?query`, which survive substitution.
 */
export type RedirectPatternPart =
    | { kind: "literal"; value: string }
    | { kind: "param"; name: string }
    | { kind: "rest"; name: string }
    | { kind: "partial"; prefix: string }

export function parseRedirectPattern(
    source: string,
): RedirectPatternPart[] | null {
    if (!source.startsWith("/")) return null
    const segments = source.slice(1).split("/")
    const parts: RedirectPatternPart[] = []
    for (const [index, segment] of segments.entries()) {
        const last = index === segments.length - 1
        if (segment === "*" || segment === ":splat") {
            if (!last) return null
            parts.push({ kind: "rest", name: segment })
            continue
        }
        const named = /^:([A-Za-z_][\w-]*)(\*?)$/.exec(segment)
        if (named?.[1] !== undefined) {
            if (named[2] === "*") {
                if (!last) return null
                parts.push({ kind: "rest", name: `:${named[1]}*` })
            } else parts.push({ kind: "param", name: `:${named[1]}` })
            continue
        }
        if (segment.endsWith("*")) {
            const prefix = segment.slice(0, -1)
            if (!last || prefix.length === 0 || prefix.includes("*"))
                return null
            parts.push({ kind: "partial", prefix })
            continue
        }
        if (segment.includes("*") || segment.includes(":")) return null
        parts.push({ kind: "literal", value: segment })
    }
    return parts
}

/** Wildcard/param tokens a destination may substitute for the given source. */
export function redirectCaptureTokens(parts: RedirectPatternPart[]): string[] {
    return parts.flatMap((part) =>
        part.kind === "param"
            ? [part.name]
            : part.kind === "rest"
              ? [part.name, "*", ":splat"]
              : part.kind === "partial"
                ? ["*"]
                : [],
    )
}

/** Match a request path against one pattern; returns the substituted destination. */
export function applyRedirectPattern(input: {
    pathname: string
    source: string
    destination: string
}): string | null {
    const parts = parseRedirectPattern(input.source)
    if (!parts) return null
    const [, ...segments] = input.pathname.split("/")
    const captures = new Map<string, string>()
    let index = 0
    for (const part of parts) {
        if (part.kind === "rest") {
            const rest = segments.slice(index).join("/")
            captures.set(part.name, rest)
            captures.set("*", rest)
            captures.set(":splat", rest)
            index = segments.length
            break
        }
        const segment = segments[index]
        if (segment === undefined) return null
        if (part.kind === "literal") {
            if (segment !== part.value) return null
        } else if (part.kind === "param") {
            if (segment.length === 0) return null
            captures.set(part.name, segment)
        } else {
            if (!segment.startsWith(part.prefix)) return null
            captures.set("*", segment.slice(part.prefix.length))
        }
        index += 1
    }
    if (index !== segments.length) return null
    // One pass over the authored destination, longest token first, so a
    // captured value containing `*` or `:` is never re-substituted.
    const tokens = [...captures.keys()].sort((a, b) => b.length - a.length)
    const pattern = new RegExp(
        tokens
            .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
        "g",
    )
    return input.destination.replace(
        pattern,
        (token) => captures.get(token) ?? token,
    )
}

/** First matching rule wins; exact rules are checked before patterns. */
export function matchRedirect(
    pathname: string,
    redirects: readonly {
        source: string
        destination: string
        permanent?: boolean
    }[],
): { destination: string; permanent: boolean } | null {
    const exact = redirects.find((entry) => entry.source === pathname)
    if (exact)
        return {
            destination: exact.destination,
            permanent: exact.permanent !== false,
        }
    for (const entry of redirects) {
        const destination = applyRedirectPattern({
            pathname,
            source: entry.source,
            destination: entry.destination,
        })
        if (destination !== null)
            return { destination, permanent: entry.permanent !== false }
    }
    return null
}

/** Controls crawler URLs and ingest-rebased links; routes still resolve both forms. Callers pass page URLs, so dotted slugs also receive the trailing slash. */
export function formatDocsPath(url: string, trailingSlash: boolean): string {
    if (!trailingSlash) return url
    const boundary = url.search(/[?#]/)
    const path = boundary === -1 ? url : url.slice(0, boundary)
    const suffix = boundary === -1 ? "" : url.slice(boundary)
    if (path === "/" || path === "" || path.endsWith("/")) return url
    return `${path}/${suffix}`
}

/**
 * The deployment-scoped API console configuration (docs.json `api.*`).
 * Ingest sanitizes the authored values field-by-field (diagnostics for the
 * invalid ones); serving resolves the stored raw object through this schema,
 * so the defaults live in exactly one place. `catch` keeps rows persisted
 * before sanitization from throwing at serve time.
 */
export const DOCS_API_PLAYGROUND_DISPLAYS = [
    "interactive",
    "simple",
    "none",
    "auth",
] as const
export const docsApiConfigSchema = object({
    playground: _default(
        zodCatch(
            object({
                display: _default(
                    zodEnum(DOCS_API_PLAYGROUND_DISPLAYS),
                    "interactive",
                ),
                proxy: _default(boolean(), true),
                credentials: _default(boolean(), false),
            }),
            { display: "interactive", proxy: true, credentials: false },
        ),
        { display: "interactive", proxy: true, credentials: false },
    ),
    examples: _default(
        zodCatch(
            object({
                languages: optional(array(string())),
                defaults: _default(zodEnum(["required", "all"]), "all"),
                autogenerate: _default(boolean(), true),
                // docs.json api.examples.prefill: fill the playground from the
                // generated example. fumadocs' playground always seeds fields
                // from the selected example, so `true` is inherently satisfied
                // and `false` is diagnosed at ingest (unsupported_field).
                prefill: _default(boolean(), false),
            }),
            { defaults: "all", autogenerate: true, prefill: false },
        ),
        { defaults: "all", autogenerate: true, prefill: false },
    ),
    params: _default(
        zodCatch(
            object({
                expanded: optional(zodEnum(["all", "closed"])),
                // docs.json api.params.post: OpenAPI schema field names rendered
                // as pills on parameter fields. Admitted so authored configs
                // round-trip; rendering is diagnosed at ingest as unsupported.
                post: optional(array(string())),
            }),
            {},
        ),
        {},
    ),
})
export type DocsApiConfig = Infer<typeof docsApiConfigSchema>

/** Resolve the served api.* block from a raw config `api` value. */
export function resolveDocsApiConfig(api: unknown): DocsApiConfig {
    const entries = record(string(), unknown()).safeParse(api)
    return docsApiConfigSchema.parse(entries.success ? entries.data : {})
}

export function docsSiteUrl(hostname: string): string {
    const local = hostname.endsWith(".localhost")
    return `${local ? "http" : "https"}://${hostname}`
}

/** Rescue-only retry for pages whose Markdoc tags break MDX parsing (ingest
 * and the PDF renderer share it). It leaves
 * successfully compiled pages untouched and masks code/fences so diagnostics
 * retain authored line numbers. */
export function stripMarkdocTags(source: string): string {
    let fence: { marker: string; length: number } | null = null
    return source
        .split("\n")
        .map((line) => {
            const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
            if (delimiter?.[1]) {
                const marker = delimiter[1].charAt(0)
                const length = delimiter[1].length
                if (fence === null) {
                    fence = { marker, length }
                } else if (
                    marker === fence.marker &&
                    length >= fence.length &&
                    (delimiter[2] ?? "").trim() === ""
                ) {
                    fence = null
                }
                return line
            }
            if (fence !== null) return line
            // Odd split indices are complete inline-code spans — their
            // contents are valid MDX already and must survive.
            return line
                .split(/(`+[^`]*`+)/)
                .map((segment, index) =>
                    index % 2 === 1
                        ? segment
                        : segment.replaceAll(/\{%[^\n]*?%\}/g, ""),
                )
                .join("")
        })
        .join("\n")
}
