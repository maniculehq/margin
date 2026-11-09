import type { Declaration, ReturnedRule } from "lightningcss"
import {
    CONFIG_EXTENSION_KEY,
    type Diagnostic,
    type DocsConfigSuperset,
    LAYOUT_PRESET_PALETTES,
    type LayoutPreset,
    THEME_LAYOUT_PRESETS,
    THEME_PRESET_PALETTES,
    type ThemeTokens,
    themePresetSchema,
} from "../types/docs"
import { PALETTE_TOKENS } from "../types/docs-palettes"
import { isAllowedExternalAssetUrl, resolveAssetReference } from "./assets"

const MAX_CSS_BYTES = 256 * 1024
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const CSS_DIMENSION =
    /^(?:\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|ch)|calc\([^;{}<>]*\))$/
const FONT_FAMILY = /^[A-Za-z0-9 '",-]+$/
const DOCUMENTED_COLOR_TOKENS = new Set([
    "background",
    "foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "border",
    "ring",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "info",
    "warning",
    "error",
])
const LAYOUT_PROPERTIES = new Set([
    "all",
    "position",
    "display",
    "overflow",
    "overflow-x",
    "overflow-y",
    "float",
    "clear",
    "box-sizing",
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "inset",
    "top",
    "right",
    "bottom",
    "left",
    "z-index",
])

export function resolveLayoutPreset(theme: string | undefined): {
    preset: LayoutPreset
    diagnostic?: Diagnostic
} {
    if (theme === undefined) return { preset: "neutral" }
    const parsed = themePresetSchema.safeParse(theme)
    if (parsed.success) return { preset: THEME_LAYOUT_PRESETS[parsed.data] }
    return {
        preset: "neutral",
        diagnostic: {
            code: "theme_unmapped",
            severity: "warn",
            message: `Theme "${theme}" is not mapped; using the neutral preset.`,
        },
    }
}

export function resolveThemeTokens(
    config: DocsConfigSuperset | null,
    preset: LayoutPreset,
    detectedAccent?: string,
    diagnostics: Diagnostic[] = [],
): ThemeTokens {
    const palette = config?.theme
        ? THEME_PRESET_PALETTES[config.theme]
        : LAYOUT_PRESET_PALETTES[preset]
    const tokens: ThemeTokens =
        palette === "neutral" ? {} : structuredClone(PALETTE_TOKENS[palette])

    // An explicit null pins the bare preset and disables every derived/config
    // token source. Tenant CSS remains a separate, later cascade layer.
    if (config?.colors === null) return tokens

    const setColor = (
        cssVar: string,
        value: string | { light: string; dark: string } | undefined,
        path: string,
    ): boolean => {
        if (value === undefined) return false
        if (typeof value === "string") {
            if (HEX_COLOR.test(value)) {
                tokens[cssVar] = value
                return true
            } else {
                diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `Invalid color at ${path}; expected #RGB or #RRGGBB.`,
                    path,
                })
                return false
            }
        }
        if (HEX_COLOR.test(value.light) && HEX_COLOR.test(value.dark)) {
            tokens[cssVar] = value
            return true
        } else {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid color at ${path}; expected #RGB or #RRGGBB.`,
                path,
            })
            return false
        }
    }

    let basePrimarySupplied = false
    let explicitPrimaryForeground = false
    if (detectedAccent !== undefined)
        basePrimarySupplied = setColor(
            "--color-fd-primary",
            detectedAccent,
            "detectedAccent",
        )

    const colors = config?.colors
    if (colors?.primary !== undefined)
        basePrimarySupplied = setColor(
            "--color-fd-primary",
            colors.primary,
            "colors.primary",
        )
    if (colors?.dark !== undefined || colors?.light !== undefined) {
        const current = tokens["--color-fd-primary"]
        const base =
            typeof current === "string"
                ? current
                : (current?.light ?? current?.dark)
        const lightMode = colors.dark ?? base
        const darkMode = colors.light ?? base
        if (lightMode !== undefined && darkMode !== undefined)
            setColor(
                "--color-fd-primary",
                { light: lightMode, dark: darkMode },
                "colors",
            )
    }

    // Dark neutrals follow the primary color: a pink primary reads warm
    // plum-black in dark mode where a static palette would stay cool. Re-tint the palette's DARK neutrals with the
    // primary's hue (saturation capped so it stays a near-black, not a brand
    // wash). Explicit background.color below still overrides.
    const primaryToken = tokens["--color-fd-primary"]
    const primaryHex =
        typeof primaryToken === "string" ? primaryToken : primaryToken?.dark
    if (basePrimarySupplied && primaryHex && HEX_COLOR.test(primaryHex)) {
        const hex =
            primaryHex.length === 4
                ? `#${primaryHex[1]}${primaryHex[1]}${primaryHex[2]}${primaryHex[2]}${primaryHex[3]}${primaryHex[3]}`
                : primaryHex
        const r = Number.parseInt(hex.slice(1, 3), 16) / 255
        const g = Number.parseInt(hex.slice(3, 5), 16) / 255
        const b = Number.parseInt(hex.slice(5, 7), 16) / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        let hue = 0
        if (max !== min) {
            const d = max - min
            if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60
            else if (max === g) hue = ((b - r) / d + 2) * 60
            else hue = ((r - g) / d + 4) * 60
        }
        const primaryHue = Math.round(hue)
        const DARK_HSL =
            /^hsl(a?)\((\d+(?:\.\d+)?), ?(\d+(?:\.\d+)?)%, ?([^)]+)\)$/
        // NEUTRAL surfaces only — semantic/brand tokens (primary, ring,
        // info/warning/error/success) must keep their own hue and
        // saturation; the 12% cap would gray a brand focus ring out.
        const darkNeutralTokens = new Set(
            [
                "background",
                "foreground",
                "card",
                "card-foreground",
                "popover",
                "popover-foreground",
                "muted",
                "muted-foreground",
                "secondary",
                "secondary-foreground",
                "accent",
                "accent-foreground",
                "border",
                "input",
            ].map((suffix) => `--color-fd-${suffix}`),
        )
        for (const [name, value] of Object.entries(tokens)) {
            if (!darkNeutralTokens.has(name)) continue
            if (typeof value === "string" || value.dark === undefined) continue
            const match = DARK_HSL.exec(value.dark)
            if (!match) continue
            const saturation = Math.min(Number.parseFloat(match[3] ?? "0"), 12)
            tokens[name] = {
                light: value.light,
                dark: `hsl${match[1]}(${primaryHue}, ${saturation}%, ${match[4]})`,
            }
        }
    }

    setColor(
        "--color-fd-background",
        config?.background?.color,
        "background.color",
    )

    if (config?.banner?.color) {
        const bannerToken =
            config.banner.type === "critical"
                ? "error"
                : (config.banner.type ?? "info")
        setColor(
            `--color-fd-${bannerToken}`,
            config.banner.color,
            "banner.color",
        )
    }

    for (const [name, value] of Object.entries(
        config?.[CONFIG_EXTENSION_KEY]?.tokens ?? {},
    )) {
        if (!DOCUMENTED_COLOR_TOKENS.has(name)) continue
        const applied = setColor(
            `--color-fd-${name}`,
            value,
            `${CONFIG_EXTENSION_KEY}.tokens.${name}`,
        )
        if (name === "primary" && typeof value === "string" && applied)
            basePrimarySupplied = true
        if (name === "primary-foreground" && applied)
            explicitPrimaryForeground = true
    }

    const setDimension = (
        cssVar: string,
        value: string | undefined,
        path: string,
    ): void => {
        if (value === undefined) return
        if (CSS_DIMENSION.test(value)) {
            tokens[cssVar] = value
            return
        }
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `Invalid layout dimension at ${path}.`,
            path,
        })
    }

    const layout = config?.[CONFIG_EXTENSION_KEY]?.layout
    setDimension(
        "--fd-layout-width",
        layout?.contentWidth,
        `${CONFIG_EXTENSION_KEY}.layout.contentWidth`,
    )
    setDimension(
        "--fd-sidebar-width",
        layout?.sidebarWidth,
        `${CONFIG_EXTENSION_KEY}.layout.sidebarWidth`,
    )
    setDimension(
        "--fd-toc-width",
        layout?.tocWidth,
        `${CONFIG_EXTENSION_KEY}.layout.tocWidth`,
    )
    setDimension(
        "--fd-header-height",
        layout?.headerHeight,
        `${CONFIG_EXTENSION_KEY}.layout.headerHeight`,
    )

    const fonts = config?.fonts
    const validFontFamily = (
        value: string | undefined,
        path: string,
    ): string | undefined => {
        if (value === undefined) return undefined
        if (FONT_FAMILY.test(value)) return value
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `Invalid font family at ${path}.`,
            path,
        })
        return undefined
    }
    const bodyFamily = validFontFamily(fonts?.body?.family, "fonts.body.family")
    const family = validFontFamily(fonts?.family, "fonts.family")
    const headingFamily = validFontFamily(
        fonts?.heading?.family,
        "fonts.heading.family",
    )
    const monoFamily = validFontFamily(fonts?.mono?.family, "fonts.mono.family")
    // Keep heading fonts separate from body fonts. Append the platform and OS
    // fallback stack so missing or unloaded webfonts do not fall back to serif.
    const SANS_FALLBACK =
        '"InterVariable", "InterFallback", ui-sans-serif, system-ui, sans-serif'
    const MONO_FALLBACK =
        '"GeistMono", "GeistMonoFallback", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
    const sans = bodyFamily ?? family
    if (sans) tokens["--font-sans"] = `${sans}, ${SANS_FALLBACK}`
    if (headingFamily)
        tokens["--font-heading"] = `${headingFamily}, ${SANS_FALLBACK}`
    if (monoFamily) tokens["--font-mono"] = `${monoFamily}, ${MONO_FALLBACK}`

    const primary = tokens["--color-fd-primary"]
    if (
        basePrimarySupplied &&
        !explicitPrimaryForeground &&
        typeof primary === "string" &&
        HEX_COLOR.test(primary)
    ) {
        const compact = primary.slice(1)
        const expanded =
            compact.length === 3
                ? compact
                      .split("")
                      .map((digit) => `${digit}${digit}`)
                      .join("")
                : compact
        const channels = [0, 2, 4].map((offset) => {
            const channel =
                Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255
            return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4
        })
        const luminance =
            0.2126 * (channels[0] ?? 0) +
            0.7152 * (channels[1] ?? 0) +
            0.0722 * (channels[2] ?? 0)
        tokens["--color-fd-primary-foreground"] =
            luminance > 0.179 ? "#000" : "#fff"
    }

    return tokens
}

