import {
    DOCS_ICON_FA_SVGS,
    DOCS_ICON_FA_SYNONYMS,
    DOCS_ICON_SVGS,
    DOCS_ICON_SYNONYMS,
} from "../generated/icon-map.ts"

// Relative, not `@/generated/…`: vite-plugins.ts imports this module while
// Vite bundles its config, which inlines relative imports but leaves path
// aliases for Node to resolve — and Node cannot.

/** Resolve Lucide or FontAwesome names to the SVGs `bun run icons:build`
 * rendered from Hugeicons. Names are normalized across common casing and
 * separators. */
export function normalizeIconName(input: string): string {
    return input
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase()
        .replace(/^lucide-/, "")
        .replace(/-icon$/, "")
}

/** Resolved inline SVG for an icon name, or null when unknown or when the
 * icon set the map was built from lacks the glyph. */
export function resolveDocsIconSvg(input: string): string | null {
    const name = normalizeIconName(input)
    const canonical =
        DOCS_ICON_SYNONYMS[name] ?? DOCS_ICON_FA_SYNONYMS[name] ?? name
    // FA-embedded glyphs (brands no stroke set depicts) key by FA name.
    return DOCS_ICON_SVGS[canonical] ?? DOCS_ICON_FA_SVGS[canonical] ?? null
}

/** Spec §icons: unresolved names fall back to a default glyph, never nothing. */
export const DOCS_DEFAULT_ICON_SVG: string = (() => {
    const fallback = DOCS_ICON_SVGS.file ?? Object.values(DOCS_ICON_SVGS)[0]
    if (!fallback) throw new Error("generated icon map is empty")
    return fallback
})()
