/**
 * Best-effort image derivation for zero-config docs branding. Sharp stays
 * behind these calls so snapshots without a logo never load the native addon.
 */
export async function deriveFavicon(
    logoBytes: Uint8Array,
    mime: string,
): Promise<{ bytes: Uint8Array; mimeType: "image/png" } | null> {
    if (!mime.startsWith("image/")) return null
    // Outside the try: a missing native binary fails the ingest; only an
    // undecodable logo degrades.
    const { default: sharp } = await import("sharp")
    try {
        const bytes = await sharp(logoBytes)
            .resize(32, 32, {
                fit: "contain",
                withoutEnlargement: false,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer()
        return { bytes, mimeType: "image/png" }
    } catch {
        return null
    }
}

export async function deriveAccent(
    logoBytes: Uint8Array,
): Promise<string | null> {
    const { default: sharp } = await import("sharp")
    try {
        const { dominant } = await sharp(logoBytes).stats()
        const { r, g, b } = dominant
        if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return null
        return `#${[r, g, b]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`
    } catch {
        return null
    }
}
