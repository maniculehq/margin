import { z } from "zod"
import { CONFIG_EXTENSION_KEY, DOCS_SITE_STATUSES } from "./constants"
import { isAllowedUrl } from "./docs-shared"

export { CONFIG_EXTENSION_KEY, DOCS_SITE_STATUSES } from "./constants"

export {
    applyRedirectPattern,
    DOCS_API_PLAYGROUND_DISPLAYS,
    type DocsApiConfig,
    docsApiConfigSchema,
    docsSiteUrl,
    formatDocsPath,
    isAllowedUrl,
    matchRedirect,
    parseRedirectPattern,
    type RedirectPatternPart,
    redirectCaptureTokens,
    resolveDocsApiConfig,
} from "./docs-shared"

export const CONFIG_EXTENSION_VERSION_KEY: `${typeof CONFIG_EXTENSION_KEY}-version` = `${CONFIG_EXTENSION_KEY}-version`
export const CONFIG_EXTENSION_VERSION_DEFAULT_KEY: `${typeof CONFIG_EXTENSION_KEY}-version-default` = `${CONFIG_EXTENSION_KEY}-version-default`

// ---------------------------------------------------------------------------
// Docs sites — canonical value tuples shared by the Drizzle pgEnums, the
// ingest pipeline, and serving.
// ---------------------------------------------------------------------------

export type DocsSiteStatus = (typeof DOCS_SITE_STATUSES)[number]
export const docsSiteStatusSchema = z.enum(DOCS_SITE_STATUSES)

/**
 * Whether a site's configured analytics integrations (GA4, PostHog, …)
 * run in the browser. "off" suppresses them, including for test fixtures
 * that retain third-party analytics keys.
 */
export const DOCS_SITE_ANALYTICS_MODES = ["tenant", "off"] as const
export type DocsSiteAnalyticsMode = (typeof DOCS_SITE_ANALYTICS_MODES)[number]

/** Preview hosts use a fixed abbreviated commit SHA in their DNS label. */
export const DOCS_PREVIEW_SHA_LENGTH = 7
export const DOCS_PREVIEW_SHA_LABEL = /^[0-9a-f]{7}$/
/** Reserved start of a flat preview label: <sha7>-<site>. */
export const DOCS_PREVIEW_HOST_PREFIX = /^[0-9a-f]{7}-/

/**
 * Site slug: one DNS label of at most 55 characters, so a <sha7>- preview
 * prefix still fits DNS's 63-character label limit.
 */
export const docsSiteSlugSchema = z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .max(55)

export const docsHostnameSchema = z
    .string()
    .min(3)
    .max(255)
    .toLowerCase()
    .refine((hostname) => {
        try {
            const url = new URL(`https://${hostname}`)
            return (
                url.hostname === hostname &&
                url.host === hostname &&
                !hostname.startsWith(".") &&
                !hostname.endsWith(".")
            )
        } catch {
            return false
        }
    }, "Expected a hostname without a scheme, path, credentials, or port")

export const DOCS_CONTENT_VERSION_STATUSES = [
    "building",
    "ready",
    "failed",
    "superseded",
] as const
export type DocsContentVersionStatus =
    (typeof DOCS_CONTENT_VERSION_STATUSES)[number]
export const docsContentVersionStatusSchema = z.enum(
    DOCS_CONTENT_VERSION_STATUSES,
)

export const DOCS_CONTENT_VERSION_KINDS = ["production", "preview"] as const
export type DocsContentVersionKind = (typeof DOCS_CONTENT_VERSION_KINDS)[number]
export const docsContentVersionKindSchema = z.enum(DOCS_CONTENT_VERSION_KINDS)

/**
 * Who a failed build's error text is for. content = the author's docs broke
 * (compile violations, empty snapshot); internal = an unexpected pipeline
 * exception (database or storage), raw and Sentry-reported, for operators.
 */
export const DOCS_BUILD_ERROR_KINDS = ["content", "internal"] as const
export type DocsBuildErrorKind = (typeof DOCS_BUILD_ERROR_KINDS)[number]
export const docsBuildErrorKindSchema = z.enum(DOCS_BUILD_ERROR_KINDS)

/**
 * JSX components allowed in client MDX — THE canonical allow-list. Ingest
 * (src/ingest/validate.ts) rejects any capitalized JSX element not in
 * this tuple; the framework's MDX component map must provide exactly these.
 * Everything else in client content is markdown or plain lowercase HTML
 * elements (dangerous tags/attributes are separately denied at ingest).
 */
export const ALLOWED_MDX_COMPONENTS = [
    "Agent",
    "Human",
    "Visibility",
    "Callout",
    "Note",
    "Info",
    "Tip",
    "Warning",
    "Check",
    "Accordion",
    "AccordionGroup",
    "Badge",
    "Card",
    "CardGroup",
    "Image",
    "ParamField",
    "ResponseField",
    "Tab",
    "Tabs",
    "CodeGroup",
    "Columns",
    "Frame",
    "Snippet",
    "Step",
    "Steps",
    "Tooltip",
    "Update",
    "Mermaid",
    "Expandable",
    "Icon",
    "Prompt",
    "Danger",
    "RequestExample",
    "ResponseExample",
    "FileTree",
    "Tree",
    "PreviewButton",
    "Panel",
    "Tile",
    "Color",
    "View",
    "GitHub",
] as const
export type AllowedMdxComponent = (typeof ALLOWED_MDX_COMPONENTS)[number]

/**
 * Member components reachable as <Root.Member> — the framework attaches
 * exactly these to the root component object. A member expression outside
 * this map dereferences undefined at render time, so ingest validates
 * against it rather than authorizing any dotted name by its root.
 */
export const ALLOWED_MDX_COMPONENT_MEMBERS: Readonly<
    Partial<Record<AllowedMdxComponent, readonly string[]>>
> = {
    Tree: ["File", "Folder"],
    FileTree: ["File", "Folder"],
    Color: ["Item", "Row"],
    GitHub: ["Repo"],
}

/**
 * Page kinds in docs_page: "mdx" rows carry compiled MDX artifacts; "openapi"
 * rows are synthesized at ingest from a tenant's OpenAPI spec and carry
 * openapiProps instead (rendered by fumadocs-openapi's OpenAPIPage).
 */
export const DOCS_PAGE_KINDS = ["mdx", "openapi"] as const
export type DocsPageKind = (typeof DOCS_PAGE_KINDS)[number]
export const docsPageKindSchema = z.enum(DOCS_PAGE_KINDS)

/**
 * One OpenAPI reference section, from a tenant's docs.json `openapi` array.
 * Convention-discovered specs (openapi.yaml etc.) synthesize the same shape
 * with defaults; a config entry with the same id overrides the convention.
 */
export const docsOpenapiConfigEntrySchema = z.object({
    /** Stable doc id, also the schema id passed to fumadocs-openapi. */
    id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Spec file path relative to the docs root. */
    spec: z.string().min(1).max(500),
    /** Nav section title. */
    label: z.string().min(1).max(255).default("API Reference"),
    /** URL folder under the docs root the generated pages live in. */
    path: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[a-z0-9][a-z0-9/-]*$/)
        .default("api-reference"),
})
export type DocsOpenapiConfigEntry = z.infer<
    typeof docsOpenapiConfigEntrySchema
