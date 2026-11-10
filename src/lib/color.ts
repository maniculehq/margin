/**
 * Color math for the theme contract (deployment standard §4.1): parsing the
 * color forms the token tables use, WCAG 2 contrast, and the readable-accent
 * derivation that keeps a site's brand color legible on the surfaces it is
 * set against. Pure functions, shared by ingest (src/ingest/theme.ts) and
 * the contrast conventions test.
 */

/** sRGB channels in 0–255 plus alpha in 0–1. */
export type Rgba = readonly [number, number, number, number]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const HSL =
    /^hsla?\(\s*(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i
const RGB =
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i

function alpha(value: string | undefined): number {
    if (value === undefined) return 1
    return value.endsWith("%")
        ? Number.parseFloat(value) / 100
        : Number.parseFloat(value)
}

/** Parses `#RGB`, `#RRGGBB`, `rgb()/rgba()` and `hsl()/hsla()`; anything
 * else (a `var()`, `color-mix()`, a keyword) returns null. */
export function parseColor(value: string): Rgba | null {
    const text = value.trim()
    const hex = HEX.exec(text)?.[1]
    if (hex) {
        const full =
            hex.length === 3
                ? hex
                      .split("")
                      .map((digit) => digit + digit)
                      .join("")
                : hex
        return [
            Number.parseInt(full.slice(0, 2), 16),
            Number.parseInt(full.slice(2, 4), 16),
            Number.parseInt(full.slice(4, 6), 16),
            1,
        ]
    }
    const rgb = RGB.exec(text)
    if (rgb)
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha(rgb[4])]
    const hsl = HSL.exec(text)
    if (hsl) {
        const h = (((Number(hsl[1]) % 360) + 360) % 360) / 360
        const s = Number(hsl[2]) / 100
        const l = Number(hsl[3]) / 100
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s
        const p = 2 * l - q
        const channel = (t0: number) => {
            const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0
            if (t < 1 / 6) return p + (q - p) * 6 * t
            if (t < 1 / 2) return q
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
            return p
        }
        return [
            channel(h + 1 / 3) * 255,
            channel(h) * 255,
            channel(h - 1 / 3) * 255,
            alpha(hsl[4]),
        ]
    }
    return null
}

export function toHex(color: Rgba): string {
    return `#${color
        .slice(0, 3)
        .map((channel) =>
            Math.round(Math.min(255, Math.max(0, channel)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`
}

/** Source-over compositing of `top` onto an opaque `bottom`, as the browser
 * paints a translucent fill (Tailwind's `bg-x/10`) over the page. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
    const a = top[3]
    return [
        top[0] * a + bottom[0] * (1 - a),
        top[1] * a + bottom[1] * (1 - a),
        top[2] * a + bottom[2] * (1 - a),
        1,
    ]
}

function linear(channel: number): number {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(color: Rgba): number {
    return (
        0.2126 * linear(color[0]) +
        0.7152 * linear(color[1]) +
        0.0722 * linear(color[2])
    )
}

/** WCAG 2 contrast ratio of two opaque colors (1–21). */
export function contrast(a: Rgba, b: Rgba): number {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Black or white, whichever reads better on `fill` (always ≥ 4.58:1). */
export function readableOn(fill: Rgba): "#000000" | "#ffffff" {
    return contrast([0, 0, 0, 1], fill) >= contrast([255, 255, 255, 1], fill)
        ? "#000000"
        : "#ffffff"
}

// OKLab ↔ linear sRGB (Ottosson's matrices).
function toOklch(color: Rgba): [number, number, number] {
    const r = linear(color[0])
    const g = linear(color[1])
    const b = linear(color[2])
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    return [L, Math.hypot(A, B), Math.atan2(B, A)]
}

/** OKLCH → sRGB, or null when the color falls outside the sRGB gamut. */
function fromOklch(L: number, C: number, h: number): Rgba | null {
    const A = C * Math.cos(h)
    const B = C * Math.sin(h)
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    const channels = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
    if (channels.some((c) => c < -1e-4 || c > 1 + 1e-4)) return null
    const encode = (c: number) => {
        const v = Math.min(1, Math.max(0, c))
        return (
            (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255
        )
    }
    return [
        encode(channels[0] ?? 0),
        encode(channels[1] ?? 0),
        encode(channels[2] ?? 0),
        1,
    ]
}

/** The color at OKLCH lightness `L` with `color`'s hue, keeping as much of
 * its chroma as the sRGB gamut allows at that lightness. */
function atLightness(color: Rgba, L: number): Rgba {
    const [, C, h] = toOklch(color)
    let low = 0
    let high = C
    const exact = fromOklch(L, C, h)
    if (exact) return exact
    let best = fromOklch(L, 0, h) ?? [0, 0, 0, 1]
    for (let i = 0; i < 24; i += 1) {
        const mid = (low + high) / 2
        const candidate = fromOklch(L, mid, h)
        if (candidate) {
            best = candidate
            low = mid
        } else high = mid
    }
    return best
}

/** Where an accent is read: the plain surfaces behind accent text, plus the
 * surfaces a translucent tint of the accent itself is laid over (the active
 * sidebar row, `bg-fd-primary/10`). `page` is the page background, where
 * most accent text (links) sits. */
interface AccentSurfaces {
    page: Rgba | null
    surfaces: Rgba[]
    tintBases: Rgba[]
    tintAlpha: number
}

/** Minimum contrast of `accent` as text over every surface it is used on. */
function accentContrast(accent: Rgba, on: AccentSurfaces): number {
    const tints = on.tintBases.map((base) =>
        composite([accent[0], accent[1], accent[2], on.tintAlpha], base),
    )
    return Math.min(
        ...[...on.surfaces, ...tints].map((surface) =>
            contrast(accent, surface),
        ),
    )
}

/**
 * The site accent made readable for one color scheme: returned unchanged
 * when it already reaches `minimum` against every surface, otherwise moved
 * along OKLCH lightness only — darker on light surfaces, lighter on dark —
 * to the nearest lightness that clears it, keeping hue and as much chroma
 * as the gamut allows. A pale yellow becomes a legible amber on white; a
 * navy becomes a light slate on near-black.
 *
 * When no lightness clears every surface (a light-mode page authored black
 * under the preset's light panels), the accent is fitted to the page
 * background alone, where links sit; when even that fails, or the accent
 * already reads on the page, it is kept as authored. The result is never
 * less readable on the page than the authored accent.
 */
export function readableAccent(
    accent: Rgba,
    on: AccentSurfaces,
    scheme: "light" | "dark",
    minimum = 4.5,
): Rgba {
    // Target slightly above the floor so hex rounding never lands under it.
    const target = minimum + 0.05
    if (accentContrast(accent, on) >= target) return accent
    const [L0] = toOklch(accent)
    // A lightness between L0 and `end` that clears `surfaces` (the nearest
    // when contrast grows along the way), or null when `end` itself does
    // not. `end` passes and L0 fails, so the bisection ends on a pass.
    const fitTo = (surfaces: AccentSurfaces, end: number): Rgba | null => {
        if (accentContrast(atLightness(accent, end), surfaces) < target)
            return null
        let pass = end
        let fail = L0
        for (let i = 0; i < 28; i += 1) {
            const mid = (pass + fail) / 2
            if (accentContrast(atLightness(accent, mid), surfaces) >= target)
                pass = mid
            else fail = mid
        }
        return atLightness(accent, pass)
    }
    // Lightness moves away from the surfaces: darker in light mode.
    const away = scheme === "light" ? 0 : 1
    const everywhere = fitTo(on, away)
    if (everywhere) return everywhere
    // No colour reads on every surface: links sit on the page, so fit the
    // page alone (either direction), or keep an accent that already reads
    // there. Never return a colour that is worse on the page.
    if (!on.page || contrast(accent, on.page) >= target) return accent
    const page = {
        page: on.page,
        surfaces: [on.page],
        tintBases: [],
        tintAlpha: 0,
    }
    return fitTo(page, away) ?? fitTo(page, 1 - away) ?? accent
}
