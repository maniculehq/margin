/** Fallback before a request resolves: build-time SITE_NAME, else "Docs".
 * Resolved surfaces use DocsHead.identity. */
export const appName = process.env.SITE_NAME || "Docs"
/** `<meta name="generator">` value for every rendered page. */
export const GENERATOR_NAME = "margin"
/**
 * Docs serve at the site root. Kept as an exported
 * constant because ingest mirrors it (DOCS_ROUTE in src/ingest/compile.ts),
 * and joins like `${docsRoute}/${slug}` must stay well-formed.
 */
export const docsRoute = ""
export const docsImageRoute = "/og/docs"

/** JSON for the body of an inline `<script>`. The HTML parser ends a script
 * at the first `</script`, whatever the JSON means, so `<`, `>` and `&` go
 * out as `\u` escapes; so do U+2028 and U+2029, which end a line in older
 * JavaScript engines. JSON.parse and JavaScript both read the escapes back
 * as the original characters. */
export function inlineScriptJson(value: unknown): string {
    return JSON.stringify(value).replace(
        /[<>&\u2028\u2029]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
}

/** Use the visitor's Host header: on Vercel, `request.url` may contain the
 * internal deployment hostname. This module is in the browser bundle
 * (`start.ts` exposes it to client-shared middleware, the chrome reads
 * `appName`): keep it free of `source.ts` (`@/db` opens a pg Pool at
 * module load) and of `env.ts` (classic zod). */
export function originFromRequest(request: Request): string {
    const host = request.headers.get("host")
    if (!host) return new URL(request.url).origin
    const proto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        new URL(request.url).protocol.replace(":", "")
    return `${proto}://${host}`
}

/**
 * Build the `.md` route URL for a set of slugs. The inverse direction (URL ->
 * slugs) lives in `normalizeDocUrl` in agent-content.ts — there is exactly one
 * normalizer per direction. Client-safe by design — see originFromRequest.
 */
export function slugsToMarkdownPath(slugs: string[]) {
    const segments = [...slugs]
    if (segments.length === 0) {
        segments.push("index.md")
    } else {
        segments[segments.length - 1] += ".md"
    }

    return {
        segments,
        url: `${docsRoute}/${segments.join("/")}`,
    }
}