>

/** Shared by ingest and proxy: allow public HTTP(S) origins, reject private/local address ranges and hostnames. WHATWG URL normalizes numeric-IP tricks; a name that RESOLVES privately (DNS rebinding included) is refused by the proxy's connect-time lookup, not here. */
export function isPublicDocsApiOrigin(origin: string): boolean {
    let url: URL
    try {
        url = new URL(origin)
    } catch {
        return false
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    // `localhost.` is `localhost`: the root label's dot is not a new name.
    const host = url.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase()
    if (
        host === "" ||
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".home.arpa")
    )
        return false
    // null → not an IPv4 dotted quad; boolean → verdict for the quad.
    const v4Public = (quad: string): boolean | null => {
        const m = quad.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
        if (!m) return null
        const a = Number(m[1])
        const b = Number(m[2])
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            a >= 224
        )
    }
    const hostAsV4 = v4Public(host)
    if (hostAsV4 !== null) return hostAsV4
    if (host.includes(":")) {
        if (host === "::" || host === "::1") return false
        // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local.
        if (/^(fc|fd|fe[89a-f])/.test(host)) return false
        // v4-mapped: WHATWG serializes ::ffff:127.0.0.1 as hex groups
        // (::ffff:7f00:1) — decode back to the dotted quad and apply the
        // IPv4 ranges, never reparse the hex as a hostname.
        const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
        if (mappedHex?.[1] && mappedHex[2]) {
            const hi = Number.parseInt(mappedHex[1], 16)
            const lo = Number.parseInt(mappedHex[2], 16)
            return (
                v4Public(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) ===
                true
            )
        }
        // Defensive: some parsers keep the dotted form after ::ffff:.
        const mappedDotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
        if (mappedDotted?.[1]) return v4Public(mappedDotted[1]) === true
        // Any other ::ffff: shape is malformed — fail closed.
        if (host.startsWith("::ffff:")) return false
    }
    return true
}

/** OpenAPI 3.2 operation methods — mirrors fumadocs-openapi's HttpMethods union. */
export const DOCS_OPENAPI_HTTP_METHODS = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
    "query",
] as const
export const docsOpenapiHttpMethodSchema = z.enum(DOCS_OPENAPI_HTTP_METHODS)

/**
 * Serialized fumadocs-openapi page props stored on kind="openapi" docs_page
 * rows — everything `getOpenAPIPageProps()` returned at ingest EXCEPT the
 * `payload` (the bundled document lives once per version in
 * docs_openapi_document; serving reattaches it plus the proxy URL).
 */
export const docsPageOpenapiPropsSchema = z.object({
    /** Schema id — matches docs_openapi_document.docId. */
    document: z.string().min(1).max(64),
    showTitle: z.boolean().optional(),
    showDescription: z.boolean().optional(),
    operations: z
        .array(
            z.object({
                path: z.string(),
                method: docsOpenapiHttpMethodSchema,
                tags: z.array(z.string()).optional(),
            }),
        )
        .optional(),
    webhooks: z
        .array(
            z.object({
                name: z.string(),
                method: docsOpenapiHttpMethodSchema,
            }),
        )
        .optional(),
})
export type DocsPageOpenapiProps = z.infer<typeof docsPageOpenapiPropsSchema>

// Page layout modes (§4.2), driven by frontmatter `mode` → a framework CSS
// layout class.
export const PAGE_MODES = [
    "default",
    "center",
    "wide",
    "custom",
    "frame",
] as const
export const pageModeSchema = z.enum(PAGE_MODES)
export type PageMode = z.infer<typeof pageModeSchema>

// Background decorations (§4.2): `background.decoration` → a framework-owned
// backdrop. `gradient`/`grid` are pure CSS; `windows` also mounts a
// framework-shipped component. Selected by the data value; no tenant code.
export const DECORATIONS = ["gradient", "grid", "windows"] as const
export const decorationSchema = z.enum(DECORATIONS)
export type Decoration = z.infer<typeof decorationSchema>

function isPublicHttpUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            isPublicDocsApiOrigin(url.origin) &&
            url.hostname.length > 0 &&
            url.username.length === 0 &&
            url.password.length === 0
        )
    } catch {
        return false
    }
}

function isSafeSeoLogoUrl(value: string): boolean {
    const scheme = value.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase()
    return scheme
        ? isPublicHttpUrl(value)
        : !value.startsWith("//") && isAllowedUrl(value)
}

const docsSeoIdentityUrlSchema = z.string().refine(isPublicHttpUrl, {
    message: "Expected an absolute public HTTP(S) URL without credentials",
})

/** Page frontmatter contract for client MDX. Extra keys pass through to the stored frontmatter jsonb. */
export const docsFrontmatterSchema = z
    .object({
        title: z.string().min(1).max(255).optional(),
        /** Shorter label for nav trees; the H1 keeps `title`. */
        sidebarTitle: z.string().min(1).max(255).optional(),
        /** Short badge after the sidebar label ("New", "Beta"). */
        tag: z.string().min(1).max(24).optional(),
        description: z.string().max(2000).optional(),
        icon: z.string().max(255).optional(),
        hidden: z.boolean().optional(),
        searchable: z.boolean().optional(),
        mode: z.enum(PAGE_MODES).optional(),
        sidebar_position: z.number().optional(),
        order: z.number().optional(),
        timestamp: z.boolean().optional(),
        api: z.string().optional(),
        /**
         * Operation reference: `"[<spec path>] METHOD /path"` or
         * `"[<spec path>] webhook <name>"` — the page renders its authored
         * MDX body plus the generated API console for that operation.
         */
        openapi: z.string().optional(),
        ogImage: z.string().optional(),
        /**
         * Explicit derivative-source declaration. `true` maps the served URL
         * under the config extension's seo.provenance.baseUrl; object form
         * overrides it.
         */
        provenance: z
            .union([
                z.literal(true),
                z.object({ sourceUrl: docsSeoIdentityUrlSchema }),
            ])
            .optional(),
        /**
         * External page: the nav entry links out, and visiting the
         * internal route redirects to that destination.
         */
        url: z.string().optional(),
        /**
         * Page-level contextual override — REPLACES the global
         * docs.json contextual config for this page; `options: []` disables
         * the menu. An invalid shape falls back to the global config (the
         * catch keeps a bad authored value from failing the whole
         * frontmatter parse at serve).
         */
        contextual: z
            .object({
                options: z
                    .array(
                        z.union([
                            z.string(),
                            z.record(z.string(), z.unknown()),
                        ]),
                    )
                    .optional(),
                display: z.enum(["header", "toc"]).optional(),
            })
            .optional()
            .catch(undefined),
    })
    .passthrough()
export type DocsFrontmatter = z.infer<typeof docsFrontmatterSchema>

/**
 * meta.json contract (fumadocs page-tree ordering/grouping).
 * Keep in sync with src/lib/source.ts metaDataSchema.
 */
