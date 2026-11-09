import { withBase } from "./base-path"

export interface FaviconLink {
    rel: "icon" | "apple-touch-icon"
    href: string
    type?: string
    media?: string
}

/**
 * Raster favicons double as the touch icon; SVG/data URIs don't (iOS
 * ignores them). Site favicons serve as extension-less content-hashed
 * asset URLs — treat those as raster (they're overwhelmingly png/ico, and a
 * stray svg in the slot is merely ignored by iOS).
 */
function appleTouchIcon(href: string): FaviconLink[] {
    return /\.(?:png|jpe?g)(?:\?|$)/i.test(href) || href.startsWith("/_assets/")
        ? [{ rel: "apple-touch-icon", href: withBase(href) }]
        : []
}

export function monogramFaviconDataUri(
    siteName: string,
    primary: string | undefined,
): string {
    // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization -- escapes a single grapheme (all five XML specials, & first) for an SVG text node
    const initial = (Array.from(siteName.trim())[0] ?? "D")
        .toLocaleUpperCase()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;")
    const color =
        primary && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(primary)
            ? primary
            : "#18181b"
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="34" fill="white" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function faviconLinks(input: {
    favicon: string | { light: string; dark: string } | null | undefined
    siteName: string
    primary: string | { light: string; dark: string } | undefined
}): FaviconLink[] {
    if (input.favicon === null) return []
    if (typeof input.favicon === "string")
        return [
            { rel: "icon", href: withBase(input.favicon) },
            ...appleTouchIcon(input.favicon),
        ]
    if (input.favicon) {
        return [
            {
                rel: "icon",
                href: withBase(input.favicon.light),
                media: "(prefers-color-scheme: light)",
            },
            {
                rel: "icon",
                href: withBase(input.favicon.dark),
                media: "(prefers-color-scheme: dark)",
            },
            ...appleTouchIcon(input.favicon.light),
        ]
    }
    const primary =
        typeof input.primary === "string"
            ? input.primary
            : (input.primary?.light ?? input.primary?.dark)
    return [
        {
            rel: "icon",
            type: "image/svg+xml",
            href: monogramFaviconDataUri(input.siteName, primary),
        },
    ]
}
