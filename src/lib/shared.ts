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