export const docsMetaFileSchema = z
    .object({
        title: z.string().max(255).optional(),
        description: z.string().max(2000).optional(),
        icon: z.string().max(255).optional(),
        pages: z.array(z.string()).optional(),
        root: z.boolean().optional(),
        defaultOpen: z.boolean().optional(),
        collapsible: z.boolean().optional(),
        pagesIndex: z.string().optional(),
        [CONFIG_EXTENSION_VERSION_KEY]: z.string().optional(),
        [CONFIG_EXTENSION_VERSION_DEFAULT_KEY]: z.boolean().optional(),
    })
    .passthrough()
export type DocsMetaFile = z.infer<typeof docsMetaFileSchema>

/**
 * Content version a request serves: "current" is the site's current
 * version; a preview selector names the version built from that commit.
 */
export const docsVersionSelectorSchema = z.union([
    z.literal("current"),
    z.object({
        kind: z.literal("preview"),
        sha: z.string().regex(DOCS_PREVIEW_SHA_LABEL),
    }),
])
export type DocsVersionSelector = z.infer<typeof docsVersionSelectorSchema>

export const THEME_PRESETS = [
    "mint",
    "maple",
    "palm",
    "willow",
    "linden",
    "almond",
    "aspen",
    "sequoia",
    "luma",
] as const
export const themePresetSchema = z.enum(THEME_PRESETS)
export type ThemePreset = z.infer<typeof themePresetSchema>
// Framework-owned layout presets (§4.2): each docs.json `theme` maps to one of
// these; the framework ships a CSS + fixed-component implementation per value.
// `neutral` is the zero-config default. → pgEnum docs_layout_preset.
export const LAYOUT_PRESETS = [
    "neutral",
    "editorial",
    "warm",
    "verdant",
    "aspen",
    "dusk",
    "contrast",
] as const
export const layoutPresetSchema = z.enum(LAYOUT_PRESETS)
export type LayoutPreset = z.infer<typeof layoutPresetSchema>

export const themeTokenValueSchema = z.union([
    z.string(),
    z.object({ light: z.string(), dark: z.string() }),
])
export const themeTokensSchema = z.record(z.string(), themeTokenValueSchema)
export type ThemeTokens = z.infer<typeof themeTokensSchema>

export const versionsManifestSchema = z.array(
    z.object({
        label: z.string(),
        directory: z.string(),
        default: z.boolean(),
        seq: z.number(),
        href: z.string().optional(),
        /** True when the version root belongs to a titled navigation container;
         * its switcher stays with that container, not the global version menu. */
        nested: z.boolean().optional(),
        /**
         * docs.json version.hidden — the version stays routable under its
         * label prefix but is omitted from the global switcher.
         */
        hidden: z.boolean().optional(),
        /** docs.json version.tag — a badge beside the switcher entry. */
        tag: z.string().optional(),
    }),
)
export type VersionsManifest = z.infer<typeof versionsManifestSchema>

/**
 * Palette for a layout preset reached without a docs.json `theme` (zero
 * config). A `theme` selects its own palette: PALETTE_TOKENS is keyed by
 * theme name.
 */
export const LAYOUT_PRESET_PALETTES: Record<LayoutPreset, ThemePreset> = {
    neutral: "mint",
    editorial: "mint",
    warm: "maple",
    verdant: "palm",
    aspen: "aspen",
    dusk: "sequoia",
    contrast: "luma",
}

export const THEME_LAYOUT_PRESETS: Record<ThemePreset, LayoutPreset> = {
    mint: "neutral",
    linden: "neutral",
    maple: "warm",
    almond: "warm",
    palm: "verdant",
    willow: "verdant",
    aspen: "aspen",
    sequoia: "dusk",
    luma: "contrast",
}
export const ICON_LIBRARIES = ["lucide", "fontawesome", "tabler"] as const
export const iconLibrarySchema = z.enum(ICON_LIBRARIES)
export type IconLibrary = z.infer<typeof iconLibrarySchema>
export const INDEXING_MODES = ["navigable", "all"] as const
export const indexingModeSchema = z.enum(INDEXING_MODES)
export type IndexingMode = z.infer<typeof indexingModeSchema>
export const APPEARANCE_MODES = ["system", "light", "dark"] as const
export const appearanceModeSchema = z.enum(APPEARANCE_MODES)
export type AppearanceMode = z.infer<typeof appearanceModeSchema>
export const BANNER_TYPES = ["info", "warning", "critical"] as const
export const bannerTypeSchema = z.enum(BANNER_TYPES)
export type BannerType = z.infer<typeof bannerTypeSchema>
export const TAB_MODES = ["top", "auto"] as const
export const tabModeSchema = z.enum(TAB_MODES)

/**
 * Desktop chrome structure. "band" = full-width sticky top bar + horizontal
 * tab strip (mint family); "sidenav" = no desktop top bar, logo/search/theme
 * and the nav tabs render vertically at the top of the sidebar (the maple
 * theme). Derived from `theme` at serve time; the config extension's
 * `layout.chromeMode` is the authored override.
 */
export const CHROME_MODES = ["band", "sidenav"] as const
export const chromeModeSchema = z.enum(CHROME_MODES)
export type ChromeMode = z.infer<typeof chromeModeSchema>
export type TabMode = z.infer<typeof tabModeSchema>
export const SEARCH_MODES = ["ai", "static", "off"] as const
export const searchModeSchema = z.enum(SEARCH_MODES)
export type SearchMode = z.infer<typeof searchModeSchema>

// Dispositions (§0.3) → pgEnum docs_config_disposition
export const CONFIG_DISPOSITIONS = [
    "supported",
    "adapted",
    "ignored",
    "extended",
] as const
export const configDispositionSchema = z.enum(CONFIG_DISPOSITIONS)
export type ConfigDisposition = z.infer<typeof configDispositionSchema>
// nav_source (§6.2) → pgEnum docs_nav_source
export const NAV_SOURCES = ["filesystem", "config"] as const
export const navSourceSchema = z.enum(NAV_SOURCES)
export type NavSource = z.infer<typeof navSourceSchema>
// Diagnostics (§1.10) → pgEnum docs_diagnostic_severity / docs_diagnostic_code
export const DIAGNOSTIC_SEVERITIES = ["info", "warn", "error"] as const
export const diagnosticSeveritySchema = z.enum(DIAGNOSTIC_SEVERITIES)
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>
export const DIAGNOSTIC_CODES = [
    "config_dual",
    "css_multiple",
    "css_sanitized",
    "css_oversize",
    "unknown_field",
    "field_invalid",
    "js_snippet_rejected",
    "logo_multiple",
    "asset_missing",
    "asset_oversize",
    "icon_lib_unsupported",
    "icon_unresolved",
    "integration_unsupported",
    "redirect_invalid",
    "redirect_shadows_page",
    "head_rejected",
    "i18n_deferred",
    "locale_shadowed",
    "locale_unpartitioned",
    "version_ambiguous",
    "version_no_default",
    "version_multiple_default",
    "openapi_orphaned",
    "openapi_ref_unresolved",
    "theme_unmapped",
    "content_suspect",
    "link_broken",
    "snippet_missing",
    "component_unknown",
    "esm_stripped",
    // Appended (not sorted in): Postgres enum values are append-only without
    // a type rebuild, and docs_diagnostic_code mirrors this tuple's order.
    "unsupported_field",
    "freshness_partial",
    "ssr_fallback",
] as const
export const diagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES)
export type DiagnosticCode = z.infer<typeof diagnosticCodeSchema>

