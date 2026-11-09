/**
 * WCAG AA floor for every layout preset, in both color schemes, for any
 * primary color a site might set (deployment standard §4.1–§4.2).
 *
 * The effective tokens are what the browser resolves on <html> and inside
 * the sidebar: the framework stylesheets (fumadocs' palette imports,
 * app.css and the preset files, followed through their @imports and ordered
 * by layer, specificity and source order), then the per-site token block
 * ingest emits for a docs.json (src/ingest/theme.ts). Each text pair the
 * chrome sets must reach 4.5:1; focus rings 3:1.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveThemeTokens } from "@/ingest/theme"
import { composite, contrast, parseColor, type Rgba } from "@/lib/color"
import {
    docsConfigSupersetSchema,
    LAYOUT_PRESETS,
    type LayoutPreset,
    THEME_LAYOUT_PRESETS,
    THEME_PRESETS,
    type ThemeTokens,
} from "@/types/docs"

const root = resolve(import.meta.dirname, "..")

interface Rule {
    selector: string
    declarations: Record<string, string>
    /** 0 = a Tailwind @theme layer (below every unlayered rule). */
    layer: 0 | 1
    order: number
}

/** Top-level rules carrying --color-fd-* declarations, following @import
 * into the framework's own files and fumadocs-ui's palette CSS. @media and
 * other at-rule blocks are skipped: no palette token lives in one. */
function collectRules(file: string, rules: Rule[] = []): Rule[] {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    let cursor = 0
    while (cursor < css.length) {
        const open = css.indexOf("{", cursor)
        const semicolon = css.indexOf(";", cursor)
        if (semicolon !== -1 && (open === -1 || semicolon < open)) {
            const statement = css.slice(cursor, semicolon).trim()
            const target = /^@import\s+["']([^"']+)["']/.exec(statement)?.[1]
            if (target) {
                const path = target.startsWith(".")
                    ? resolve(dirname(file), target)
                    : target.startsWith("fumadocs-ui/css/")
                      ? resolve(root, "node_modules", target)
                      : null
                if (path) collectRules(path, rules)
            }
            cursor = semicolon + 1
            continue
        }
        if (open === -1) break
        let depth = 1
        let close = open + 1
        while (close < css.length && depth > 0) {
            if (css[close] === "{") depth += 1
            if (css[close] === "}") depth -= 1
            close += 1
        }
        const header = css.slice(cursor, open).trim()
        const body = css.slice(open + 1, close - 1)
        const declarations = Object.fromEntries(
            [...body.matchAll(/(--color-fd-[\w-]+)\s*:\s*([^;{}]+);/g)].map(
                (match) => [match[1] ?? "", (match[2] ?? "").trim()],
            ),
        )
        if (Object.keys(declarations).length > 0) {
            if (/^@theme\b/.test(header))
                rules.push({
                    selector: ":root",
                    declarations,
                    layer: 0,
                    order: rules.length,
                })
            else if (!header.startsWith("@"))
                for (const selector of header.split(","))
                    rules.push({
                        selector: selector.trim(),
                        declarations,
                        layer: 1,
                        order: rules.length,
                    })
        }
        cursor = close
    }
    return rules
}

const STYLESHEET_RULES = collectRules(resolve(root, "src/styles/app.css"))

/** Whether a compound selector matches <html> in this preset and scheme. */
function matchesRoot(
    compound: string,
    preset: LayoutPreset,
    scheme: "light" | "dark",
): boolean {
    const parts = compound.match(/:not\([^)]*\)|:root|\.[\w-]+|\[[^\]]+\]/g)
    if (!parts || parts.join("") !== compound) return false
    return parts.every((part) => {
        if (part === ":root") return true
        if (part === ".dark") return scheme === "dark"
        if (part === ":not(.dark)") return scheme === "light"
        const attribute = /^\[data-preset="?([\w-]+)"?\]$/.exec(part)
        return attribute ? attribute[1] === preset : false
    })
}