export async function sanitizeCss(
    cssFiles: Array<{ path: string; content: string }>,
    allowedHosts: string[],
    assetHashes: ReadonlyMap<string, string> = new Map(),
    preserveOrder = false,
): Promise<{ css: string; diagnostics: Diagnostic[]; fontImports: string[] }> {
    const diagnostics: Diagnostic[] = []
    let admittedBytes = 0
    const admitted: Array<{ path: string; content: string }> = []
    for (const file of preserveOrder
        ? cssFiles
        : [...cssFiles].sort((a, b) => a.path.localeCompare(b.path))) {
        const bytes = Buffer.byteLength(file.content, "utf8")
        if (admittedBytes + bytes > MAX_CSS_BYTES) {
            diagnostics.push({
                code: "css_oversize",
                severity: "warn",
                message: `CSS file skipped because the version exceeds the 256KB CSS cap.`,
                path: file.path,
            })
            continue
        }
        admittedBytes += bytes
        admitted.push(file)
    }
    // Collect Google Fonts stylesheet imports for the caller to resolve and
    // inline; every other @import is removed with a warning.
    const fontImports: string[] = []
    if (admitted.length === 0) return { css: "", diagnostics, fontImports }

    // Loaded lazily INSIDE the call, never at module init: lightningcss is a
    // native addon, and a load failure at module scope inside the workflow
    // step bundle poisons the whole compile module's init (esbuild's __esm
    // marks a module initialized before running its body). A load failure
    // fails ingest; silently skipping CSS would hide a missing binary.
    const { transform } = await import("lightningcss")

    const isAllowedUrl = (value: string): boolean => {
        const normalized = value.trim()
        if (
            normalized.startsWith("/_assets/") ||
            normalized.startsWith("./") ||
            normalized.startsWith("../") ||
            normalized.startsWith("#") ||
            (!normalized.startsWith("/") &&
                !/^[a-z][a-z0-9+.-]*:/i.test(normalized))
        )
            return true
        return isAllowedExternalAssetUrl(normalized, allowedHosts)
    }
    const addSanitized = (message: string): void => {
        diagnostics.push({
            code: "css_sanitized",
            severity: "warn",
            message,
        })
    }

    const rewrittenCss: string[] = []
    for (const file of admitted) {
        try {
            const rewritten = transform({
                filename: file.path,
                code: Buffer.from(file.content),
                minify: false,
                errorRecovery: true,
                visitor: {
                    Url(url) {
                        const resolved = resolveAssetReference({
                            value: url.url,
                            sourcePath: file.path,
                            assetHashes,
                            allowedHosts,
                        })
                        if (resolved.kind === "asset")
                            return { ...url, url: resolved.url }
                        if (resolved.kind === "missing") {
                            diagnostics.push({
                                code: "asset_missing",
                                severity: "warn",
                                message: `CSS references an asset that was not ingested: ${url.url}.`,
                                path: file.path,
                            })
                        }
                    },
                },
            })
            rewrittenCss.push(Buffer.from(rewritten.code).toString("utf8"))
        } catch {
            rewrittenCss.push(file.content)
        }
    }

    let code: Uint8Array
    try {
        const result = transform({
            filename: "tenant.css",
            code: Buffer.from(rewrittenCss.join("\n")),
            minify: false,
            errorRecovery: true,
            visitor: {
                Rule: {
                    import(rule) {
                        try {
                            const parsed = new URL(rule.value.url)
                            if (
                                parsed.protocol === "https:" &&
                                parsed.hostname === "fonts.googleapis.com"
                            ) {
                                fontImports.push(parsed.href)
                                return []
                            }
                        } catch {
                            // not an absolute URL — falls through to removal
                        }
                        addSanitized("Removed a CSS @import rule.")
                        return []
                    },
                    "font-face"(rule) {
                        const invalidSource = rule.value.properties.some(
                            (property) =>
                                property.type === "source" &&
                                property.value.some(
                                    (source) =>
                                        source.type === "url" &&
                                        !isAllowedUrl(source.value.url.url),
                                ),
                        )
                        if (!invalidSource) return
                        addSanitized(
                            "Removed an @font-face rule with a disallowed src URL.",
                        )
                        return []
                    },
                },
                Declaration(declaration) {
                    const serialized = JSON.stringify(declaration)
                    const propertyName =
                        declaration.property === "custom"
                            ? declaration.value.name
                            : declaration.property
                    const urls = [...serialized.matchAll(/"url":"([^"]*)"/g)]
                    const forbiddenUrl = urls.some(
                        (match) => !isAllowedUrl(match[1] ?? ""),
                    )
                    const forbiddenValue =
                        /"name":"expression"/i.test(serialized) ||
                        serialized.includes("<")
                    if (
                        propertyName === "behavior" ||
                        propertyName === "-moz-binding" ||
                        forbiddenUrl ||
                        forbiddenValue
                    ) {
                        addSanitized(
                            `Removed unsafe CSS declaration "${propertyName}".`,
                        )
                        return []
                    }
                },
                RuleExit(rule): ReturnedRule | ReturnedRule[] | undefined {
                    if (rule.type !== "style") return
                    const declarations = rule.value.declarations.declarations
                    const important =
                        rule.value.declarations.importantDeclarations
                    const targetsGlobal = rule.value.selectors.some(
                        (selector) =>
                            selector.some(
                                (component) =>
                                    (component.type === "type" &&
                                        (component.name === "html" ||
                                            component.name === "body")) ||
                                    (component.type === "pseudo-class" &&
                                        component.kind === "root"),
                            ),
                    )
                    const allDeclarations = [...declarations, ...important]
                    const isLayoutDeclaration = (
                        declaration: Declaration,
                    ): boolean =>
                        declaration.property !== "custom" &&
                        LAYOUT_PROPERTIES.has(declaration.property)
                    if (
                        !targetsGlobal ||
                        !allDeclarations.some(isLayoutDeclaration)
                    )
                        return
                    const canScopeSafely = rule.value.selectors.every(
                        (selector) =>
                            selector.length === 1 &&
                            selector.some(
                                (component) =>
                                    (component.type === "type" &&
                                        (component.name === "html" ||
                                            component.name === "body")) ||
                                    (component.type === "pseudo-class" &&
                                        component.kind === "root"),
                            ),
                    )
                    if (!canScopeSafely) {
                        addSanitized(
                            "Removed a global layout rule that could not be safely scoped.",
                        )
                        return []
                    }

                    const customDeclarations = declarations.filter(
                        (declaration) => declaration.property === "custom",
                    )
                    const customImportant = important.filter(
                        (declaration) => declaration.property === "custom",
                    )
                    const scopedDeclarations = declarations.filter(
                        (declaration) => declaration.property !== "custom",
                    )
                    const scopedImportant = important.filter(
                        (declaration) => declaration.property !== "custom",
                    )
                    const scopedRule: ReturnedRule = {
                        ...rule,
                        value: {
                            ...rule.value,
                            selectors: [
                                [{ type: "id", name: "nd-docs-layout" }],
                            ],
                            declarations: {
                                declarations: scopedDeclarations,
                                importantDeclarations: scopedImportant,
                            },
                        },
                    }
                    if (
                        customDeclarations.length === 0 &&
                        customImportant.length === 0
                    )
                        return scopedRule
                    return [
                        {
                            ...rule,
                            value: {
                                ...rule.value,
                                declarations: {
                                    declarations: customDeclarations,
                                    importantDeclarations: customImportant,
                                },
                            },
                        },
                        scopedRule,
                    ]
                },
            },
        })
        code = result.code
        for (const warning of result.warnings) {
            addSanitized(
                `Lightning CSS recovered from invalid CSS: ${warning.message}`,
            )
        }
    } catch (error) {
        addSanitized(
            `Skipped tenant CSS that could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { css: "", diagnostics, fontImports }
    }

    return { css: Buffer.from(code).toString("utf8"), diagnostics, fontImports }
}