export const diagnosticSchema = z.object({
    code: z.enum(DIAGNOSTIC_CODES),
    severity: z.enum(DIAGNOSTIC_SEVERITIES),
    message: z.string(),
    path: z.string().optional(),
})

// ── Primitives ──
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
// `z.ZodType` (not the `any`-aliased `z.ZodTypeAny`) so no `any` leaks into the
// helper; the concrete `T` is inferred at each call site.
const lightDark = <T extends z.ZodType>(inner: T) =>
    z.object({ light: inner, dark: inner })

const colorsSchema = z.object({
    primary: hexColor, // Mintlify-required; optional in our superset via .optional() below
    light: hexColor.optional(),
    dark: hexColor.optional(),
})

const logoSchema = z.union([
    z.string().min(3),
    z.object({
        light: z.string(),
        dark: z.string(),
        href: z.string().url().optional(),
    }),
])

const faviconSchema = z.union([z.string(), lightDark(z.string())])

// A per-role font face carries the full self-host surface, so the split form
// keeps source/format for @font-face emission (Minor: split fonts must not
// silently drop source/format).
const fontFaceSchema = z.object({
    family: z.string().optional(),
    weight: z.number().optional(),
    source: z.string().optional(),
    format: z.enum(["woff", "woff2"]).optional(),
})

const fontsSchema = z
    .object({
        family: z.string().optional(),
        weight: z.number().optional(),
        source: z.string().optional(),
        format: z.enum(["woff", "woff2"]).optional(),
        heading: fontFaceSchema.optional(),
        body: fontFaceSchema.optional(),
        mono: fontFaceSchema.optional(),
    })
    .passthrough()

// Navigation containers can nest the same node types as the root, so these
// schemas are mutually recursive. The child matrix follows the docs.json grammar;
// explicitly modeling it prevents valid children from being lost to passthrough.
export type ColorPair = { light: string; dark: string }
export type PageRef = string | { href: string } | GroupNode

/**
 * docs.json nav-node SDK reference: a generated-docs artifact (typedoc-first)
 * whose pages join the node. Validated strictly at ingest (src/ingest/sdk.ts); this is the authored-config shape.
 */
export interface SdkNavRef {
    format: string
    source: string
    directory?: string
}

export interface GroupNode {
    group: string
    pages: PageRef[]
    root?: string
    icon?: string
    tag?: string
    expanded?: boolean
    hidden?: boolean
    searchable?: boolean
    boost?: number
    public?: boolean
    directory?: string
    openapi?: string
    asyncapi?: string
    sdk?: SdkNavRef
}
export interface MenuItemNode {
    item: string // required discriminant (mega-menu entry)
    icon?: string
    description?: string
    href?: string
    hidden?: boolean
    directory?: string
    groups?: GroupNode[]
    pages?: PageRef[]
    tabs?: TabNode[]
    dropdowns?: DropdownNode[]
    anchors?: AnchorNode[]
    products?: ProductNode[]
    versions?: VersionNode[]
    languages?: LanguageNode[]
    openapi?: string
    asyncapi?: string
    global?: GlobalNode
    /** Ingest-resolved served URL of the item's first page (stored only on
     * __resolvedNav tabs) — the header menu's landing link when the item
     * has no `href`. */
    resolvedHref?: string
    /** Ingest-resolved membership of the item's own subtree (see
     * TabNode.resolvedPages): menu items are sidebar sections, so the
     * serve side scopes the sidebar to the item holding the page. */
    resolvedPages?: string[]
    resolvedGroups?: ResolvedTabGroup[]
}
export interface TabNode {
    tab: string // required discriminant
    icon?: string
    href?: string
    hidden?: boolean
    searchable?: boolean
    align?: "start" | "end"
    directory?: string
    openapi?: string
    asyncapi?: string
    sdk?: SdkNavRef
    languages?: LanguageNode[]
    versions?: VersionNode[]
    // Anchors are full containers and promote to tabs (splitAnchorTabs) —
    // their authored nested tabs ride along.
    tabs?: TabNode[]
    dropdowns?: DropdownNode[]
    menu?: MenuItemNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
    global?: GlobalNode
    /**
     * Ingest-resolved membership (compileNavigation, stored only on
     * __resolvedNav tabs): the exact source paths of every page under this
     * tab, and the served URL of its first page. Tabs may span mixed
     * directories (bun's Runtime = repo root + runtime/), so serve-time
     * sidebar scoping and active-tab state key off membership, not prefixes.
     */
    resolvedPages?: string[]
    resolvedHref?: string
    /**
     * Ingest-resolved sidebar structure for this tab: the authored group
     * hierarchy with every page ref resolved to its source path. The serve
     * side synthesizes the tab's page tree from this — the merged tree's
     * meta rows are lossy (several groups can collapse onto one directory).
     */
    resolvedGroups?: ResolvedTabGroup[]
}

/** One authored navigation group, page refs resolved (see TabNode.resolvedGroups). */
export interface ResolvedTabGroup {
    /** Absent for the tab's loose top-level pages. */
    title?: string
    icon?: string
    expanded?: boolean
    /**
     * Source path of the group's landing page (docs.json groups[].root — the
     * page that opens when clicking the group title). Rendered as the
     * folder's index in tab-scoped sidebars.
     */
    root?: string
    entries: ResolvedTabEntry[]
}

export type ResolvedTabEntry =
    | { page: string }
    | { href: string; label: string }
    | { group: ResolvedTabGroup }
export interface DropdownNode {
    dropdown: string // required discriminant
    icon?: string
    href?: string
    description?: string
    color?: ColorPair
    hidden?: boolean
    directory?: string
    languages?: LanguageNode[]
    versions?: VersionNode[]
    tabs?: TabNode[]
    anchors?: AnchorNode[]
    products?: ProductNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
}
export interface AnchorNode {
    anchor: string // required discriminant
    href?: string
    icon?: string
    color?: ColorPair
    hidden?: boolean
    directory?: string
    // Anchors can carry an OpenAPI-only section in docs.json.
    // Object-form refs ({source, directory}) are
    // normalized to this string in parseDocsConfig before validation.
    openapi?: string
    // Anchors are full navigation containers and can nest SDK
    // versions as anchors[].dropdowns[].versions[].
    languages?: LanguageNode[]
    versions?: VersionNode[]
    tabs?: TabNode[]
    dropdowns?: DropdownNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
}
export interface VersionNode {
    version: string // required discriminant
    href?: string // external-site version (§5.2): no directory, becomes a switcher link
    default?: boolean
    hidden?: boolean
    tag?: string
    directory?: string
    openapi?: string
    asyncapi?: string
    languages?: LanguageNode[]
    tabs?: TabNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
    global?: GlobalNode
}
export interface LanguageNode {
    language: string // required discriminant (ISO 639-1)
    href?: string
    default?: boolean
    hidden?: boolean
    directory?: string
    openapi?: string
    asyncapi?: string
    versions?: VersionNode[]
    tabs?: TabNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
    global?: GlobalNode
}
export interface ProductNode {
    product: string // required discriminant
    name?: string
    href?: string
    icon?: string
    color?: ColorPair
    description?: string
    hidden?: boolean
    directory?: string
    openapi?: string
    asyncapi?: string
    languages?: LanguageNode[]
    versions?: VersionNode[]
    tabs?: TabNode[]
    anchors?: AnchorNode[]
    groups?: GroupNode[]
    pages?: PageRef[]
    menu?: MenuItemNode[]
    global?: GlobalNode
}
export interface GlobalNode {
    languages?: LanguageNode[]
    versions?: VersionNode[]
    tabs?: TabNode[]
    dropdowns?: DropdownNode[]
    anchors?: AnchorNode[]
    products?: ProductNode[]
}

