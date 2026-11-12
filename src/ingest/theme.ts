import type {
    Declaration,
    ReturnedRule,
    Selector,
    SelectorComponent,
} from "lightningcss"
import {
    composite,
    parseColor,
    type Rgba,
    readableAccent,
    readableOn,
    toHex,
} from "../lib/color"
import {
    CONFIG_EXTENSION_KEY,
    type Diagnostic,
    type DocsConfigSuperset,
    LAYOUT_PRESET_PALETTES,
    type LayoutPreset,
    THEME_LAYOUT_PRESETS,
    type ThemeTokens,
    themePresetSchema,
} from "../types/docs"
import { PALETTE_TOKENS } from "../types/docs-palettes"
import { isAllowedExternalAssetUrl, resolveAssetReference } from "./assets"
import { translateCssHooks } from "./css-hooks"

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

/** Palette grays that follow a site's primary hue. */
const NEUTRAL_TOKENS = [
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
].map((suffix) => `--color-fd-${suffix}`)
/** Surfaces accent text is set on, and the one its active-row tint
 * (`bg-fd-primary/10`) is laid over: presets whose sidebar sits on a fill
 * mark the active row without a tint. Kept in step with the chrome CSS and
 * checked by tests/theme-contrast.test.ts. */
const ACCENT_SURFACES = ["background", "card", "popover", "muted", "secondary"]
const ACCENT_TINT_BASES = ["background"]
const ACCENT_TINT_ALPHA = 0.1

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
    const tokens: ThemeTokens = structuredClone(
        PALETTE_TOKENS[config?.theme ?? LAYOUT_PRESET_PALETTES[preset]],
    )

    // An explicit null pins the bare preset and disables every derived/config
    // token source. Tenant CSS remains a separate, later cascade layer.
    if (config?.colors === null) return tokens

    const invalidColor = (path: string): void => {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `Invalid color at ${path}; expected #RGB or #RRGGBB.`,
            path,
        })
    }
    const setColor = (
        cssVar: string,
        value: string | { light: string; dark: string } | undefined,
        path: string,
    ): boolean => {
        if (value === undefined) return false
        const valid =
            typeof value === "string"
                ? HEX_COLOR.test(value)
                : HEX_COLOR.test(value.light) && HEX_COLOR.test(value.dark)
        if (valid) tokens[cssVar] = value
        else invalidColor(path)
        return valid
    }
    const hexAt = (
        value: string | undefined,
        path: string,
    ): string | undefined => {
        if (value === undefined || HEX_COLOR.test(value)) return value
        invalidColor(path)
        return undefined
    }

    // Mintlify semantics: `primary` is the light-mode accent, `light` the
    // dark-mode accent, `dark` the button and hover fill in both modes; each
    // falls back to `primary`, and a logo accent stands in for a missing
    // `primary`.
    const colors = config?.colors
    const primary =
        hexAt(colors?.primary, "colors.primary") ??
        hexAt(detectedAccent, "detectedAccent")
    const accentSources = {
        light: primary,
        dark: hexAt(colors?.light, "colors.light") ?? primary,
    }
    const button = hexAt(colors?.dark, "colors.dark") ?? primary

    // Neutrals follow the primary hue: a green brand reads as green-gray
    // chrome and a green-black dark page, as Mintlify themes do. Re-tint the
    // palette's neutral grays with the primary's hue (saturation capped so
    // they stay gray, not a brand wash); the light page stays as the theme
    // set it. Explicit background.color below still overrides.
    const hueSource = parseColor(primary ?? accentSources.dark ?? "")
    if (hueSource) {
        const [r, g, b] = hueSource.map((channel) => channel / 255)
        const max = Math.max(r ?? 0, g ?? 0, b ?? 0)
        const min = Math.min(r ?? 0, g ?? 0, b ?? 0)
        let hue = 0
        if (
            max !== min &&
            r !== undefined &&
            g !== undefined &&
            b !== undefined
        ) {
            const d = max - min
            if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60
            else if (max === g) hue = ((b - r) / d + 2) * 60
            else hue = ((r - g) / d + 4) * 60
        }
        const primaryHue = Math.round(hue)
        const NEUTRAL_HSL =
            /^hsl(a?)\((\d+(?:\.\d+)?), ?(\d+(?:\.\d+)?)%, ?([^)]+)\)$/
        const tint = (value: string): string => {
            const match = NEUTRAL_HSL.exec(value)
            if (!match) return value
            const saturation = Math.min(Number.parseFloat(match[3] ?? "0"), 12)
            return `hsl${match[1]}(${primaryHue}, ${saturation}%, ${match[4]})`
        }
        // NEUTRAL surfaces only — semantic/brand tokens (primary, ring,
        // info/warning/error/success) keep their own hue and saturation.
        for (const name of NEUTRAL_TOKENS) {
            const value = tokens[name]
            if (value === undefined || typeof value === "string") continue
            tokens[name] = {
                light:
                    name === "--color-fd-background"
                        ? value.light
                        : tint(value.light),
                dark: tint(value.dark),
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

    // Accent text must stay readable wherever it lands: on the page, cards,
    // popovers and fills, and on the 10% tint of itself that marks the
    // active sidebar row. A brand color that falls short in a scheme moves
    // along lightness until it clears 4.5:1 (src/lib/color.ts); one that
    // already passes is kept exactly.
    if (accentSources.light !== undefined || accentSources.dark !== undefined) {
        const accent = { light: "", dark: "" }
        for (const scheme of ["light", "dark"] as const) {
            const surface = (name: string): Rgba | null => {
                const value = tokens[`--color-fd-${name}`]
                if (value === undefined) return null
                return parseColor(
                    typeof value === "string" ? value : value[scheme],
                )
            }
            const page = surface("background")
            const on = (names: string[]) =>
                names.flatMap((name) => {
                    const color = surface(name)
                    return color ? [page ? composite(color, page) : color] : []
                })
            const source = accentSources[scheme]
            const current = tokens["--color-fd-primary"]
            const fallback =
                typeof current === "string" ? current : current?.[scheme]
            const base = parseColor(source ?? fallback ?? "")
            if (!base) continue
            accent[scheme] =
                source === undefined
                    ? (fallback ?? "")
                    : toHex(
                          readableAccent(
                              base,
                              {
                                  page,
                                  surfaces: on(ACCENT_SURFACES),
                                  tintBases: on(ACCENT_TINT_BASES),
                                  tintAlpha: ACCENT_TINT_ALPHA,
                              },
                              scheme,
                          ),
                      )
        }
        if (accent.light && accent.dark) {
            tokens["--color-fd-primary"] = accent
            // Focus rings follow the accent, which clears 4.5:1 (over the
            // 3:1 a focus indicator needs) on every surface it was fit to.
            tokens["--color-fd-ring"] = accent
        }
    }
    if (button !== undefined) {
        const fill = parseColor(button)
        if (fill) {
            tokens["--margin-button"] = button
            tokens["--margin-button-foreground"] = readableOn(fill)
        }
    }

    let explicitPrimaryForeground = false
    for (const [name, value] of Object.entries(
        config?.[CONFIG_EXTENSION_KEY]?.tokens ?? {},
    )) {
        if (!DOCUMENTED_COLOR_TOKENS.has(name)) continue
        const applied = setColor(
            `--color-fd-${name}`,
            value,
            `${CONFIG_EXTENSION_KEY}.tokens.${name}`,
        )
        if (name === "primary-foreground" && applied)
            explicitPrimaryForeground = true
    }

    // Text on primary fills: black or white per scheme, whichever reads
    // better, unless the site set it.
    const finalPrimary = tokens["--color-fd-primary"]
    if (!explicitPrimaryForeground && finalPrimary !== undefined) {
        const light = parseColor(
            typeof finalPrimary === "string"
                ? finalPrimary
                : finalPrimary.light,
        )
        const dark = parseColor(
            typeof finalPrimary === "string" ? finalPrimary : finalPrimary.dark,
        )
        if (light && dark)
            tokens["--color-fd-primary-foreground"] = {
                light: readableOn(light),
                dark: readableOn(dark),
            }
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

    const googleFontsImport = (url: string): string | null => {
        try {
            const parsed = new URL(url)
            return parsed.protocol === "https:" &&
                parsed.hostname === "fonts.googleapis.com"
                ? parsed.href
                : null
        } catch {
            return null
        }
    }
    // Margin selectors from the hook table, parsed once each.
    const parsedSelectors = new Map<string, Selector[]>()
    const parseSelectors = (selectorList: string): Selector[] => {
        const known = parsedSelectors.get(selectorList)
        if (known) return known
        let parsed: Selector[] = []
        transform({
            filename: "hook.css",
            code: Buffer.from(`${selectorList}{top:0}`),
            visitor: {
                Rule: {
                    style(rule) {
                        parsed = rule.value.selectors
                    },
                },
            },
        })
        parsedSelectors.set(selectorList, parsed)
        return parsed
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
                    // Each file is its own stylesheet, so its font imports
                    // are read here: joined to the files before it, an
                    // @import no longer leads the sheet and is discarded.
                    Rule: {
                        import(rule) {
                            const href = googleFontsImport(rule.value.url)
                            if (href === null) return
                            fontImports.push(href)
                            return []
                        },
                    },
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
                        // Reached only when a file's own pass failed to
                        // parse and its source was joined unchanged.
                        const href = googleFontsImport(rule.value.url)
                        if (href !== null) fontImports.push(href)
                        else addSanitized("Removed a CSS @import rule.")
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
                Selector(selector) {
                    return translateCssHooks(selector, parseSelectors)
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
                    // A selector that names the root is global unless its
                    // subject (the last compound) is a specific element:
                    // `html[data-current-path^="/api"] #banner` reads the
                    // root's state and styles the banner, while `html > *`,
                    // `body div` and `html > :is(body, .shell)` still lay
                    // out the whole shell.
                    const namesRoot = (component: SelectorComponent) =>
                        (component.type === "type" &&
                            (component.name === "html" ||
                                component.name === "body")) ||
                        (component.type === "pseudo-class" &&
                            component.kind === "root")
                    const subjectOf = (selector: Selector): Selector =>
                        selector.slice(
                            selector
                                .map((component) => component.type)
                                .lastIndexOf("combinator") + 1,
                        )
                    // :is() and :where() match whatever any branch matches.
                    const branches = (component: SelectorComponent) =>
                        component.type === "pseudo-class" &&
                        (component.kind === "is" || component.kind === "where")
                            ? component.selectors
                            : null
                    const reachesRoot = (compound: Selector): boolean =>
                        compound.some(
                            (component) =>
                                namesRoot(component) ||
                                (branches(component)?.some((branch) =>
                                    reachesRoot(subjectOf(branch)),
                                ) ??
                                    false),
                        )
                    const isSpecific = (compound: Selector): boolean =>
                        compound.some(
                            (component) =>
                                component.type === "id" ||
                                component.type === "class" ||
                                component.type === "attribute" ||
                                (branches(component)?.every((branch) =>
                                    isSpecific(subjectOf(branch)),
                                ) ??
                                    false),
                        )
                    const targetsGlobal = rule.value.selectors.some(
                        (selector) => {
                            if (!selector.some(namesRoot)) return false
                            const subject = subjectOf(selector)
                            return reachesRoot(subject) || !isSpecific(subject)
                        },
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
