import type { ThemePreset, ThemeTokens } from "./docs"

/**
 * Starting palette per docs.json `theme` (deployment standard §4.2). Each
 * approximates the Mintlify theme of the same name: white (or, for linden,
 * cream) pages, near-black dark mode, and grays that lean toward the
 * theme's hue. Resolved into the per-site token block at ingest; explicit
 * `colors`, `background.color`, `x-margin.tokens` and site CSS win.
 *
 * Every text/surface pair here clears WCAG AA in both schemes: muted text
 * holds 4.5:1 on the page, cards, fills and the search field
 * (tests/theme-contrast.test.ts). The neutral grays are `hsl(h, s%, l%)` so
 * ingest can re-tint them toward a site's primary hue (src/ingest/theme.ts).
 */
interface PaletteSpec {
    /** Hue and saturation of the theme's grays. */
    hue: number
    saturation: number
    /** Light-mode page; white unless the theme is tinted. */
    lightBackground?: string
    /** Dark-mode page lightness (%). */
    darkLightness: number
    /** Extra tokens (fonts) the theme sets. */
    extra?: ThemeTokens
}

function palette(spec: PaletteSpec): ThemeTokens {
    const { hue: h, saturation: s } = spec
    const gray = (saturation: number, lightness: number) =>
        `hsl(${h}, ${Math.max(0, saturation)}%, ${lightness}%)`
    const pair = (light: string, dark: string) => ({ light, dark })
    const foreground = pair(gray(s + 4, 10), gray(s, 92))
    return {
        "--color-fd-background": pair(
            spec.lightBackground ?? "hsl(0, 0%, 100%)",
            gray(s + 4, spec.darkLightness),
        ),
        "--color-fd-foreground": foreground,
        "--color-fd-card": pair(
            gray(s + 6, 98.5),
            gray(s, spec.darkLightness + 3),
        ),
        "--color-fd-card-foreground": foreground,
        "--color-fd-popover": pair(
            spec.lightBackground ?? "hsl(0, 0%, 100%)",
            gray(s, spec.darkLightness + 4),
        ),
        "--color-fd-popover-foreground": foreground,
        "--color-fd-muted": pair(
            gray(s + 6, 96),
            gray(s, spec.darkLightness + 5),
        ),
        "--color-fd-muted-foreground": pair(gray(s, 39), gray(s, 64)),
        "--color-fd-secondary": pair(
            gray(s + 6, 95),
            gray(s, spec.darkLightness + 7),
        ),
        "--color-fd-secondary-foreground": pair(gray(s + 4, 14), gray(s, 90)),
        "--color-fd-accent": pair(
            gray(s + 6, 94),
            gray(s, spec.darkLightness + 8),
        ),
        "--color-fd-accent-foreground": pair(gray(s + 4, 10), gray(s, 94)),
        "--color-fd-border": pair(
            gray(s + 4, 91),
            gray(s, spec.darkLightness + 11),
        ),
        "--color-fd-ring": pair(gray(s, 45), gray(s, 58)),
        // Monochrome until the site sets `colors`.
        "--color-fd-primary": pair(gray(s + 4, 10), gray(s, 96)),
        "--color-fd-primary-foreground": pair(
            "hsl(0, 0%, 100%)",
            gray(s, spec.darkLightness + 3),
        ),
        ...spec.extra,
    }
}

export const PALETTE_TOKENS: Record<ThemePreset, ThemeTokens> = {
    mint: palette({ hue: 220, saturation: 6, darkLightness: 4.5 }),
    // Retro terminal: cream paper, warm charcoal, monospace throughout.
    linden: palette({
        hue: 30,
        saturation: 8,
        lightBackground: "hsl(40, 67%, 98.5%)",
        darkLightness: 7.5,
        extra: { "--font-sans": "var(--font-mono)" },
    }),
    maple: palette({ hue: 15, saturation: 6, darkLightness: 4.5 }),
    almond: palette({ hue: 180, saturation: 6, darkLightness: 4 }),
    palm: palette({ hue: 100, saturation: 5, darkLightness: 4.5 }),
    willow: palette({ hue: 210, saturation: 8, darkLightness: 5 }),
    aspen: palette({ hue: 45, saturation: 6, darkLightness: 5 }),
    sequoia: palette({ hue: 75, saturation: 6, darkLightness: 4.5 }),
    luma: palette({ hue: 25, saturation: 6, darkLightness: 4 }),
}