export const groupNodeSchema: z.ZodType<GroupNode> = z.lazy(() =>
    z
        .object({
            group: z.string(),
            pages: z.array(pageRefSchema).default([]),
            root: z.string().optional(),
            icon: z.string().optional(),
            tag: z.string().optional(),
            expanded: z.boolean().optional(),
            hidden: z.boolean().optional(),
            searchable: z.boolean().optional(),
            boost: z.number().optional(),
            public: z.boolean().optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
        })
        .passthrough(),
)

// A bare page string, an external link, or a nested group.
// NOTE: an endpoint-shaped string ("GET /users") is still a string here; it is
// resolved to a generated endpoint page at compile when it sits under an
// openapi-bearing node (§2.2 pageRefSchema / §1.10 carve-out) — not a schema concern.
export const pageRefSchema: z.ZodType<PageRef> = z.lazy(() =>
    z.union([z.string(), z.object({ href: z.string() }), groupNodeSchema]),
)

export const menuItemNodeSchema: z.ZodType<MenuItemNode> = z.lazy(() =>
    z
        .object({
            item: z.string(),
            icon: z.string().optional(),
            description: z.string().optional(),
            href: z.string().optional(),
            hidden: z.boolean().optional(),
            directory: z.string().optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            dropdowns: z.array(dropdownNodeSchema).optional(),
            anchors: z.array(anchorNodeSchema).optional(),
            products: z.array(productNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            languages: z.array(languageNodeSchema).optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
            global: globalNodeSchema.optional(),
            resolvedHref: z.string().optional(),
            resolvedPages: z.array(z.string()).optional(),
            resolvedGroups: z.array(resolvedTabGroupSchema).optional(),
        })
        .passthrough(),
)

/**
 * Rows compiled before pipeline v5 persisted the docs.json object-form OpenAPI
 * ref ({source, directory}) verbatim in navigation/__resolvedNav.
 * parseDocsConfig rewrites new ingests to the source string, so serving
 * normalizes the legacy shape here instead of 500ing an entire tenant on
 * its stored config until convergence replaces the row.
 */
const openapiRefStringSchema = z.union([
    z.string(),
    z.object({ source: z.string() }).transform((ref) => ref.source),
])

export const tabNodeSchema: z.ZodType<TabNode> = z.lazy(() =>
    z
        .object({
            tab: z.string(),
            icon: z.string().optional(),
            href: z.string().optional(),
            hidden: z.boolean().optional(),
            searchable: z.boolean().optional(),
            align: z.enum(["start", "end"]).optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
            languages: z.array(languageNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            dropdowns: z.array(dropdownNodeSchema).optional(),
            menu: z.array(menuItemNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
            global: globalNodeSchema.optional(),
            resolvedPages: z.array(z.string()).optional(),
            resolvedHref: z.string().optional(),
            resolvedGroups: z.array(resolvedTabGroupSchema).optional(),
        })
        .passthrough(),
)

export const resolvedTabEntrySchema: z.ZodType<ResolvedTabEntry> = z.lazy(() =>
    z.union([
        z.object({ page: z.string() }),
        z.object({ href: z.string(), label: z.string() }),
        z.object({ group: resolvedTabGroupSchema }),
    ]),
)
export const resolvedTabGroupSchema: z.ZodType<ResolvedTabGroup> = z.lazy(() =>
    z.object({
        title: z.string().optional(),
        icon: z.string().optional(),
        expanded: z.boolean().optional(),
        root: z.string().optional(),
        entries: z.array(resolvedTabEntrySchema),
    }),
)

export const dropdownNodeSchema: z.ZodType<DropdownNode> = z.lazy(() =>
    z
        .object({
            dropdown: z.string(),
            icon: z.string().optional(),
            href: z.string().optional(),
            description: z.string().optional(),
            color: lightDark(hexColor).optional(),
            hidden: z.boolean().optional(),
            directory: z.string().optional(),
            languages: z.array(languageNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            anchors: z.array(anchorNodeSchema).optional(),
            products: z.array(productNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
        })
        .passthrough(),
)

export const anchorNodeSchema: z.ZodType<AnchorNode> = z.lazy(() =>
    z
        .object({
            anchor: z.string(),
            href: z.string().optional(),
            icon: z.string().optional(),
            color: lightDark(hexColor).optional(),
            hidden: z.boolean().optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            languages: z.array(languageNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            dropdowns: z.array(dropdownNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
        })
        .passthrough(),
)

export const versionNodeSchema: z.ZodType<VersionNode> = z.lazy(() =>
    z
        .object({
            version: z.string(),
            href: z.string().optional(),
            default: z.boolean().optional(),
            hidden: z.boolean().optional(),
            tag: z.string().optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
            languages: z.array(languageNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
            global: globalNodeSchema.optional(),
        })
        .passthrough(),
)

export const languageNodeSchema: z.ZodType<LanguageNode> = z.lazy(() =>
    z
        .object({
            language: z.string(),
            href: z.string().optional(),
            default: z.boolean().optional(),
            hidden: z.boolean().optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
            global: globalNodeSchema.optional(),
        })
        .passthrough(),
)

export const productNodeSchema: z.ZodType<ProductNode> = z.lazy(() =>
    z
        .object({
            product: z.string(),
            name: z.string().optional(),
            href: z.string().optional(),
            icon: z.string().optional(),
            color: lightDark(hexColor).optional(),
            description: z.string().optional(),
            hidden: z.boolean().optional(),
            directory: z.string().optional(),
            openapi: openapiRefStringSchema.optional(),
            asyncapi: z.string().optional(),
            languages: z.array(languageNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            anchors: z.array(anchorNodeSchema).optional(),
            groups: z.array(groupNodeSchema).optional(),
            pages: z.array(pageRefSchema).optional(),
            menu: z.array(menuItemNodeSchema).optional(),
            global: globalNodeSchema.optional(),
        })
        .passthrough(),
)

// `global` (elements shown on every section) is itself a container of nav nodes
// (02-inventory §(c) Global) — modeled explicitly, not as an untyped record.
export const globalNodeSchema: z.ZodType<GlobalNode> = z.lazy(() =>
    z
        .object({
            languages: z.array(languageNodeSchema).optional(),
            versions: z.array(versionNodeSchema).optional(),
            tabs: z.array(tabNodeSchema).optional(),
            dropdowns: z.array(dropdownNodeSchema).optional(),
            anchors: z.array(anchorNodeSchema).optional(),
            products: z.array(productNodeSchema).optional(),
        })
        .passthrough(),
)

export const navigationSchema = z
    .object({
        pages: z.array(pageRefSchema).optional(),
        groups: z.array(groupNodeSchema).optional(),
        tabs: z.array(tabNodeSchema).optional(),
        anchors: z.array(anchorNodeSchema).optional(),
        dropdowns: z.array(dropdownNodeSchema).optional(),
        versions: z.array(versionNodeSchema).optional(),
        languages: z.array(languageNodeSchema).optional(), // v2: parsed, default-language render (§5.6)
        menu: z.array(menuItemNodeSchema).optional(),
        products: z.array(productNodeSchema).optional(),
        global: globalNodeSchema.optional(),
    })
    .passthrough()

/** Navigation data resolved at ingest and stored under config.__resolvedNav. */
export const resolvedNavigationSchema = z.object({
    language: z.string().nullable(),
    tabs: z.array(tabNodeSchema),
    anchors: z.array(anchorNodeSchema),
    dropdowns: z.array(dropdownNodeSchema),
    versions: z.array(versionNodeSchema),
    products: z.array(productNodeSchema),
    menu: z.array(menuItemNodeSchema),
    global: globalNodeSchema.nullable(),
})
export type ResolvedNavigation = z.infer<typeof resolvedNavigationSchema>

/**
 * Per-locale serving manifest (docs_content_version.locales_manifest). One
 * entry per navigation.languages[] node; empty for single-language sites.
 * The default entry's nav/versionsManifest ALSO populate config.__resolvedNav
 * and versions_manifest so single-locale consumers stay untouched — serving
 * swaps in a non-default entry's values at the resolveDocsContext chokepoint.
 */
/**
 * Canonical locale tag: BCP-47-shaped and URL-segment-safe (no slashes) —
 * the tag doubles as the leading URL segment, so anything this rejects can
 * neither partition nor route. The SAME schema gates config ingestion
 * (enumerateLocales) and manifest parsing, so no persisted manifest can
 * throw at serve time.
 */
export const docsLocaleTagSchema = z
    .string()
    .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)

export const localesManifestSchema = z.array(
    z.object({
        /** navigation.languages[].language tag — doubles as the URL prefix. */
        locale: docsLocaleTagSchema,
        default: z.boolean(),
        hidden: z.boolean().optional(),
        /** Locale root directory in the repo ("" for the default locale). */
        directory: z.string(),
        /** This locale's resolved nav, hrefs in servedUrl (prefixed) space. */
        nav: resolvedNavigationSchema,
        /** This locale's product-version roots (full repo directories). */
        versionsManifest: versionsManifestSchema,
    }),
)
export type LocalesManifest = z.infer<typeof localesManifestSchema>

// ── Integrations (allow-listed subset; each with its own required sub-props) ──
export const integrationsSchema = z
    .object({
        ga4: z.object({ measurementId: z.string().regex(/^G/) }).optional(),
        // gtm is parsed for docs.json compat but disposition Ignored (INV-2, §5.5): a
        // GTM container executes tenant-authored Custom-HTML/JS tags — that is code,
        // not a key. No injection; integration_unsupported diagnostic.
        gtm: z.object({ tagId: z.string().regex(/^G/) }).optional(),
        // apiHost is data-only: at ingest it is constrained to an allow-list of
        // official PostHog ingestion origins (posthog-js is framework-bundled); an
        // arbitrary self-host origin is dropped + diagnosed (INV-2, §5.5).
        posthog: z
            .object({
                apiKey: z.string().regex(/^phc_/),
                apiHost: z.string().optional(),
            })
            .optional(),
        // `server`/self-host origin intentionally NOT modeled: the Plausible script
        // loads only from the framework-pinned official origin; `domain` is a
        // data-only key (INV-2, §5.5). A `server` value is tolerated + ignored.
        plausible: z
            .object({ domain: z.string() })
            .passthrough() // retain `server` so ingest can report and quarantine it
            .optional(),
        fathom: z.object({ siteId: z.string() }).optional(),
        clarity: z.object({ projectId: z.string() }).optional(),
        amplitude: z.object({ apiKey: z.string().min(1) }).optional(),
        // region is a data-only key — the renderer maps it onto a PINNED
        // official Mixpanel ingestion origin (INV-2), never a tenant host.
        mixpanel: z
            .object({
                projectToken: z.string().min(1),
                region: z.enum(["us", "eu", "in"]).optional(),
            })
            .optional(),
        segment: z.object({ key: z.string().min(1) }).optional(),
        hotjar: z
            .object({
                hjid: z.union([z.string().min(1), z.number()]),
                hjsv: z.union([z.string(), z.number()]).optional(),
            })
            .optional(),
        intercom: z.object({ appId: z.string().min(1) }).optional(),
    })
    .passthrough() // unknown vendors tolerated → parsed, diagnosed, not executed

export const redirectSchema = z.object({
    source: z.string(),
    destination: z.string(),
    /** docs.json default: permanent (308). `false` selects a 307. */
    permanent: z.boolean().optional(),
})

/** Redirects after ingest has normalized them to root-relative paths. */
export const normalizedRedirectSchema = redirectSchema
export type NormalizedRedirect = z.infer<typeof normalizedRedirectSchema>

/**
 * docs.json seo.organization — the site's structured-data identity. Mapped
 * onto the stored publisher slot at ingest (resolveDeploymentConfig); `id`
 * parses but is not persisted — the JSON-LD graph mints its own origin-bound
 * @id at serve time.
 */
export const docsSeoOrganizationSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(255).optional(),
    legalName: z.string().min(1).max(255).optional(),
    url: docsSeoIdentityUrlSchema.optional(),
    /** Safe relative site asset or absolute public HTTP(S) URL. */
    logo: z.string().min(1).refine(isSafeSeoLogoUrl).optional(),
    sameAs: z.array(docsSeoIdentityUrlSchema).optional(),
})

export const seoSchema = z.object({
    metatags: z.record(z.string(), z.string()).optional(),
    indexing: z.enum(INDEXING_MODES).optional(),
    organization: docsSeoOrganizationSchema.optional(),
    /** docs.json seo.trailingSlash — canonical URLs end in "/". */
    trailingSlash: z.boolean().optional(),
})

export const DEFAULT_DOCS_TITLE_TEMPLATE = "{page} – {site}"

export const docsSeoTitleTemplateSchema = z
    .string()
    .min(1)
    .max(200)
    .refine(
        (template) => {
            const unknownSyntax = template
                .replaceAll("{page}", "")
                .replaceAll("{site}", "")
            return !unknownSyntax.includes("{") && !unknownSyntax.includes("}")
        },
        { message: "Only {page} and {site} title tokens are supported" },
    )
    .refine((template) => template.split("{page}").length === 2, {
        message: "The title template must contain {page} exactly once",
    })
    .refine((template) => template.split("{site}").length <= 2, {
        message: "The title template may contain {site} at most once",
    })

export const docsSeoPublisherSchema = z.object({
    type: z.enum(["Organization", "Person"]).optional(),
    name: z.string().min(1).max(255).optional(),
    /** Registered legal name (schema.org Organization.legalName). */
    legalName: z.string().min(1).max(255).optional(),
    url: docsSeoIdentityUrlSchema.optional(),
    /** Safe relative site asset or absolute public HTTP(S) URL. */
    logoUrl: z.string().min(1).refine(isSafeSeoLogoUrl).optional(),
    sameAs: z.array(docsSeoIdentityUrlSchema).optional(),
})

export const docsSeoProvenanceSchema = z.object({
    name: z.string().min(1).max(255),
    baseUrl: docsSeoIdentityUrlSchema.refine(
        (value) => {
            try {
                const url = new URL(value)
                return url.search === "" && url.hash === ""
            } catch {
                return false
            }
        },
        { message: "Provenance base URLs cannot contain a query or fragment" },
    ),
    license: z
        .object({
            name: z.string().min(1).max(255),
            url: docsSeoIdentityUrlSchema,
        })
        .optional(),
})

export const docsSeoExtensionSchema = z.object({
    titleTemplate: docsSeoTitleTemplateSchema.optional(),
    language: docsLocaleTagSchema.optional(),
    publisher: docsSeoPublisherSchema.optional(),
    provenance: docsSeoProvenanceSchema.optional(),
})

/** Fully resolved SEO artifact persisted on docs_content_version. */
export const storedSeoSchema = z.object({
    description: z.string().optional(),
    indexing: z.enum(INDEXING_MODES),
    trailingSlash: z.boolean().default(false),
    metatags: z.record(z.string(), z.string()),
    ogDefaults: z.record(z.string(), z.unknown()),
    titleTemplate: docsSeoTitleTemplateSchema.default(
        DEFAULT_DOCS_TITLE_TEMPLATE,
    ),
    language: docsLocaleTagSchema.optional(),
    publisher: docsSeoPublisherSchema.optional(),
    provenance: docsSeoProvenanceSchema.optional(),
    headMeta: z.array(
        z.object({
            name: z.string().optional(),
            property: z.string().optional(),
            content: z.string(),
        }),
    ),
})
export type StoredSeo = z.infer<typeof storedSeoSchema>

/** Allow-listed analytics keys plus quarantined unsupported config. */
export const storedIntegrationsSchema = z.object({
    enabled: z.record(z.string(), z.record(z.string(), z.string())),
    ignored: z.record(z.string(), z.unknown()),
})
export type StoredIntegrations = z.infer<typeof storedIntegrationsSchema>

export const bannerSchema = z
    .object({
        content: z.string().min(1),
        type: z.enum(BANNER_TYPES).optional(),
        dismissible: z.boolean().optional(),
        color: lightDark(hexColor).optional(),
        /**
         * Ingest-compiled inline HAST fragment of `content` (never authored):
         * banner markdown renders from this stored tree; the raw string stays
         * for text surfaces. Absent when the content failed inline-only
         * compilation (a diagnostic names why) — serve falls back to text.
         */
        contentHast: z.unknown().optional(),
    })
    .passthrough()

/**
 * docs.json errors["404"] shape — exported so ingest can validate each
 * authored field on its own (one bad title must not discard a valid
 * redirect/description sibling via the top-level recovery loop).
 */
export const docsNotFoundErrorSchema = z.object({
    redirect: z.boolean().optional(),
    title: z.string().max(255).optional(),
    description: z.string().max(4000).optional(),
    descriptionHast: z.unknown().optional(),
})

// ── Config extension namespace (CONFIG_EXTENSION_KEY, Extended) ──

/**
 * Site controls over the agent surfaces. Every field is optional and the
 * framework's defaults apply when it is absent: all three content signals
 * `yes`, the index preamble on, assistant markdown on, no frontmatter, and
 * generated MCP instructions (`mcpInstructions` is appended to them).
 */
export const docsAgentsSchema = z.object({
    contentSignals: z
        .object({
            search: z.boolean().optional(),
            aiInput: z.boolean().optional(),
            aiTrain: z.boolean().optional(),
        })
        .optional(),
    indexPreamble: z.boolean().optional(),
    assistantMarkdown: z.boolean().optional(),
    markdownFrontmatter: z.boolean().optional(),
    mcpInstructions: z.string().max(4000).optional(),
})
export type DocsAgents = z.infer<typeof docsAgentsSchema>

const headMetaSchema = z
    .object({
        name: z.string().optional(),
        property: z.string().optional(),
        content: z.string(),
    })
    .passthrough() // retain unknown keys so ingest can detect meta-key smuggling

export const configExtensionSchema = z
    .object({
        tokens: z
            .record(
                z.string(),
                z.union([
                    hexColor,
                    z.string(),
                    lightDark(z.union([hexColor, z.string()])),
                ]),
            )
            .optional(),
        css: z
            .union([z.string(), z.array(z.string())])
            .nullable()
            .optional(),
        layout: z
            .object({
                contentWidth: z.string().optional(),
                sidebarWidth: z.string().optional(),
                tocWidth: z.string().optional(),
                headerHeight: z.string().optional(),
                tabMode: z.enum(TAB_MODES).optional(),
                chromeMode: chromeModeSchema.optional(),
            })
            .optional(),
        head: z.object({ meta: z.array(headMetaSchema).optional() }).optional(),
        assets: z
            .object({ allowExternal: z.array(z.string()).optional() })
            .optional(),
        search: z.object({ mode: z.enum(SEARCH_MODES).optional() }).optional(),
        versions: z.object({ default: z.string().optional() }).optional(),
        seo: docsSeoExtensionSchema.optional(),
        agents: docsAgentsSchema.optional(),
    })
    .passthrough()

/**
 * docs.json `variations`: named content alternatives a reader switches
 * site-wide. Consecutive sibling `<View>` MDX blocks form one selector
 * group; a view whose title case-insensitively equals an option's label
 * participates in the site-wide selection keyed by that option's `id`.
 * Options render in authored order; the FIRST option is the default.
 */
export const docsVariationsSchema = z.object({
    options: z
        .array(
            z.object({
                id: z.string().min(1),
                label: z.string().min(1),
            }),
        )
        .min(1)
        // Selection is persisted and resolved BY id — with a duplicate id
        // the second option could never be selected (the first match always
        // wins), so the whole field is invalid rather than silently lame.
        .refine(
            (options) =>
                new Set(options.map((option) => option.id)).size ===
                options.length,
            { message: "option ids must be unique" },
        )
        // View titles match labels case-insensitively — "Python" and
        // "python" would both resolve to the first option and the second
        // could never be selected.
        .refine(
            (options) =>
                new Set(options.map((option) => option.label.toLowerCase()))
                    .size === options.length,
            { message: "option labels must be unique (case-insensitive)" },
        ),
})
export type DocsVariations = z.infer<typeof docsVariationsSchema>

// ── Root: superset of docs.json. Every field optional (INV-1). ──
// .nullable() on detectable fields encodes the §3.3 opt-out.
// .passthrough() tolerates unknown/future docs.json fields (INV-3).
export const docsConfigSupersetSchema = z
    .object({
        $schema: z.string().optional(),
        theme: z.enum(THEME_PRESETS).optional(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        public: z.boolean().optional(),
        colors: colorsSchema.partial().nullable().optional(),
        logo: logoSchema.nullable().optional(),
        favicon: faviconSchema.nullable().optional(),
        appearance: z
            .object({
                default: z.enum(APPEARANCE_MODES).optional(),
                strict: z.boolean().optional(),
            })
            .optional(),
        background: z
            .object({
                color: lightDark(hexColor).optional(),
                decoration: decorationSchema.optional(),
                // docs.json background image (string or light/dark pair);
                // repo assets hash to /_assets URLs at ingest.
                image: z.union([z.string(), lightDark(z.string())]).optional(),
            })
            .passthrough()
            .optional(),
        fonts: fontsSchema.optional(),
        icons: z.object({ library: z.enum(ICON_LIBRARIES) }).optional(),
        // docs.json styling.codeblocks: either a mode string ("system"/"dark")
        // or an object whose `theme` names shiki themes (one name or a
        // light/dark pair) baked into compiled_js at ingest.
        styling: z
            .object({
                // docs.json styling.eyebrows: "section" (default) shows the
                // nearest group; "breadcrumbs" the full trail.
                eyebrows: z.string().optional(),
                // docs.json styling.latex: compile $…$ / $$…$$ through KaTeX
                // at ingest (static HAST, no client JS).
                latex: z.boolean().optional(),
                codeblocks: z
                    .union([
                        z.string(),
                        z
                            .object({
                                theme: z
                                    .union([
                                        z.string(),
                                        z.object({
                                            light: z.string(),
                                            dark: z.string(),
                                        }),
                                    ])
                                    .optional(),
                                // Custom TextMate grammar JSON paths in the
                                // snapshot — registered as shiki languages.
                                // docs.json documents the object spelling
                                // ({ custom: [...] }); the bare array stays
                                // accepted.
                                languages: z
                                    .union([
                                        z.array(z.string()),
                                        z
                                            .object({
                                                custom: z
                                                    .array(z.string())
                                                    .optional(),
                                            })
                                            .passthrough(),
                                    ])
                                    .optional(),
                            })
                            .passthrough(),
                    ])
                    .optional(),
            })
            .passthrough()
            .optional(),
        navbar: z.object({}).passthrough().optional(),
        footer: z.object({}).passthrough().optional(),
        banner: bannerSchema.optional(),
        search: z
            .object({ prompt: z.string().optional() })
            .passthrough()
            .optional(),
        navigation: navigationSchema.optional(),
        seo: seoSchema.optional(),
        redirects: z.array(redirectSchema).optional(),
        api: z
            .object({
                // docs.json accepts one spec path or an array. Entry-level
                // validation stays in openapi.ts so one malformed item can be
                // diagnosed and skipped without dropping valid siblings.
                openapi: z
                    .union([openapiRefStringSchema, z.array(z.unknown())])
                    .optional(),
                // docs.json api.url: "full" shows the full server origin in
                // the endpoint bar. Loose string so an unknown value never
                // drops the tenant's whole api block.
                url: z.string().optional(),
            })
            .passthrough()
            .optional(),
        // Legacy shape retained for already-deployed repositories.
        openapi: z.array(z.unknown()).optional(),
        integrations: integrationsSchema.optional(),
        // docs.json contextual menu ("Copy page ▾"). Option entries are ids
        // or custom {title, description, href} objects — objects stay loose
        // records until custom-option rendering lands.
        contextual: z
            .object({
                options: z
                    .array(
                        z.union([
                            z.string(),
                            z.record(z.string(), z.unknown()),
                        ]),
                    )
                    .optional(),
                display: z.enum(["header", "toc"]).optional(),
            })
            .optional(),
        // docs.json errors["404"]: authored not-found behavior. description
        // is markdown, compiled at ingest into descriptionHast (never
        // authored) — the 404 page renders the stored tree.
        errors: z
            .object({
                "404": docsNotFoundErrorSchema.optional(),
            })
            .optional(),
        thumbnails: z.object({}).passthrough().optional(),
        interaction: z
            .object({ drilldown: z.boolean().optional() })
            .passthrough()
            .optional(),
        metadata: z.object({ timestamp: z.boolean().optional() }).optional(),
        // docs.json feedback widgets: every flag defaults to OFF, so
        // a docs.json without `feedback` renders no thumbs / edit / issue row.
        feedback: z
            .object({
                thumbsRating: z.boolean().optional(),
                suggestEdit: z.boolean().optional(),
                raiseIssue: z.boolean().optional(),
            })
            .optional(),
        // docs.json content variations: site-wide alternatives switched by
        // <View> groups. Options render in authored order and the FIRST
        // option is the default selection. Honored on every theme.
        variations: docsVariationsSchema.optional(),
        variables: z.record(z.string(), z.string()).optional(),
        markdown: z
            .object({
                schema: z.boolean().optional(),
                instructions: z
                    .union([z.string(), z.array(z.string())])
                    .optional(),
            })
            .optional(),
        [CONFIG_EXTENSION_KEY]: configExtensionSchema.optional(),
    })
    .passthrough()

export type DocsConfigSuperset = z.infer<typeof docsConfigSupersetSchema>

/**
 * One extracted code example, precomputed at ingest from the page MDAST
 * (docs_page.code_examples) and served verbatim by the MCP
 * get_code_examples tool and the agent context bundle.
 */
export const docsCodeExampleSchema = z.object({
    language: z.string(),
    /** Target filename / title parsed from the fence meta, if any. */
    title: z.string().optional(),
    /** Raw fence meta string (everything after the language). */
    meta: z.string().optional(),
    code: z.string(),
    /**
     * Code blocks that are ALTERNATIVES of each other (e.g. npm/pnpm/yarn/bun
     * tabs, or a <CodeBlockTabs>/<Tabs> group) share the same group id. An
     * agent should pick ONE, not run all of them.
     */
    alternativesGroup: z.number().optional(),
})
export const docsCodeExamplesSchema = z.array(docsCodeExampleSchema)
export type DocsCodeExample = z.infer<typeof docsCodeExampleSchema>

/**
 * Authored <Update> entries of a changelog page, extracted at ingest from
 * the page MDAST (docs_page.updates; null when the page authors none). They
 * drive the framework's Filters rail and the page's RSS feed.
 */
export const docsPageUpdatesSchema = z.array(
    z.object({
        /** `label`, else `date` — the rendered pill and anchor use the same fallback. */
        label: z.string().nullable(),
        description: z.string().nullable(),
        tags: z.array(z.string()),
        /** Authored `rss={{title, description}}` override (custom
         * per-entry feed metadata). */
        rss: z
            .object({
                title: z.string().nullable(),
                description: z.string().nullable(),
            })
            .nullable(),
    }),
)
export type DocsPageUpdates = z.infer<typeof docsPageUpdatesSchema>

export type Diagnostic = z.infer<typeof diagnosticSchema>
export type Navigation = z.infer<typeof navigationSchema>
export type Integrations = z.infer<typeof integrationsSchema>
export type Redirect = z.infer<typeof redirectSchema>
export type Seo = z.infer<typeof seoSchema>
export type Banner = z.infer<typeof bannerSchema>
export type ConfigExtension = z.infer<typeof configExtensionSchema>