function specificity(selector: string): number {
    const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []
    const ids = selector.match(/#[\w-]+/g) ?? []
    return ids.length * 100 + classes.length
}

/** Resolved --color-fd-* values on <html>, or on #nd-sidebar. */
function effectiveTokens(
    siteTokens: ThemeTokens,
    preset: LayoutPreset,
    scheme: "light" | "dark",
    element: "root" | "sidebar",
): Record<string, string> {
    const matching = STYLESHEET_RULES.filter((rule) => {
        const compounds = rule.selector.split(/\s+/)
        const last = compounds.at(-1) ?? ""
        if (element === "root")
            return compounds.length === 1 && matchesRoot(last, preset, scheme)
        if (last !== "#nd-sidebar") return false
        return compounds
            .slice(0, -1)
            .every((compound) => matchesRoot(compound, preset, scheme))
    })
    // The token block is an inline <style> after the stylesheets:
    // `:root{…}.dark{…}`, unlayered.
    const block: Rule[] = [
        {
            selector: ":root",
            declarations: Object.fromEntries(
                Object.entries(siteTokens).map(([name, value]) => [
                    name,
                    typeof value === "string" ? value : value.light,
                ]),
            ),
            layer: 1,
            order: Number.MAX_SAFE_INTEGER - 1,
        },
        ...(scheme === "dark"
            ? [
                  {
                      selector: ".dark",
                      declarations: Object.fromEntries(
                          Object.entries(siteTokens).flatMap(([name, value]) =>
                              typeof value === "string"
                                  ? []
                                  : [[name, value.dark]],
                          ),
                      ),
                      layer: 1 as const,
                      order: Number.MAX_SAFE_INTEGER,
                  },
              ]
            : []),
    ]
    const ordered = [...matching, ...block].sort(
        (a, b) =>
            a.layer - b.layer ||
            specificity(a.selector) - specificity(b.selector) ||
            a.order - b.order,
    )
    const resolved: Record<string, string> = {}
    // Sidebar values inherit from <html>, then its own rules apply.
    if (element === "sidebar")
        Object.assign(
            resolved,
            effectiveTokens(siteTokens, preset, scheme, "root"),
        )
    for (const rule of ordered) Object.assign(resolved, rule.declarations)
    return resolved
}

interface Pair {
    name: string
    ratio: number
    minimum: number
}

/** The text/surface pairs the chrome sets, each with its WCAG floor. */
function pairs(
    root: Record<string, string>,
    sidebar: Record<string, string>,
): Pair[] {
    const page = parseColor(root["--color-fd-background"] ?? "")
    if (!page || page[3] < 1) throw new Error("page background is not opaque")
    const color = (
        tokens: Record<string, string>,
        name: string,
        under: Rgba = page,
    ): Rgba => {
        const value = parseColor(tokens[`--color-fd-${name}`] ?? "")
        if (!value) throw new Error(`--color-fd-${name} is not a color`)
        return composite(value, under)
    }
    const out: Pair[] = []
    const text = (
        tokens: Record<string, string>,
        label: string,
        fg: string,
        surfaces: string[],
    ) => {
        for (const surface of surfaces) {
            const behind = color(tokens, surface)
            out.push({
                name: `${label}${fg} on ${surface}`,
                ratio: contrast(color(tokens, fg, behind), behind),
                minimum: 4.5,
            })
        }
    }
    const surfaces = ["background", "card", "popover", "muted", "secondary"]
    text(root, "", "foreground", surfaces)
    text(root, "", "card-foreground", ["card"])
    text(root, "", "popover-foreground", ["popover"])
    text(root, "", "secondary-foreground", ["secondary"])
    text(root, "", "accent-foreground", ["accent"])
    text(root, "", "muted-foreground", [...surfaces, "accent"])
    text(sidebar, "sidebar ", "muted-foreground", [
        "background",
        "muted",
        "secondary",
    ])
    text(root, "", "primary", surfaces)
    // The active sidebar row: accent text on `bg-fd-primary/10` over the
    // page (presets whose sidebar sits on a fill mark it without a tint).
    for (const base of ["background"]) {
        const accent = color(sidebar, "primary")
        const tint = composite(
            [accent[0], accent[1], accent[2], 0.1],
            color(sidebar, base),
        )
        out.push({
            name: `sidebar primary on its 10% tint over ${base}`,
            ratio: contrast(accent, tint),
            minimum: 4.5,
        })
    }
    text(root, "", "primary-foreground", ["primary"])
    out.push({
        name: "ring on background",
        ratio: contrast(color(root, "ring"), page),
        minimum: 3,
    })
    return out
}

const PRIMARIES = [undefined, "#2563EB", "#FDE047", "#0F172A", "#16A34A"]
const CASES = [
    ...THEME_PRESETS.map((theme) => ({
        label: theme,
        theme,
        preset: THEME_LAYOUT_PRESETS[theme],
    })),
    // Presets reached without a docs.json theme (zero config is neutral).
    ...LAYOUT_PRESETS.map((preset) => ({
        label: `${preset} (no theme)`,
        theme: undefined,
        preset,
    })),
]

describe("theme contrast floor", () => {
    for (const { label, theme, preset } of CASES)
        for (const primary of PRIMARIES)
            for (const scheme of ["light", "dark"] as const)
                it(`${label}, primary ${primary ?? "unset"}, ${scheme}`, () => {
                    const config = docsConfigSupersetSchema.parse({
                        ...(theme ? { theme } : {}),
                        ...(primary ? { colors: { primary } } : {}),
                    })
                    const tokens = resolveThemeTokens(config, preset)
                    // Solid buttons (colors.dark, else primary) carry their
                    // own foreground token.
                    const button = parseColor(
                        String(tokens["--margin-button"] ?? ""),
                    )
                    const buttonText = parseColor(
                        String(tokens["--margin-button-foreground"] ?? ""),
                    )
                    const buttonPair: Pair[] =
                        button && buttonText
                            ? [
                                  {
                                      name: "button-foreground on button",
                                      ratio: contrast(buttonText, button),
                                      minimum: 4.5,
                                  },
                              ]
                            : []
                    const failures = [
                        ...pairs(
                            effectiveTokens(tokens, preset, scheme, "root"),
                            effectiveTokens(tokens, preset, scheme, "sidebar"),
                        ),
                        ...buttonPair,
                    ]
                        .filter((pair) => pair.ratio < pair.minimum)
                        .map(
                            (pair) =>
                                `${pair.name}: ${pair.ratio.toFixed(2)} < ${pair.minimum}`,
                        )
                    expect(failures).toEqual([])
                })
})

describe("site colors", () => {
    const resolve = (input: unknown) =>
        resolveThemeTokens(docsConfigSupersetSchema.parse(input), "neutral")

    it("uses colors.light as the dark-mode accent", () => {
        const tokens = resolve({
            colors: { primary: "#166534", light: "#4ADE80" },
        })
        expect(tokens["--color-fd-primary"]).toEqual({
            light: "#166534",
            dark: "#4ade80",
        })
    })

    it("keeps an explicit x-margin.tokens.primary as authored", () => {
        const tokens = resolve({
            colors: { primary: "#FDE047" },
            "x-margin": { tokens: { primary: "#FDE047" } },
        })
        expect(tokens["--color-fd-primary"]).toBe("#FDE047")
    })

    it("darkens a pale accent that fails the light page and panels", () => {
        const tokens = resolve({ colors: { primary: "#FDE047" } })
        // #7e6c00 is the fit c9e54b7 produced: the fallback for unfittable
        // accents leaves accents that can be fitted exactly as they were.
        expect(tokens["--color-fd-primary"]).toEqual({
            light: "#7e6c00",
            dark: "#fde047",
        })
    })

    it("keeps a white accent on a black light-mode page that no colour can fit to the light panels too", () => {
        const tokens = resolve({
            colors: { primary: "#ffffff" },
            background: { color: { light: "#000000", dark: "#000000" } },
        })
        expect(tokens["--color-fd-primary"]).toEqual({
            light: "#ffffff",
            dark: "#ffffff",
        })
    })

    it("fits an accent unreadable everywhere to the page it sits on", () => {
        const tokens = resolve({
            colors: { primary: "#333333" },
            background: { color: { light: "#000000", dark: "#000000" } },
        })
        const primary = tokens["--color-fd-primary"]
        const light = parseColor(
            typeof primary === "string" ? primary : (primary?.light ?? ""),
        )
        // The page is black: anything at 4.5:1 on it is a light colour,
        // where the pre-fix fit to the light panels returned black (1:1).
        expect(light && contrast(light, [0, 0, 0, 1])).toBeGreaterThanOrEqual(
            4.5,
        )
    })

    it("fills buttons with colors.dark", () => {
        const tokens = resolve({
            colors: { primary: "#16A34A", dark: "#14532D" },
        })
        expect(tokens["--margin-button"]).toBe("#14532D")
        expect(tokens["--margin-button-foreground"]).toBe("#ffffff")
    })
})
