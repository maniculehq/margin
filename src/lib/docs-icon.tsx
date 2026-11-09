import type { ReactNode } from "react"
import { useBasePath, withBase } from "@/lib/base-path"
import { cn } from "@/lib/cn"

/**
 * Icon values that reach the browser are either image references —
 * ingest-hashed `/_assets/<sha256>` URLs and allow-listed https URLs
 * (docs-ingest compile.ts rewriteIconValue) — or inline `<svg` markup that
 * the SERVER already resolved from the committed Hugeicons maps (ingest for
 * page bodies, `serveLayoutConfig` for chrome config, the page-tree plugin
 * for sidebar rows). The maps themselves are 2 MB and never ship to the
 * client, so a bare vocabulary name that slips through renders the caller's
 * fallback, never a lookup.
 */
export const iconIsImageRef = (value: string): boolean =>
    value.startsWith("/") || /^https?:\/\//i.test(value)

/**
 * Defense-in-depth for the inline-SVG sink: ingest rejects site-authored
 * inline markup (icons.ts treats "<"-leading values as unauthorable), so
 * a stored "<svg" string can only come from the committed icon map — but a
 * sink this direct still refuses anything carrying active content.
 */
export function trustedInlineSvg(value: string | undefined): string | null {
    return value?.startsWith("<svg") &&
        // No scripts, handlers, embedded documents, references (href/src/
        // use/image), stylesheets or CSS fetches (url()/@import) — the map's
        // glyphs are bare <path>/<circle> strokes and need none of them.
        !/on\w+\s*=|<\s*(?:script|foreignobject|style|image|use|iframe|object|embed|link|meta)\b|javascript:|(?:href|src)\s*=|url\s*\(|@import|data:/i.test(
            value,
        )
        ? value
        : null
}

/**
 * A stored image icon: its `/_assets/…` URL is root-relative and gets the
 * site's base path when it renders, not when the node is built. The
 * sidebar tree that carries these nodes is memoized per version across
 * requests (source.ts), so the prefix must not be baked into it.
 */
function IconImage({ src, className }: { src: string; className?: string }) {
    const base = useBasePath()
    return (
        // biome-ignore lint/performance/noImgElement: site icon assets are served from the docs asset store, not next/image
        <img
            src={withBase(src, base)}
            alt=""
            aria-hidden
            className={cn("size-4 shrink-0 object-contain", className)}
        />
    )
}

/**
 * THE serve-side icon node builder (sidebar tree plugin, band tabs, sidenav
 * rows, drawer links): image refs render as an explicitly sized <img> —
 * svg-descendant sizing selectors ([&_svg]:size-4) never reach an <img>, so
 * an unsized one paints at intrinsic size; resolved SVG renders inline;
 * anything else renders the caller's fallback (tree rows keep the default
 * glyph for even indentation, chrome renders nothing).
 */
export function docsIconNode(
    value: string | undefined,
    options: { className?: string; fallbackSvg?: string } = {},
): ReactNode | null {
    const trimmed = value?.trim()
    if (trimmed && iconIsImageRef(trimmed))
        return <IconImage src={trimmed} className={options.className} />
    const svg = trustedInlineSvg(trimmed) ?? options.fallbackSvg
    if (!svg) return null
    return (
        <span
            className={options.className}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: SVGs come from the generated, committed icon maps — resolved server-side, never site input
            dangerouslySetInnerHTML={{ __html: svg }} // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- `svg` passed trustedInlineSvg (no scripts, handlers, refs or CSS fetches) or is the caller's committed fallback glyph
        />
    )
}
