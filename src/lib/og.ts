export interface OgPayload {
    siteName: string
    section: string | null
    titleLines: string[]
    descriptionLines: string[]
    accent: string
    /**
     * Accent as text on the light card — accents below 3:1 WCAG contrast
     * on the white background fall back to the muted gray.
     */
    eyebrowColor: string
}

export function wrapOgText(
    value: string,
    maxCharacters: number,
    maxLines: number,
): string[] {
    const words = value.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const lines: string[] = []
    let current = ""
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? ""
        const candidate = current ? `${current} ${word}` : word
        if (candidate.length <= maxCharacters) {
            current = candidate
            continue
        }
        if (current) lines.push(current)
        if (word.length > maxCharacters) {
            current = `${word.slice(0, Math.max(1, maxCharacters - 1))}…`
            break
        }
        current = word
        if (lines.length === maxLines - 1) {
            const remainder = [current, ...words.slice(index + 1)].join(" ")
            current =
                remainder.length > maxCharacters
                    ? `${remainder.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`
                    : remainder
            break
        }
    }
    if (current && lines.length < maxLines) lines.push(current)
    return lines.slice(0, maxLines)
}

export function buildOgPayload(input: {
    siteName: string
    section: string | null
    title: string
    description: string | null
    accent: string | { light: string; dark: string } | undefined
    /** docs.json thumbnails.appearance — forces the card palette. */
    appearance?: "light" | "dark"
}): OgPayload {
    // Forced-dark cards prefer the DARK accent of a light/dark token pair.
    const rawAccent =
        typeof input.accent === "string"
            ? input.accent
            : input.appearance === "dark"
              ? (input.accent?.dark ?? input.accent?.light)
              : (input.accent?.light ?? input.accent?.dark)
    const compactAccent =
        rawAccent && /^#[\da-f]{3}$/i.test(rawAccent)
            ? `#${rawAccent
                  .slice(1)
                  .split("")
                  .map((digit) => `${digit}${digit}`)
                  .join("")}`
            : rawAccent
    const accent =
        compactAccent && /^#[\da-f]{6}$/i.test(compactAccent)
            ? compactAccent
            : "#18181b"
    // WCAG relative luminance (linearized sRGB), contrast measured against
    // the card's lightest background (#ffffff). 3:1 is the WCAG large-text
    // floor — the eyebrow renders at 28px.
    const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) => {
        const channel = parseInt(accent.slice(offset, offset + 2), 16) / 255
        return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4
    })
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    // Contrast against the card's own background: the lightest stop of the
    // light gradient, or the darkest stop of the dark card.
    const contrast =
        input.appearance === "dark"
            ? (luminance + 0.05) / 0.05
            : 1.05 / (luminance + 0.05)
    return {
        siteName: input.siteName.trim(),
        section: input.section
            ? (wrapOgText(input.section, 48, 1)[0] ?? null)
            : null,
        titleLines: wrapOgText(input.title, 28, 3),
        descriptionLines: input.description
            ? wrapOgText(input.description, 62, 2)
            : [],
        accent,
        eyebrowColor:
            contrast >= 3
                ? accent
                : input.appearance === "dark"
                  ? "#a1a1aa"
                  : "#52525b",
    }
}

/**
 * Card palette for a site `thumbnails.background` with no explicit
 * `appearance`: mean perceived luminance of a small RGBA raster of the
 * background (alpha composited over white, the card's fallback) decides
 * whether the text must be light ("dark" card) or dark ("light" card).
 */
export function luminanceAppearance(pixels: Uint8Array): "light" | "dark" {
    if (pixels.length < 4) return "light"
    let total = 0
    let count = 0
    for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
        const alpha = (pixels[offset + 3] ?? 255) / 255
        const red = (pixels[offset] ?? 0) * alpha + 255 * (1 - alpha)
        const green = (pixels[offset + 1] ?? 0) * alpha + 255 * (1 - alpha)
        const blue = (pixels[offset + 2] ?? 0) * alpha + 255 * (1 - alpha)
        total += 0.2126 * red + 0.7152 * green + 0.0722 * blue
        count += 1
    }
    return total / count < 128 ? "dark" : "light"
}
