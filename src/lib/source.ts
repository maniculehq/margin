import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { gunzip } from "node:zlib"
import { notFound, redirect } from "@tanstack/react-router"
import { and, eq, inArray, like, sql } from "drizzle-orm"
import type { StructuredData } from "fumadocs-core/mdx-plugins"
import type * as PageTree from "fumadocs-core/page-tree"
import {
    type InferPageType,
    type LoaderPlugin,
    loader,
    type StaticSource,
} from "fumadocs-core/source"
import { LRUCache } from "lru-cache"
import { createElement, type ReactNode } from "react"
import { z } from "zod"
import { extensions } from "#docs-extensions"
import { db, schema } from "@/db"
import { env } from "@/env"
import type { DocsSite, VersionSelector } from "@/extensions/types"
import {
    CONFIG_EXTENSION_KEY,
    CONFIG_EXTENSION_VERSION_DEFAULT_KEY,
    CONFIG_EXTENSION_VERSION_KEY,
    chromeModeSchema,
    DEFAULT_DOCS_TITLE_TEMPLATE,
    type DocsFrontmatter,
    type DocsPageKind,
    type DocsPageOpenapiProps,
    type DocsPageUpdates,
    docsConfigSupersetSchema,
    docsFrontmatterSchema,
    docsOpenapiConfigEntrySchema,
    docsPageKindSchema,
    docsPageOpenapiPropsSchema,
    docsPageUpdatesSchema,
    docsVariationsSchema,
    type LayoutPreset,
    type LocalesManifest,
    layoutPresetSchema,
    localesManifestSchema,
    matchRedirect,
    type NormalizedRedirect,
    normalizedRedirectSchema,
    type ResolvedTabEntry,
    resolvedNavigationSchema,
    type StoredIntegrations,
    type StoredSeo,
    searchModeSchema,
    storedIntegrationsSchema,
    storedSeoSchema,
    type TabNode,
    type ThemeTokens,
    themePresetSchema,
    themeTokensSchema,
    type VersionsManifest,
    versionsManifestSchema,
} from "@/types/docs"
import { DOCS_DEFAULT_ICON_SVG, resolveDocsIconSvg } from "@/types/docs-icons"
import { isAllowedUrl } from "@/types/docs-shared"
import { agentConfig } from "./agent.config"
import { basePath, withBase } from "./base-path"
import { docsIconNode, iconIsImageRef } from "./docs-icon"
import { chromePrimarySchema, chromeSchema } from "./layout.shared"
import { docsRoute } from "./shared"
import type { SsrSnapshot } from "./ssr-snapshot"
import { rewriteRootOverflowLock } from "./theme-render"

/**
 * DB-backed docs content: ingest writes each build of the docs tree into an
 * immutable docs_content_version row; this module serves the version each
 * request resolves to. Content versions are immutable, so a loader is built
 * once per (site, version) per instance — a content push flips the site's
 * current_version_id, which simply resolves to a new memo key. No
 * deployment, no rebuild, no cache purge.
 */

/**
 * Stored docs.json as the chrome reads it. Parsed only here (buildLayoutConfig);
 * browser modules import the `LayoutConfig` type, never this classic-zod
 * schema.
 */
export const layoutConfigSchema = z.object({
    name: z.string().optional(),
    // Raw docs.json theme: survives ingest in docsConfigSupersetSchema and
    // selects the desktop chrome STRUCTURE here (chromeMode below) — the
    // CSS preset derivation (maple→warm) lives in ingest and cannot carry
    // structure because maple and almond share a preset.
    theme: themePresetSchema.optional(),
    logo: z
        .union([
            z.string(),
            z.object({
                light: z.string(),
                dark: z.string(),
                href: z.string().optional(),
                // Intrinsic size when ingest measured the wordmark — lets
                // the header reserve its box before the image arrives.
                width: z.number().int().positive().optional(),
                height: z.number().int().positive().optional(),
            }),
        ])
        .nullable()
        .optional(),
    appearance: z
        .object({
            default: z.enum(["system", "light", "dark"]).optional(),
            strict: z.boolean().optional(),
        })
        .optional(),
    navbar: z.optional(chromeSchema),
    footer: z
        .object({
            links: z.json().optional(),
            socials: chromeSchema.shape.socials,
        })
        .optional(),
    // docs.json search.prompt: placeholder copy for the search pill and
    // dialog input.
    search: z.object({ prompt: z.string().optional() }).optional(),
    // docs.json interaction.drilldown: opening a sidebar folder navigates to
    // its first page.
    interaction: z.object({ drilldown: z.boolean().optional() }).optional(),
    // docs.json contextual.options drives the "Copy page ▾" split-button
    // menu. Loose strings — unknown entries are filtered at render so
    // a new docs.json option can't fail the whole config parse; custom option
    // objects stay records until custom-option rendering lands.
    contextual: z
        .object({
            // z.json(): the value crosses the loader boundary, so it must
            // type as serializable JSON (a Record<string, unknown> doesn't).
            options: z.array(z.json()).optional(),
            display: z.enum(["header", "toc"]).optional(),
        })
        .optional(),
    // docs.json variations: site-wide content alternatives driving the <View>
    // selector groups (components/view-group.tsx). First option is the
    // default. catch: a malformed stored value must not fail the whole
    // layout-config parse (ingest already sanitizes; this is the defensive
    // repeat).
    variations: docsVariationsSchema.optional().catch(undefined),
    [CONFIG_EXTENSION_KEY]: z
        .object({
            layout: z
                .object({
                    tabMode: z.enum(["top", "auto"]).optional(),
                    chromeMode: chromeModeSchema.optional(),
                })
                .optional(),
            // "ai" (default) renders the Assistant triggers + panel; "static"
            // keeps plain search only; "off" also disables the search dialog.
            search: z.object({ mode: searchModeSchema.optional() }).optional(),
        })
        .optional(),
    __resolvedNav: resolvedNavigationSchema.optional(),
})
export type LayoutConfig = z.infer<typeof layoutConfigSchema> & {
    /** The repo the site links publicly (buildLayoutConfig): feeds the
     * sidebar GitHub widget and the loader's star-count fetch. */
    githubRepo?: { owner: string; repo: string }
}

const structuredDataContentSchema = z
    .object({ heading: z.string().optional(), content: z.string() })
    .transform(
        (entry) =>
            ({
                heading: entry.heading,
                content: entry.content,
            }) satisfies StructuredData["contents"][number],
    )
export const structuredDataSchema = z.object({
    headings: z.array(z.object({ id: z.string(), content: z.string() })),
    contents: z.array(structuredDataContentSchema),
})
const tocSchema = z.array(
    z.object({
        title: z.string(),
        url: z.string(),
        depth: z.number(),
    }),
)
// Twin of src/types/docs.ts docsMetaFileSchema. Keep both schemas
// synchronized because fumadocs' StaticSource requires its serving-local type.
const metaDataSchema = z
    .object({
        title: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        pages: z.array(z.string()).optional(),
        root: z.boolean().optional(),
        defaultOpen: z.boolean().optional(),
        collapsible: z.boolean().optional(),
        pagesIndex: z.string().optional(),
        [CONFIG_EXTENSION_VERSION_KEY]: z.string().optional(),
        [CONFIG_EXTENSION_VERSION_DEFAULT_KEY]: z.boolean().optional(),
    })
    .passthrough()

export interface DocsPageData {
    kind: DocsPageKind
    /**
     * Nav-tree label: frontmatter `sidebarTitle` when authored, else the page
     * title. fumadocs derives every tree/breadcrumb/pagination name from
     * this field — `pageTitle` keeps the full H1/meta title.
     */
    title: string
    /** Full page title for the H1 and head meta. */
    pageTitle: string
    description?: string
    icon?: string
    lastModified: Date
    sourcePath: string
    servedUrl: string
    hidden: boolean
    searchable: boolean
    frontmatter: DocsFrontmatter
    /**
     * raw: the human rendition (PDF). processed: the Markdown derived from
     * the page (the no-JS HTML fallback). agent: what every agent read
     * serves, the page's `.agent.md` rendition when it has one, else
     * processed.
     */
    getText: (type: "raw" | "processed" | "agent") => Promise<string>
}

export interface DocsTocItem {
    title: string
    url: string
    depth: number
}

/** The agent body of a page row: its rendition, else the derived Markdown. */
export const agentBody = sql<string>`coalesce(${schema.docsPage.agentMarkdown}, ${schema.docsPage.processedMarkdown})`

/**
 * Agent markdown (agentBody) for an explicit page set — llms-full assembles
 * the corpus in tree-ordered chunks so it never loads pages past its char
 * budget (the old whole-version cache pinned ~16MB per large version to
 * emit a 600k file). Single-page readers (.md route, MCP read_page) go
 * through getText("agent")'s one-row query instead.
 */
export async function agentMarkdownForPages(
    versionId: string,
    paths: readonly string[],
): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map()
    const rows = await db
        .select({
            path: schema.docsPage.path,
            body: agentBody,
        })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, versionId),
                inArray(schema.docsPage.path, [...paths]),
            ),
        )
    return new Map(rows.map((r) => [r.path, r.body]))
}

function buildPageData(
    versionId: string,
    row: {
        path: string
        kind: string
        title: string
        description: string | null
        icon: string | null
        lastModified: Date
        servedUrl: string
        hidden: boolean | null
        frontmatter: unknown
    },
): DocsPageData {
    const kind = docsPageKindSchema.parse(row.kind)
    const frontmatter = docsFrontmatterSchema.parse(row.frontmatter)
    return {
        kind,
        title: frontmatter.sidebarTitle ?? row.title,
        pageTitle: row.title,
        description: row.description ?? undefined,
        icon: row.icon ?? undefined,
        lastModified: row.lastModified,
        sourcePath: row.path,
        servedUrl: row.servedUrl,
        hidden: row.hidden === true,
        searchable: frontmatter.searchable === true,
        frontmatter,
        async getText(type) {
            const rows = await db
                .select(
                    type === "agent"
                        ? { text: agentBody }
                        : type === "processed"
                          ? { text: schema.docsPage.processedMarkdown }
                          : { text: schema.docsPage.source },
                )
                .from(schema.docsPage)
                .where(
                    and(
                        eq(schema.docsPage.versionId, versionId),
                        eq(schema.docsPage.path, row.path),
                    ),
                )
                .limit(1)
            if (!rows[0]) throw new Error(`no ${type} text for ${row.path}`)
            return rows[0].text
        },
    }
}

// Tree icons resolve site lucide-vocabulary names (kebab, Pascal, legacy
// synonyms) to Hugeicons SVGs from the committed map — fumadocs' own
// lucideIconsPlugin only accepted PascalCase lucide-react exports, so every
// lowercase authored name (`book`, `cog`) silently dropped. Icons serialize
// server-side into the page tree as HTML, so this costs the client nothing.
const docsIconsPlugin: LoaderPlugin = {
    name: "docs:hugeicons",
    transformPageTree: (() => {
        const replaceIcon = <Node extends { icon?: string | ReactNode }>(
            node: Node,
        ): Node => {
            if (typeof node.icon !== "string") return node
            // Image refs (ingest-hashed /_assets URLs — per-agent
            // brand SVGs) render as sized <img>; names resolve through the
            // committed maps with the default glyph keeping tree rows evenly
            // indented.
            node.icon = docsIconNode(
                iconIsImageRef(node.icon)
                    ? node.icon
                    : (resolveDocsIconSvg(node.icon) ?? undefined),
                {
                    className: "docs-tree-icon",
                    fallbackSvg: DOCS_DEFAULT_ICON_SVG,
                },
            )
            return node
        }
        return {
            file: replaceIcon,
            folder: replaceIcon,
            separator: replaceIcon,
        }
    })(),
}

/**
 * Sidebar method badges for generated API pages: a compact
 * GET/POST pill BEFORE the title, muted +
 * struck-through when the operation is deprecated. Keyed by tree-item url;
 * the method rides frontmatter.api from ingest, so no heavy openapiProps
 * load. Serialized server-side like the icon transform.
 */
function apiBadgesPlugin(
    byUrl: Map<string, { method: string; deprecated: boolean }>,
    tagByUrl: Map<string, string>,
): LoaderPlugin {
    return {
        name: "docs:api-badges",
        transformPageTree: {
            file: <Node extends { name?: ReactNode; url?: string }>(
                node: Node,
            ): Node => {
                const badge = node.url ? byUrl.get(node.url) : undefined
                const tag = node.url ? tagByUrl.get(node.url) : undefined
                // Frontmatter `tag`: a small pill after the label.
                if (tag) {
                    node.name = createElement(
                        "span",
                        {
                            className:
                                "flex min-w-0 flex-1 flex-wrap items-center gap-1.5",
                        },
                        createElement(
                            "span",
                            { className: "min-w-0 wrap-anywhere" },
                            node.name,
                        ),
                        createElement(
                            "span",
                            { className: "sidebar-tag" },
                            tag,
                        ),
                    )
                }
                if (!badge) return node
                node.name = createElement(
                    "span",
                    {
                        className: "flex min-w-0 flex-1 items-center gap-2",
                    },
                    createElement(
                        "span",
                        {
                            className: "api-method-badge",
                            "data-api-method": badge.method.toLowerCase(),
                        },
                        badge.method === "DELETE" ? "DEL" : badge.method,
                    ),
                    createElement(
                        "span",
                        {
                            className: badge.deprecated
                                ? "min-w-0 wrap-anywhere line-through opacity-70"
                                : "min-w-0 wrap-anywhere",
                        },
                        node.name,
                    ),
                )
                return node
            },
        },
    }
}

function buildLoader(
    files: VirtualDocsFile[],
    plugins: LoaderPlugin[] = [],
    treeId?: string,
) {
    const source: DocsSource = { files }
    return loader({
        source,
        // docsRoute is "" (root serving) — fumadocs needs the explicit "/".
        baseUrl: docsRoute || "/",
        plugins: [docsIconsPlugin, ...plugins],
        // Without a prefix every tree's root $id is the constant "root", and
        // fumadocs-ui's TreeContextProvider memoizes the sidebar tree by that
        // $id — so when a soft navigation swaps trees (tab, version, locale),
        // the sidebar kept rendering the previous tree until a full reload
        // remounted the provider. A per-tree prefix makes root $ids distinct
        // across trees while staying stable within one.
        ...(treeId !== undefined ? { pageTree: { idPrefix: treeId } } : {}),
    })
}

type DocsMetaData = z.infer<typeof metaDataSchema>
type DocsSource = StaticSource<{
    pageData: DocsPageData
    metaData: DocsMetaData
}>
type VirtualDocsFile = DocsSource["files"][number]

export type SiteSource = ReturnType<typeof buildLoader>
export type DocPage = InferPageType<SiteSource>

interface VersionSource {
    source: SiteSource
    searchSource: SiteSource
    allPages: DocPage[]
    /**
     * Loader scoped to one top-level tab: only the tab's
     * ingest-resolved member pages plus meta rows filtered to surviving
     * entries. null when the tab carries no resolvedPages (href-only tabs,
     * configs stored before membership stamping). Memoized per tab title —
     * versions are immutable, same lifetime as the merged loader.
     */
    /** `key` is the loader's stable tab identity (`tabs:<i>` / `global:<i>`,
     * see activeTabKey in routes/$.tsx) — labels are not unique. */
    tabSource: (tab: TabNode, key: string) => SiteSource | null
}

interface VersionPageRow {
    path: string
    kind: string
    versionLabel: string | null
    localeLabel: string | null
    servedUrl: string
    hidden: boolean | null
    frontmatter: unknown
    title: string
    description: string | null
    icon: string | null
    lastModified: Date
}
/**
 * Every light page row + meta row of one version (all locales and version
 * trees), keyed `${siteId}:${versionId}`. The served-URL indexes answer
 * presence checks, the hidden-row miss path and the case-insensitive retry
 * in memory — the rows are already here for the loaders, so those lookups
 * only reach Postgres when this entry is cold.
 *
 * Every per-version memo in this file is an LRUCache: a hit moves the entry
 * to the back, so a production site read on every request is never pushed
 * out by a burst of preview versions. The async ones build through
 * `fetchMethod`, which coalesces concurrent cold builds and drops a rejected
 * build so the next request retries; `ignoreFetchAbort` lets a build evicted
 * mid-flight still answer the requests awaiting it.
 */
const versionContent = new LRUCache<
    string,
    {
        pages: VersionPageRow[]
        metas: Array<{ path: string; data: unknown }>
        byServedUrl: Map<string, VersionPageRow>
        /** lower(servedUrl) → the canonical spelling. */
        byLowerServedUrl: Map<string, string>
    },
    { siteId: string; versionId: string }
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: { siteId, versionId } }) => {
        const [pages, metas] = await Promise.all([
            db
                .select({
                    path: schema.docsPage.path,
                    kind: schema.docsPage.kind,
                    versionLabel: schema.docsPage.versionLabel,
                    localeLabel: schema.docsPage.localeLabel,
                    servedUrl: schema.docsPage.servedUrl,
                    hidden: schema.docsPage.hidden,
                    frontmatter: schema.docsPage.frontmatter,
                    title: schema.docsPage.title,
                    description: schema.docsPage.description,
                    icon: schema.docsPage.icon,
                    lastModified: schema.docsPage.lastModified,
                })
                .from(schema.docsPage)
                .where(
                    and(
                        eq(schema.docsPage.versionId, versionId),
                        eq(schema.docsPage.siteId, siteId),
                    ),
                ),
            db
                .select({
                    path: schema.docsMeta.path,
                    data: schema.docsMeta.data,
                })
                .from(schema.docsMeta)
                .where(eq(schema.docsMeta.versionId, versionId)),
        ])
        // First row wins, like the `limit 1` lookups these replace.
        const byServedUrl = new Map<string, VersionPageRow>()
        const byLowerServedUrl = new Map<string, string>()
        for (const row of pages) {
            if (!byServedUrl.has(row.servedUrl))
                byServedUrl.set(row.servedUrl, row)
            const lower = row.servedUrl.toLowerCase()
            if (!byLowerServedUrl.has(lower))
                byLowerServedUrl.set(lower, row.servedUrl)
        }
        return { pages, metas, byServedUrl, byLowerServedUrl }
    },
})
const EMPTY_SOURCE_KEY = "__empty__"

/**
 * Loader for one immutable content version: eager LIGHT columns only
 * (title, description, icon, frontmatter, lastModified) for every page +
 * meta rows. Everything heavier loads lazily on its own path: body
 * artifacts + toc + openapiProps per page (pageBodyFor), structuredData in
 * bulk for search (structuredDataFor), source/processed markdown on demand.
 * Queries are scoped by versionId AND siteId — the site-isolation
 * invariant the e2e suite asserts.
 */
async function buildVersionSource(
    siteId: string,
    versionId: string,
    versionLabel: string | null,
    versionsManifest: VersionsManifest,
    seo: StoredSeo,
    /** Active locale tag; null = the default locale's trees. */
    localeLabel: string | null = null,
): Promise<VersionSource> {
    const { pages, metas } = await versionContent.forceFetch(
        `${siteId}:${versionId}`,
        { context: { siteId, versionId } },
    )
    const versionRoots = versionsManifest.filter(
        (entry) => entry.directory.length > 0,
    )
    const selectedPages = pages.filter(
        (row) =>
            (row.localeLabel ?? null) === localeLabel &&
            (row.versionLabel === null || row.versionLabel === versionLabel),
    )
    // Keyed by the ingest source path (docs_page.path) — the namespace
    // __resolvedNav tab membership (resolvedPages) is expressed in.
    const fileByRowPath = new Map<string, VirtualDocsFile>()
    const pageFiles: VirtualDocsFile[] = selectedPages.map((row) => {
        const slugs = row.servedUrl.split("/").filter(Boolean)
        const file = {
            type: "page" as const,
            path: slugs.length > 0 ? `${slugs.join("/")}.mdx` : "index.mdx",
            slugs,
            data: buildPageData(versionId, row),
        }
        fileByRowPath.set(row.path, file)
        return file
    })
    const metaFiles: VirtualDocsFile[] = metas.flatMap((row) => {
        const owningRoot = versionRoots.find(
            (entry) =>
                row.path === `${entry.directory}/meta.json` ||
                row.path.startsWith(`${entry.directory}/`),
        )
        if (owningRoot && owningRoot.label !== versionLabel) return []
        // Locale trees live under the locale-tag prefix (servedUrl space):
        // a version root "es/v1" (label v1) rewrites to es/v1/… so meta
        // rows line up with the virtual page paths.
        const path = owningRoot
            ? `${localeLabel ? `${localeLabel}/` : ""}${owningRoot.label}/${row.path.slice(owningRoot.directory.length + 1)}`
            : row.path
        return [
            {
                type: "meta" as const,
                path,
                data: metaDataSchema.parse(row.data),
            },
        ]
    })

    // Method badges for generated API pages, keyed by served URL — shared by
    // the merged, search, and tab-scoped trees (their nodes carry the same
    // URLs even when virtual paths differ).
    const apiBadges = new Map<string, { method: string; deprecated: boolean }>()
    const tags = new Map<string, string>()
    for (const file of pageFiles) {
        if (file.type !== "page") continue
        if (file.data.frontmatter.tag)
            tags.set(
                `/${file.slugs?.join("/") ?? ""}`,
                file.data.frontmatter.tag,
            )
        const api = file.data.frontmatter.api
        if (typeof api !== "string") continue
        const method = api.split(" ")[0]?.toUpperCase()
        if (!method) continue
        apiBadges.set(`/${file.slugs?.join("/") ?? ""}`, {
            method,
            deprecated: file.data.frontmatter.deprecated === true,
        })
    }
    const badges =
        apiBadges.size > 0 || tags.size > 0
            ? [apiBadgesPlugin(apiBadges, tags)]
            : []
    const visibleFiles = pageFiles.filter(
        (file) => file.type !== "page" || !file.data.hidden,
    )
    // idPrefix stamps every node's $id and ships in the serialized tree, so
    // hash the source memo key instead of embedding raw row UUIDs in the
    // client payload. versionId keeps a mid-session content flip from
    // serving a stale sidebar too.
    const treeId = createHash("sha256")
        .update(
            `${siteId}:${versionId}:${localeLabel ?? ""}:${versionLabel ?? ""}`,
        )
        .digest("base64url")
        .slice(0, 10)
    const source = buildLoader([...visibleFiles, ...metaFiles], badges, treeId)
    const allSource = buildLoader(
        [...pageFiles, ...metaFiles],
        badges,
        `${treeId}:all`,
    )
    const indexableSlugs = new Set(
        allSource
            .getPages()
            .filter((page) => isPageIndexable({ seo }, page))
            .map((page) => page.slugs.join("/")),
    )
    const searchSource = buildLoader(
        [
            ...pageFiles.filter(
                (file) =>
                    file.type === "page" &&
                    file.slugs !== undefined &&
                    indexableSlugs.has(file.slugs.join("/")),
            ),
            ...metaFiles,
        ],
        [],
        `${treeId}:search`,
    )

    const tabSources = new LRUCache<string, SiteSource>({ max: 64 })
    const tabSource = (tab: TabNode, key: string): SiteSource | null => {
        const resolvedGroups = tab.resolvedGroups
        if (!resolvedGroups || resolvedGroups.length === 0) return null
        // Keyed by list position, never by label: two tabs may share a label
        // (root vs global, or within one list) while holding different pages.
        const cached = tabSources.get(key)
        if (cached) return cached
        // Synthesize a virtual tree mirroring the authored structure: pages
        // sit flat under slug-derived names (their `slugs` keep the real
        // URLs), top-level groups become separators (section headers),
        // nested groups become folders with their own meta.
        const files: VirtualDocsFile[] = []
        const usedNames = new Set<string>()
        const claimName = (base: string): string => {
            let name = base
            for (let n = 2; usedNames.has(name); n++) name = `${base}-${n}`
            usedNames.add(name)
            return name
        }
        const emitEntries = (
            entries: ResolvedTabEntry[],
            dir: string,
        ): string[] => {
            const names: string[] = []
            for (const entry of entries) {
                if ("page" in entry) {
                    const file = fileByRowPath.get(entry.page)
                    if (
                        file?.type !== "page" ||
                        file.data.hidden ||
                        file.slugs === undefined
                    )
                        continue
                    const name = claimName(file.slugs.join("-") || "index-page")
                    files.push({ ...file, path: `${dir}${name}.mdx` })
                    names.push(name)
                    continue
                }
                if ("href" in entry) {
                    names.push(`[${entry.label}](${entry.href})`)
                    continue
                }
                const group = entry.group
                const folder = claimName(
                    (group.title ?? "group")
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/(^-|-$)/g, "") || "group",
                )
                // A group may list its landing page in `pages` too — the
                // root render below already covers it; a second regular
                // entry would duplicate the link.
                const children = emitEntries(
                    group.root
                        ? group.entries.filter(
                              (child) =>
                                  !("page" in child) ||
                                  child.page !== group.root,
                          )
                        : group.entries,
                    `${dir}${folder}/`,
                )
                // The group's landing page (docs.json groups[].root): emitted
                // as the folder's index so clicking the folder title
                // navigates there (fumadocs Folder.index).
                const rootFile = group.root
                    ? fileByRowPath.get(group.root)
                    : undefined
                const hasRoot =
                    rootFile?.type === "page" &&
                    !rootFile.data.hidden &&
                    rootFile.slugs !== undefined
                if (hasRoot && rootFile)
                    files.push({
                        ...rootFile,
                        path: `${dir}${folder}/index.mdx`,
                    })
                if (children.length === 0 && !hasRoot) continue
                files.push({
                    type: "meta",
                    path: `${dir}${folder}/meta.json`,
                    data: metaDataSchema.parse({
                        ...(group.title ? { title: group.title } : {}),
                        ...(group.icon ? { icon: group.icon } : {}),
                        ...(group.expanded !== undefined
                            ? { defaultOpen: group.expanded }
                            : {}),
                        pages: children,
                    }),
                })
                names.push(folder)
            }
            return names
        }
        const rootEntries: string[] = []
        for (const group of resolvedGroups) {
            // A TOP-LEVEL group renders as a section separator, so its
            // landing page (groups[].root) cannot be a folder index —
            // surface it as the section's first entry instead (deduped
            // from the regular entries, mirroring the nested-group path).
            const rootFile = group.root
                ? fileByRowPath.get(group.root)
                : undefined
            const sectionEntries =
                group.root && rootFile
                    ? group.entries.filter(
                          (child) =>
                              !("page" in child) || child.page !== group.root,
                      )
                    : group.entries
            const names = emitEntries(sectionEntries, "")
            if (
                rootFile?.type === "page" &&
                !rootFile.data.hidden &&
                rootFile.slugs !== undefined
            ) {
                const name = claimName(rootFile.slugs.join("-") || "index-page")
                files.push({ ...rootFile, path: `${name}.mdx` })
                names.unshift(name)
            }
            if (names.length === 0) continue
            if (group.title) {
                rootEntries.push(
                    group.icon
                        ? `---[${group.icon}]${group.title}---`
                        : `---${group.title}---`,
                )
            }
            rootEntries.push(...names)
        }
        if (rootEntries.length === 0) return null
        files.push({
            type: "meta",
            path: "meta.json",
            data: metaDataSchema.parse({ pages: rootEntries }),
        })
        // ":tab:" keeps site-authored titles (e.g. a tab named "search")
        // out of the ":all"/":search" internal-loader id namespace.
        const scoped = buildLoader(files, badges, `${treeId}:tab:${key}`)
        tabSources.set(key, scoped)
        return scoped
    }

    return { source, searchSource, allPages: allSource.getPages(), tabSource }
}

/** Version loaders per (site, version, locale, version label). */
const sources = new LRUCache<
    string,
    VersionSource,
    {
        siteRowId: string
        versionId: string | null
        versionLabel: string | null
        versionsManifest: VersionsManifest
        seo: StoredSeo
        localeLabel: string | null
    }
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: (_key, _stale, { context }) =>
        context.versionId
            ? buildVersionSource(
                  context.siteRowId,
                  context.versionId,
                  context.versionLabel,
                  context.versionsManifest,
                  context.seo,
                  context.localeLabel,
              )
            : {
                  source: buildLoader([]),
                  searchSource: buildLoader([]),
                  allPages: [],
                  tabSource: () => null,
              },
})

function sourceForVersion(
    siteRowId: string,
    versionId: string | null,
    versionLabel: string | null,
    versionsManifest: VersionsManifest,
    seo: StoredSeo,
    localeLabel: string | null = null,
): Promise<VersionSource> {
    return sources.forceFetch(
        versionId
            ? `${siteRowId}:${versionId}:${localeLabel ?? ""}:${versionLabel ?? ""}`
            : EMPTY_SOURCE_KEY,
        {
            context: {
                siteRowId,
                versionId,
                versionLabel,
                versionsManifest,
                seo,
                localeLabel,
            },
        },
    )
}

const resolvedConfigSchema = docsConfigSupersetSchema.extend({
    __resolvedNav: resolvedNavigationSchema.optional(),
})
export type ResolvedDocsConfig = z.infer<typeof resolvedConfigSchema>

interface ResolvedVersionArtifacts {
    themeTokens: ThemeTokens
    /** The site stylesheet served by routes/[_]theme: the inlined Google
     * Fonts @font-face CSS ahead of the sanitized theme CSS, with the root
     * overflow lock rewritten (theme-render.ts). The token block stays
     * inline in the document (__root.tsx). */
    siteCss: string
    /** Content address of `siteCss` (/_theme/<hash>.css); null when the
     * version has no site CSS. */
    siteCssHash: string | null
    seo: StoredSeo
    redirects: NormalizedRedirect[]
    integrations: StoredIntegrations
    config: ResolvedDocsConfig | null
    layoutPreset: LayoutPreset
    versionsManifest: VersionsManifest
    localesManifest: LocalesManifest
}

const emptyArtifacts: ResolvedVersionArtifacts = {
    themeTokens: {},
    siteCss: "",
    siteCssHash: null,
    seo: {
        indexing: "navigable",
        trailingSlash: false,
        metatags: {},
        ogDefaults: {},
        titleTemplate: DEFAULT_DOCS_TITLE_TEMPLATE,
        headMeta: [],
    },
    redirects: [],
    integrations: { enabled: {}, ignored: {} },
    config: null,
    layoutPreset: "neutral",
    versionsManifest: [],
    localesManifest: [],
}

/**
 * Parsed artifacts per content version. Versions are rebuilt under a new id
 * rather than edited, but ops scripts (refresh-docs-fonts) patch columns in
 * place, so entries still expire. Every request's head reads it (preview
 * hosts too), and its cost is the payload (theme/font CSS, manifests), not
 * the lookup.
 */
const versionArtifacts = new LRUCache<string, ResolvedVersionArtifacts>({
    max: 64,
    ttl: 5 * 60_000,
})

const versionSelection = {
    id: schema.docsContentVersion.id,
    themeTokens: schema.docsContentVersion.themeTokens,
    themeCss: schema.docsContentVersion.themeCss,
    fontCss: schema.docsContentVersion.fontCss,
    seo: schema.docsContentVersion.seo,
    redirects: schema.docsContentVersion.redirects,
    integrations: schema.docsContentVersion.integrations,
    config: schema.docsContentVersion.config,
    layoutPreset: schema.docsContentVersion.layoutPreset,
    versionsManifest: schema.docsContentVersion.versionsManifest,
    localesManifest: schema.docsContentVersion.localesManifest,
    pipelineVersion: schema.docsContentVersion.pipelineVersion,
}

/**
 * Ingest scrubs authored banner.contentHast / errors.404.descriptionHast
 * before validation since pipeline version 13 (see pipeline-version.ts) —
 * that scrub is what makes a stored HAST slot trustworthy. Rows stamped
 * earlier passed those keys through `.passthrough()` parsing verbatim, so
 * their trees may be author-supplied and must never reach the HAST
 * renderer. Previews are never re-converged, so old rows serve forever —
 * this serve-side gate is their only defense.
 */
const CONFIG_HAST_MIN_PIPELINE_VERSION = 13

function parseVersionArtifacts(row: {
    themeTokens: unknown
    themeCss: string | null
    fontCss: string | null
    seo: unknown
    redirects: unknown
    integrations: unknown
    config: unknown
    layoutPreset: string | null
    versionsManifest: unknown
    localesManifest: unknown
    pipelineVersion: number
}): ResolvedVersionArtifacts {
    const parsedConfig =
        row.config === null || row.config === undefined
            ? null
            : resolvedConfigSchema.parse(row.config)
    const config =
        parsedConfig && row.pipelineVersion < CONFIG_HAST_MIN_PIPELINE_VERSION
            ? {
                  ...parsedConfig,
                  ...(parsedConfig.banner
                      ? {
                            banner: {
                                ...parsedConfig.banner,
                                contentHast: undefined,
                            },
                        }
                      : {}),
                  ...(parsedConfig.errors?.["404"]
                      ? {
                            errors: {
                                ...parsedConfig.errors,
                                "404": {
                                    ...parsedConfig.errors["404"],
                                    descriptionHast: undefined,
                                },
                            },
                        }
                      : {}),
              }
            : parsedConfig
    // Fonts first: @font-face rules ahead of the site's own CSS.
    const siteCss = rewriteRootOverflowLock(
        [row.fontCss, row.themeCss].filter(Boolean).join("\n"),
    )
    return {
        themeTokens: themeTokensSchema.parse(row.themeTokens ?? {}),
        siteCss,
        siteCssHash:
            siteCss === ""
                ? null
                : createHash("sha256")
                      .update(siteCss)
                      .digest("hex")
                      .slice(0, 32),
        seo: storedSeoSchema.parse(
            row.seo ?? {
                indexing: "navigable",
                metatags: {},
                ogDefaults: {},
                headMeta: [],
            },
        ),
        redirects: z.array(normalizedRedirectSchema).parse(row.redirects ?? []),
        integrations: storedIntegrationsSchema.parse(
            row.integrations ?? { enabled: {}, ignored: {} },
        ),
        config,
        layoutPreset: layoutPresetSchema.parse(row.layoutPreset ?? "neutral"),
        versionsManifest: versionsManifestSchema.parse(
            row.versionsManifest ?? [],
        ),
        localesManifest: localesManifestSchema.parse(row.localesManifest ?? []),
    }
}

/**
 * The trees a request's own source does not hold, for sitemap and agent-index
 * coverage. Languages nest outermost (spec §5.6: languages > versions), so
 * every visible language contributes its default-version tree (except the
 * request's own) and each of its visible non-default directory versions.
 * Pages are the tree's indexable pages in sidebar order, minus the pages its
 * language's default tree already serves (shared pages are injected into
 * every version tree at their unprefixed URL). `url` is the tree's URL
 * prefix — the value that scopes an MCP tool to it. Empty trees are dropped.
 */
export interface AlternateTree {
    kind: "version" | "locale"
    label: string
    tag: string | undefined
    url: string
    pages: DocPage[]
}

export async function alternateTrees(
    ctx: DocsContext,
): Promise<AlternateTree[]> {
    const defaultLocale = ctx.localesManifest.find((entry) => entry.default)
    const ownTag = ctx.activeLocale ?? defaultLocale?.locale ?? null
    const languages = [
        // The request's own language first; its default tree is ctx itself.
        {
            locale: ctx.activeLocale,
            tag: ownTag,
            versionsManifest: ctx.versionsManifest,
            own: true,
        },
        ...ctx.localesManifest
            .filter((entry) => entry.hidden !== true && entry.locale !== ownTag)
            .map((entry) => ({
                locale: entry.default ? null : entry.locale,
                tag: entry.locale,
                versionsManifest: entry.versionsManifest,
                own: false,
            })),
    ]
    const specs = languages.flatMap((language) => {
        const defaultLabel = resolveActiveVersion([], language.versionsManifest)
        const prefix = language.locale ? `/${language.locale}` : ""
        const base = {
            locale: language.locale,
            defaultLabel,
            versionsManifest: language.versionsManifest,
            own: language.own,
        }
        const localeTree: (Omit<AlternateTree, "pages"> & {
            versionLabel: string | null
            base: typeof base
        })[] =
            language.own || !language.tag
                ? []
                : [
                      {
                          kind: "locale",
                          label: language.tag,
                          tag: undefined,
                          url: prefix || "/",
                          versionLabel: defaultLabel,
                          base,
                      },
                  ]
        return [
            ...localeTree,
            ...language.versionsManifest
                .filter(
                    (entry) =>
                        entry.directory.length > 0 &&
                        entry.href === undefined &&
                        entry.hidden !== true &&
                        entry.label !== defaultLabel,
                )
                .map((entry): (typeof localeTree)[number] => ({
                    kind: "version",
                    label: language.own
                        ? entry.label
                        : `${language.tag}/${entry.label}`,
                    tag: entry.tag,
                    url: `${prefix}/${entry.label}`,
                    versionLabel: entry.label,
                    base,
                })),
        ]
    })
    const trees = await Promise.all(
        specs.map(async ({ versionLabel, base, ...tree }) => {
            // sourceForVersion is memoized per tree, so a language's default
            // tree is built once however many of its versions read it.
            const [built, baseTree] = await Promise.all(
                [versionLabel, base.defaultLabel].map((label) =>
                    sourceForVersion(
                        ctx.site.id,
                        ctx.versionId,
                        label,
                        base.versionsManifest,
                        ctx.seo,
                        base.locale,
                    ),
                ),
            )
            if (!built || !baseTree) return { ...tree, pages: [] }
            // A version tree drops what its language's default tree serves;
            // a language's default tree keeps all of its pages.
            const served = new Set(
                tree.kind === "locale"
                    ? []
                    : (base.own ? ctx.allPages : baseTree.allPages).map(
                          (page) => page.url,
                      ),
            )
            return {
                ...tree,
                pages: treeDerivations(built.source)
                    .ordered({ seo: ctx.seo, allPages: built.allPages })
                    .filter((page) => !served.has(page.url)),
            }
        }),
    )
    return trees.filter((tree) => tree.pages.length > 0)
}

/** Which of `urls` exist as served routes in this version (language-selector
 * alternates, locale/version homes): answered from the version's memoized
 * rows, with one indexed query only while that memo is cold. */
export async function servedUrlsPresent(
    ctx: Pick<DocsHead, "site" | "versionId">,
    urls: readonly string[],
): Promise<Set<string>> {
    if (!ctx.versionId || urls.length === 0) return new Set()
    const content = versionContent.get(`${ctx.site.id}:${ctx.versionId}`)
    if (content)
        return new Set(urls.filter((url) => content.byServedUrl.has(url)))
    const rows = await db
        .select({ servedUrl: schema.docsPage.servedUrl })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, ctx.versionId),
                eq(schema.docsPage.siteId, ctx.site.id),
                inArray(schema.docsPage.servedUrl, [...urls]),
            ),
        )
    return new Set(rows.map((row) => row.servedUrl))
}

/**
 * Leading-slug locale resolution (Phase A): a first segment matching a
 * non-default locale tag selects that locale and shifts the slugs; anything
 * else is the default locale. Locale wins over a same-named version label
 * (diagnosed at ingest as locale_shadowed).
 */
export function resolveActiveLocale(
    slugs: string[],
    localesManifest: LocalesManifest,
): { locale: string | null; localeSlugs: string[] } {
    const match = localesManifest.find(
        (entry) => !entry.default && entry.locale === slugs[0],
    )
    if (match) return { locale: match.locale, localeSlugs: slugs.slice(1) }
    return { locale: null, localeSlugs: slugs }
}

/**
 * Swap the locale-scoped artifacts in at the single chokepoint: every
 * downstream consumer of config.__resolvedNav (band tabs, tab scoping, the
 * version menu) becomes locale-aware for free.
 */
function applyLocaleArtifacts<T extends ResolvedVersionArtifacts>(
    artifacts: T,
    locale: string | null,
): T {
    if (locale === null) return artifacts
    const entry = artifacts.localesManifest.find(
        (candidate) => candidate.locale === locale,
    )
    if (!entry) return artifacts
    return {
        ...artifacts,
        config: artifacts.config
            ? { ...artifacts.config, __resolvedNav: entry.nav }
            : artifacts.config,
        versionsManifest: entry.versionsManifest,
    }
}

export function resolveActiveVersion(
    slugs: string[],
    versionsManifest: VersionsManifest,
): string | null {
    const localVersions = versionsManifest.filter(
        (entry) => entry.directory.length > 0,
    )
    const fromSlug = localVersions.find(
        (entry) => entry.label === slugs[0],
    )?.label
    if (fromSlug !== undefined) return fromSlug
    // Unprefixed URLs serve the default version. A root-directory default
    // (directory "" — a product version spanning the repo root) IS unprefixed
    // tree: active version null, never a partitioned sibling.
    const defaultEntry = versionsManifest.find((entry) => entry.default)
    if (defaultEntry !== undefined)
        return defaultEntry.directory.length > 0 ? defaultEntry.label : null
    return localVersions[0]?.label ?? null
}

/**
 * The slug-independent half of a request's resolution: site, canonical
 * redirect, live status/version gate and the version's parsed artifacts
 * (default locale). Surfaces that never read a page (favicon, assets, spec,
 * proxy, mcp.json, robots, the trailing-slash middleware) stop here.
 */
export interface DocsHead extends ResolvedVersionArtifacts {
    /** Site slug — the public id used in analytics and URLs. */
    siteId: string
    site: DocsSite
    /** Effective branding for every surface; registry labels and authored
     * config remain unchanged. SITE_NAME belongs to this deployment. */
    identity: { name: string; description: string }
    versionSelector: VersionSelector
    /** null → no ready version answers the selector (empty source). */
    versionId: string | null
    preview: boolean
}

/**
 * Everything a request needs to serve site content: the head plus the
 * slug-dependent tail (locale, version trees). Downstream helpers stay
 * synchronous by taking this context instead of re-resolving.
 */
export interface DocsContext extends DocsHead {
    source: SiteSource
    /** Pages eligible for agent/static search, including searchable hidden pages. */
    searchSource: SiteSource
    /** Every page in the default tree, including hidden URL-reachable rows. */
    allPages: DocPage[]
    /** Tab-scoped sidebar tree; null → fall back to `source`. */
    /** `key` is the loader's stable tab identity (`tabs:<i>` / `global:<i>`,
     * see activeTabKey in routes/$.tsx) — labels are not unique. */
    tabSource: (tab: TabNode, key: string) => SiteSource | null
    versionSources: Map<string, SiteSource>
    versionSearchSources: Map<string, SiteSource>
    activeVersion: (slugs: string[]) => string | null
    /** Non-default locale tag from the leading URL segment; null = default. */
    activeLocale: string | null
}

/**
 * One head per request: middleware, the root loader and the page loader of
 * one SSR document share the same Request object, so they share one site
 * resolution and one live version read. Keyed weakly — the entry dies with
 * the request, so the next request re-reads the gate (a suspended site goes
 * dark immediately). A rejection (including the canonical-host redirect) is
 * kept too: every caller of this request re-throws it.
 */
const heads = new WeakMap<Request, Promise<DocsHead>>()

export function resolveSiteVersion(request: Request): Promise<DocsHead> {
    let head = heads.get(request)
    if (!head) {
        head = buildSiteHead(request)
        heads.set(request, head)
    }
    return head
}

/** A preview selector's prefix lands in a LIKE pattern: commit hex only, so
 * an extension can never smuggle a wildcard into it. */
const SHA_PREFIX = /^[0-9a-f]{1,64}$/

/** The site the extension resolves, served at the version its selector
 * names. A host naming no site 404s (previews serve an empty no-store page);
 * production redirects to the canonical host the extension names. */
async function buildSiteHead(request: Request): Promise<DocsHead> {
    const resolution = await extensions.resolveSite(request)
    const {
        site,
        versionSelector,
        preview,
        canonicalHost,
        basePath,
        publicOrigin,
    } = resolution
    if (!site) {
        // Never another site's content and never a 500: an unknown preview
        // host stays isolated and non-indexable, anything else is a 404.
        if (!preview) throw notFound()
        const placeholder = emptySite()
        return {
            siteId: placeholder.slug,
            site: placeholder,
            identity: {
                name: placeholder.name,
                description: placeholder.description,
            },
            versionSelector,
            versionId: null,
            ...emptyArtifacts,
            preview: true,
        }
    }

    if (canonicalHost) {
        const rawHost = (request.headers.get("host") ?? "").toLowerCase()
        // Bracket-aware port strip: "[::1]:3000" → "[::1]", "a.com:443" → "a.com".
        const hostname = rawHost.startsWith("[")
            ? rawHost.slice(0, rawHost.indexOf("]") + 1)
            : (rawHost.split(":")[0] ?? "")
        const localHost =
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname === "127.0.0.1" ||
            hostname === "0.0.0.0" ||
            hostname === "[::1]"
        const canonical = canonicalHost.toLowerCase()
        if (!localHost && rawHost !== canonical && hostname !== canonical) {
            const forwarded = request.headers
                .get("x-forwarded-proto")
                ?.split(",")[0]
                ?.trim()
                .toLowerCase()
            const protocol =
                forwarded === "http" || forwarded === "https"
                    ? forwarded
                    : new URL(request.url).protocol === "http:"
                      ? "http"
                      : "https"
            // The site's public address names its own scheme: an alias
            // reached over plain http still lands on https://acme.com.
            const target =
                publicOrigin && new URL(publicOrigin).host === canonical
                    ? publicOrigin
                    : `${protocol}://${canonicalHost}`
            // The request arrives without the base path (server.ts), and
            // the canonical host serves under it too.
            const url = new URL(request.url)
            throw redirect({
                href: `${target}${withBase(url.pathname, basePath)}${url.search}`,
                reloadDocument: true,
                statusCode: 308,
                headers: {
                    "Cache-Control": agentConfig.cache.header,
                },
            })
        }
    }

    // Only fully-onboarded sites serve: an interrupted create may leave a row
    // parked in `provisioning`, and `suspended` must go dark immediately —
    // extensions cache their site lookups, so the status is re-read live
    // here, joined into the one version read every selector makes (ids
    // only); the heavy artifact columns behind it are memoized across
    // requests.
    const liveSite = and(
        eq(schema.docsSite.id, site.id),
        eq(schema.docsSite.status, "active"),
    )
    const siteVersion = eq(schema.docsContentVersion.siteId, site.id)
    const readyVersion = and(
        siteVersion,
        eq(schema.docsContentVersion.status, "ready"),
    )
    const selected =
        versionSelector === "current"
            ? {
                  join: and(
                      liveSite,
                      eq(
                          schema.docsSite.currentVersionId,
                          schema.docsContentVersion.id,
                      ),
                  ),
                  where: readyVersion,
              }
            : versionSelector.kind === "commit"
              ? {
                    join: liveSite,
                    // A later production build supersedes this version;
                    // a deployment pinned to it (an instant rollback) must
                    // still serve the content it was built with.
                    where: and(
                        siteVersion,
                        inArray(schema.docsContentVersion.status, [
                            "ready",
                            "superseded",
                        ]),
                        eq(
                            schema.docsContentVersion.commitSha,
                            versionSelector.sha,
                        ),
                        // Kinds never cross (§3.4): a production deployment
                        // serves only production builds of its commit, a
                        // preview deployment only the preview build — each
                        // build ingests its own row, so a commit built both
                        // ways resolves to the kind the deployment is.
                        eq(
                            schema.docsContentVersion.kind,
                            preview ? "preview" : "production",
                        ),
                    ),
                }
              : SHA_PREFIX.test(versionSelector.shaPrefix)
                ? {
                      join: liveSite,
                      where: and(
                          readyVersion,
                          eq(schema.docsContentVersion.kind, "preview"),
                          like(
                              schema.docsContentVersion.commitSha,
                              `${versionSelector.shaPrefix}%`,
                          ),
                      ),
                  }
                : null
    // A preview prefix matching MORE than one commit is ambiguous — serve
    // nothing rather than let one PR's URL silently show another PR's docs
    // (fail closed).
    const candidates = selected
        ? await db
              .select({ id: schema.docsContentVersion.id })
              .from(schema.docsContentVersion)
              .innerJoin(schema.docsSite, selected.join)
              .where(selected.where)
              .limit(2)
        : []
    let versionId =
        typeof versionSelector === "object" &&
        versionSelector.kind === "preview" &&
        candidates.length !== 1
            ? null
            : (candidates[0]?.id ?? null)
    const hit = versionId ? versionArtifacts.get(versionId) : undefined
    let parsed = hit ?? emptyArtifacts
    if (selected && !hit && versionId) {
        // On a miss, re-apply the live gate with the artifact read in one
        // statement. The current pointer is re-resolved outright (a rebuild
        // may delete the pointed-at row between two reads, and the swap must
        // stay atomic to readers); a pinned version is re-read by id, so a
        // row deleted or superseded between the reads serves nothing.
        const [row] = await db
            .select(versionSelection)
            .from(schema.docsContentVersion)
            .innerJoin(schema.docsSite, selected.join)
            .where(
                versionSelector === "current"
                    ? selected.where
                    : and(
                          selected.where,
                          eq(schema.docsContentVersion.id, versionId),
                      ),
            )
            .limit(1)
        versionId = row?.id ?? null
        if (row) {
            parsed = parseVersionArtifacts(row)
            versionArtifacts.set(row.id, parsed)
        }
    }
    return {
        siteId: site.slug,
        site,
        // Deployment override, then selected content, then control-plane
        // branding. Ingest never rewrites either authored config or labels.
        identity: {
            name:
                env.SITE_NAME ?? parsed.config?.name ?? site.name ?? site.slug,
            description: parsed.config?.description ?? site.description ?? "",
        },
        versionSelector,
        versionId,
        ...parsed,
        preview,
    }
}

/** The request's head plus its slug tail: the active locale's artifacts and
 * the requested version tree's loaders. `requestedDocSlugs` defaults to the
 * request path (server-fn RPCs must pass the page's slugs explicitly). */
export async function resolveDocsContext(
    request: Request,
    requestedDocSlugs?: string[],
): Promise<DocsContext> {
    const head = await resolveSiteVersion(request)
    const requestSlugs =
        requestedDocSlugs ??
        new URL(request.url).pathname
            .replace(/^\/og\/docs\/?/, "")
            .split("/")
            .filter(Boolean)
    const { locale: activeLocale } = resolveActiveLocale(
        requestSlugs,
        head.localesManifest,
    )
    const localized = applyLocaleArtifacts(head, activeLocale)
    const activeVersion = (slugs: string[]): string | null =>
        resolveActiveVersion(
            resolveActiveLocale(slugs, localized.localesManifest).localeSlugs,
            localized.versionsManifest,
        )
    const requestedLabel = activeVersion(requestSlugs)
    const built = await sourceForVersion(
        head.site.id,
        head.versionId,
        requestedLabel,
        localized.versionsManifest,
        localized.seo,
        activeLocale,
    )
    return {
        ...localized,
        source: built.source,
        searchSource: built.searchSource,
        allPages: built.allPages,
        tabSource: built.tabSource,
        versionSources: new Map([[requestedLabel ?? "", built.source]]),
        versionSearchSources: new Map([
            [requestedLabel ?? "", built.searchSource],
        ]),
        activeVersion,
        activeLocale,
    }
}

/**
 * Resolve from the active navigation tree first, then directly by the immutable
 * served_url row. The second lookup is intentionally miss-only: hidden and
 * unlisted rows stay out of fumadocs' tree while remaining URL-reachable. It
 * reads the version's memoized rows; Postgres only answers while they are cold.
 */
export async function resolvePage(
    ctx: DocsContext,
    source: SiteSource,
    slugs: string[],
): Promise<DocPage | null> {
    const visible = source.getPage(slugs)
    if (visible) return visible
    if (!ctx.versionId) return null

    const servedUrl = `/${slugs.join("/")}`
    const content = versionContent.get(`${ctx.site.id}:${ctx.versionId}`)
    const row = content
        ? content.byServedUrl.get(servedUrl)
        : (
              await db
                  .select({
                      path: schema.docsPage.path,
                      kind: schema.docsPage.kind,
                      servedUrl: schema.docsPage.servedUrl,
                      hidden: schema.docsPage.hidden,
                      frontmatter: schema.docsPage.frontmatter,
                      title: schema.docsPage.title,
                      description: schema.docsPage.description,
                      icon: schema.docsPage.icon,
                      lastModified: schema.docsPage.lastModified,
                  })
                  .from(schema.docsPage)
                  .where(
                      and(
                          eq(schema.docsPage.versionId, ctx.versionId),
                          eq(schema.docsPage.siteId, ctx.site.id),
                          eq(schema.docsPage.servedUrl, servedUrl),
                      ),
                  )
                  .limit(1)
          )[0]
    if (!row) return null
    const fallback = buildLoader([
        {
            type: "page",
            path: slugs.length > 0 ? `${slugs.join("/")}.mdx` : "index.mdx",
            slugs,
            data: buildPageData(ctx.versionId, row),
        },
    ])
    return fallback.getPage(slugs) ?? null
}

/**
 * A configured redirect applied to a format twin (.md/.rss.xml/.pdf): the
 * same rule that moves /old → /new moves /old.md → /new.md, so agents and
 * feed readers following stale links land on the moved content. External
 * destinations are followed unchanged. Null when no rule matches.
 */
export function redirectedTwin(
    ctx: Pick<DocsContext, "redirects">,
    slugs: string[],
    suffix: string,
    /** The request's `?query` (with the `?`), carried like the HTML route. */
    search = "",
): { href: string; statusCode: 307 | 308 } | null {
    const matched = matchRedirect(`/${slugs.join("/")}`, ctx.redirects)
    if (!matched) return null
    const statusCode = matched.permanent ? 308 : 307
    // An external destination has no format twin — it is followed without
    // the suffix, but still inherits the request query like the HTML route.
    const external = /^https?:\/\//i.test(matched.destination)
    const hashAt = matched.destination.indexOf("#")
    const hash = hashAt === -1 ? "" : matched.destination.slice(hashAt)
    const beforeHash =
        hashAt === -1
            ? matched.destination
            : matched.destination.slice(0, hashAt)
    const queryAt = beforeHash.indexOf("?")
    const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
    // A destination's own query wins; otherwise the request's carries over,
    // ahead of any fragment.
    const query = queryAt === -1 ? search : beforeHash.slice(queryAt)
    return {
        href: external
            ? `${path}${query}${hash}`
            : `${path === "/" ? "/index" : path}${suffix}${query}${hash}`,
        statusCode,
    }
}

/**
 * Miss-only case-insensitive lookup: the canonical served_url whose lowercase
 * form equals the requested path, or null. Callers redirect to it (308) rather
 * than serving the page at the alternate spelling. Memoized rows first, like
 * resolvePage's miss path.
 */
export async function resolvePageCaseInsensitive(
    ctx: DocsContext,
    slugs: string[],
): Promise<string | null> {
    if (!ctx.versionId) return null
    const requested = `/${slugs.join("/")}`.toLowerCase()
    const content = versionContent.get(`${ctx.site.id}:${ctx.versionId}`)
    if (content) return content.byLowerServedUrl.get(requested) ?? null
    const rows = await db
        .select({ servedUrl: schema.docsPage.servedUrl })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, ctx.versionId),
                eq(schema.docsPage.siteId, ctx.site.id),
                eq(sql`lower(${schema.docsPage.servedUrl})`, requested),
            ),
        )
        .limit(1)
    return rows[0]?.servedUrl ?? null
}

export async function sourceForActiveVersion(
    ctx: DocsContext,
    slugs: string[],
): Promise<SiteSource> {
    const label = ctx.activeVersion(slugs)
    const cached = ctx.versionSources.get(label ?? "")
    if (cached) return cached
    const built = await sourceForVersion(
        ctx.site.id,
        ctx.versionId,
        label,
        ctx.versionsManifest,
        ctx.seo,
        ctx.activeLocale,
    )
    ctx.versionSources.set(label ?? "", built.source)
    ctx.versionSearchSources.set(label ?? "", built.searchSource)
    return built.source
}

export async function searchSourceForActiveVersion(
    ctx: DocsContext,
    slugs: string[],
): Promise<SiteSource> {
    const label = ctx.activeVersion(slugs)
    const cached = ctx.versionSearchSources.get(label ?? "")
    if (cached) return cached
    await sourceForActiveVersion(ctx, slugs)
    return ctx.versionSearchSources.get(label ?? "") ?? ctx.searchSource
}

/** One ancestor folder of a page: its name and landing URL, if it has one. */
export interface TreeCrumb {
    name: string
    url?: string
}

interface TreeDerivations {
    /** Pages and folder index pages in sidebar order (fumadocs flattenTree).
     * Decorated names (API method badges are React elements) fall back to
     * the page data's plain title; null when there is neither. */
    flat: { name: string | null; url: string; page: DocPage | undefined }[]
    /** Ancestor trail per page URL at its first tree occurrence — exactly
     * fumadocs getBreadcrumbItems(url, tree, { includePage: false }). */
    crumbs: Map<string, TreeCrumb[]>
    /** fumadocs serializePageTree (renderToString per node), built on first
     * use: the agent surfaces never need it. One per base path: its HTML
     * carries image icons' URLs under the site's base path. */
    serialized: () => ReturnType<SiteSource["serializePageTree"]>
    /** Indexable pages in sidebar order, then the indexable pages the tree
     * does not show. `seo` and `allPages` come from the same immutable
     * version source as the tree, so the first caller's values are every
     * caller's values. */
    ordered: (ctx: Pick<DocsContext, "seo" | "allPages">) => DocPage[]
}

/**
 * Pure functions of an immutable tree, computed once per loader instead of
 * on every request: the page loader's sidebar payload and prev/next order,
 * and the agent surfaces' page order and per-page breadcrumbs (a tree walk
 * per page made llms.txt O(pages²)). Keyed by the loader itself, so an
 * entry lives exactly as long as the `sources`/tab memo keeps its loader.
 */
const treeDerivationsMemo = new WeakMap<SiteSource, TreeDerivations>()

export function treeDerivations(source: SiteSource): TreeDerivations {
    const cached = treeDerivationsMemo.get(source)
    if (cached) return cached
    const flat: TreeDerivations["flat"] = []
    const crumbs = new Map<string, TreeCrumb[]>()
    const visit = (item: PageTree.Item, trail: TreeCrumb[]) => {
        const page = source.getNodePage(item)
        flat.push({
            name:
                typeof item.name === "string"
                    ? item.name
                    : (page?.data.title ?? null),
            url: item.url,
            page,
        })
        if (!crumbs.has(item.url)) crumbs.set(item.url, trail)
    }
    // One DFS in flattenTree order: a folder's index before its children,
    // root folders resetting the trail, and a folder's index page not
    // listing that folder as its own ancestor.
    const walk = (nodes: PageTree.Node[], trail: TreeCrumb[]) => {
        for (const node of nodes) {
            if (node.type === "page") visit(node, trail)
            else if (node.type === "folder") {
                const inner = node.root ? [] : trail
                if (node.index) visit(node.index, inner)
                walk(
                    node.children,
                    node.root
                        ? []
                        : [
                              ...trail,
                              {
                                  name:
                                      typeof node.name === "string"
                                          ? node.name
                                          : String(node.name),
                                  url: node.index?.url,
                              },
                          ],
                )
            }
        }
    }
    walk(source.getPageTree().children, [])
    const serialized = new Map<
        string,
        ReturnType<SiteSource["serializePageTree"]>
    >()
    let ordered: DocPage[] | undefined
    const derivations: TreeDerivations = {
        flat,
        crumbs,
        serialized: () => {
            const base = basePath()
            let built = serialized.get(base)
            if (!built) {
                built = source.serializePageTree(source.getPageTree())
                const pending = built
                pending.catch(() => {
                    if (serialized.get(base) === pending)
                        serialized.delete(base)
                })
                serialized.set(base, pending)
            }
            return built
        },
        ordered: (ctx) => {
            if (!ordered) {
                const seen = new Set<string>()
                ordered = []
                for (const page of [
                    ...flat.flatMap((entry) =>
                        entry.page ? [entry.page] : [],
                    ),
                    ...ctx.allPages,
                ]) {
                    if (!isPageIndexable(ctx, page) || seen.has(page.url))
                        continue
                    ordered.push(page)
                    seen.add(page.url)
                }
            }
            return ordered
        },
    }
    treeDerivationsMemo.set(source, derivations)
    return derivations
}

export function isPageIndexable(
    ctx: Pick<DocsContext, "seo">,
    page: DocPage,
): boolean {
    if (page.data.frontmatter.synthesized === true) return false
    return (
        ctx.seo.indexing === "all" || !page.data.hidden || page.data.searchable
    )
}

/** Placeholder for preview hosts naming no site — never serves content. */
function emptySite(): DocsSite {
    return {
        id: "",
        slug: "unknown",
        name: agentConfig.appName,
        description: "",
        repo: null,
        analyticsEnabled: true,
        webmcpEnabled: false,
    }
}

/**
 * kind="hast" carries the tree as a JSON STRING: hast's recursive interface
 * types fail TanStack's loader-serializability validation, and a string is
 * also cheaper to dehydrate than a deep object walk. Selected as `::text`
 * straight from the jsonb column (no parse/re-stringify server-side);
 * components/hast-body.tsx parses + shape-checks it at render.
 */
export type DocsPageBody =
    | {
          kind: "hast"
          hastJson: string
          /** Desktop right-rail tree (Panel / pinned examples); null = TOC. */
          railHastJson: string | null
          /** Frontmatter operation reference — console renders below the prose. */
          openapiProps: DocsPageOpenapiProps | null
      }
    | {
          kind: "js"
          compiledJs: string
          /** Server snapshot of the article rendered inside the V8 isolate
           * (lib/sandbox-render.ts): an SsrSnapshot on document renders
           * (dehydrated as null, lib/ssr-snapshot.ts), a string on
           * client-navigation RPCs. Null from the row read and when the
           * sandbox declined (timeout/memory/throw) — the route then keeps
           * the client-only path. */
          ssrHtml: SsrSnapshot | string | null
          openapiProps: DocsPageOpenapiProps | null
      }
    | { kind: "openapi"; openapiProps: DocsPageOpenapiProps }

export interface DocsPageArtifacts {
    toc: DocsTocItem[]
    body: DocsPageBody
    /** Authored <Update> entries (changelog pages), extracted at ingest:
     * drives the Filters rail. Null when the page authors no <Update>. */
    updates: DocsPageUpdates | null
}

/**
 * Everything the HTML docs route needs beyond the tree entry, in ONE row
 * read — these columns are deliberately NOT in the eager version source.
 * kind="hast" is pure data rendered ON the server (components/hast-body.tsx);
 * kind="js" is the compiled-MDX fallback for expression/snippet pages,
 * executed in the visitor's browser and, for the server snapshot, only inside
 * the host-less V8 isolate of lib/sandbox-render.ts — never in this
 * DB-credentialed process; kind="openapi" carries the serialized
 * fumadocs-openapi page props.
 */
export async function pageBodyFor(
    ctx: DocsContext,
    path: string,
): Promise<DocsPageArtifacts | null> {
    if (!ctx.versionId) return null
    const rows = await db
        .select({
            compiledJs: schema.docsPage.compiledJs,
            hastJson: sql<string | null>`${schema.docsPage.hast}::text`,
            railHastJson: sql<string | null>`${schema.docsPage.railHast}::text`,
            openapiProps: schema.docsPage.openapiProps,
            toc: schema.docsPage.toc,
            updates: schema.docsPage.updates,
        })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, ctx.versionId),
                eq(schema.docsPage.siteId, ctx.site.id),
                eq(schema.docsPage.path, path),
            ),
        )
        .limit(1)
    const row = rows[0]
    if (!row) return null
    const toc = tocSchema.parse(row.toc)
    const updates = docsPageUpdatesSchema.nullable().parse(row.updates)
    // Since pipeline v7 openapiProps can ride ALONGSIDE an authored body
    // (frontmatter operation references) — no longer mutually exclusive.
    const openapiProps =
        row.openapiProps !== null && row.openapiProps !== undefined
            ? docsPageOpenapiPropsSchema.parse(row.openapiProps)
            : null
    if (row.hastJson !== null)
        return {
            toc,
            body: {
                kind: "hast",
                // jsonb::text pretty-prints (": " / ", ") — ~5% of a page's
                // dehydrated payload for nothing; re-serialise compact.
                hastJson: JSON.stringify(JSON.parse(row.hastJson)),
                railHastJson:
                    row.railHastJson === null
                        ? null
                        : JSON.stringify(JSON.parse(row.railHastJson)),
                openapiProps,
            },
            updates,
        }
    if (row.compiledJs !== null)
        return {
            toc,
            body: {
                kind: "js",
                compiledJs: row.compiledJs,
                ssrHtml: null,
                openapiProps,
            },
            updates,
        }
    if (openapiProps) {
        return { toc, body: { kind: "openapi", openapiProps }, updates }
    }
    return null
}

/**
 * structuredData for a whole version, bulk-loaded by the search index build
 * — the one consumer of the whole corpus, which must not issue a query per
 * page. Only in-flight loads are shared: the search server a build produces
 * is what keeps a version warm, so this module holds no corpus once the load
 * settles.
 */
const structuredDataInFlight = new Map<
    string,
    Promise<Map<string, StructuredData>>
>()

const searchCorpusEnvelopeSchema = z.object({
    formatVersion: z.literal(1),
    entries: z.array(
        z.object({ path: z.string(), structuredData: structuredDataSchema }),
    ),
})

/** Ingest writes each version's gzipped search corpus inline
 * (`search_corpus`) or, on installs with a blob store, to an immutable blob
 * (`search_corpus_url`) — replacing a 30 MB JSONB read either way. A ready
 * version with neither is an error; there is no bulk-query fallback. */
export function structuredDataFor(
    versionId: string,
): Promise<Map<string, StructuredData>> {
    const inFlight = structuredDataInFlight.get(versionId)
    if (inFlight) return inFlight
    const loading = (async () => {
        const rows = await db
            .select({
                searchCorpus: schema.docsContentVersion.searchCorpus,
                searchCorpusUrl: schema.docsContentVersion.searchCorpusUrl,
            })
            .from(schema.docsContentVersion)
            .where(eq(schema.docsContentVersion.id, versionId))
            .limit(1)
        const inline = rows[0]?.searchCorpus
        const url = rows[0]?.searchCorpusUrl
        let gzipped: Buffer
        if (inline) gzipped = Buffer.from(inline)
        else if (url) {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok)
                throw new Error(
                    `search corpus fetch failed for version ${versionId}: ${response.status}`,
                )
            gzipped = Buffer.from(await response.arrayBuffer())
        } else throw new Error(`no search corpus for version ${versionId}`)
        // Async gunzip — a multi-MB inflate must not block the serving
        // event loop. The raw buffer/string stay scoped here so they
        // are collectable the moment the Map exists.
        const json = (
            await new Promise<Buffer>((resolve, reject) => {
                gunzip(gzipped, (error, result) =>
                    error ? reject(error) : resolve(result),
                )
            })
        ).toString("utf8")
        const envelope = searchCorpusEnvelopeSchema.parse(JSON.parse(json))
        return new Map(
            envelope.entries.map((entry) => [entry.path, entry.structuredData]),
        )
    })().finally(() => structuredDataInFlight.delete(versionId))
    structuredDataInFlight.set(versionId, loading)
    return loading
}

/**
 * Source-path asset lookup for the $.tsx 404 fallback. Assets referenced
 * inside snippet JS objects are not rewritten by ingest's Markdown/JSX
 * literal rewriter, so the browser can request their original repo path.
 * Rows keep the normalized path (no leading slash), unique per (version, path).
 */
export async function assetHashByPath(
    ctx: DocsContext,
    path: string,
): Promise<string | null> {
    if (!ctx.versionId) return null
    const rows = await db
        .select({ contentHash: schema.docsAsset.contentHash })
        .from(schema.docsAsset)
        .where(
            and(
                eq(schema.docsAsset.versionId, ctx.versionId),
                eq(schema.docsAsset.siteId, ctx.site.id),
                eq(schema.docsAsset.path, path),
            ),
        )
        .limit(1)
    return rows[0]?.contentHash ?? null
}

/**
 * fumadocs-openapi's Document type isn't re-exported from a public subpath —
 * derive it from the exported OpenAPIOptions input record. Types only; the
 * fumadocs-openapi runtime is never loaded on this server.
 */
type OpenapiBundledDocument = Exclude<
    Exclude<
        NonNullable<import("fumadocs-openapi/server").OpenAPIOptions["input"]>,
        string[]
    >[string],
    string | (() => unknown)
>
// Ingest already validated the document; root-shape check + typed accessor
// (same pattern as mdastRootSchema above).
const openapiBundledDocumentSchema = z.custom<OpenapiBundledDocument>(
    (value) =>
        typeof value === "object" &&
        value !== null &&
        "openapi" in value &&
        typeof value.openapi === "string",
)

const serversSchema = z.array(z.string())

/**
 * A version's OpenAPI documents without their bodies — the proxy allowlist
 * (servers), the spec route's default pick (the configured api.openapi
 * document) and the agent indexes' spec list. Memoized like the loader
 * itself: a version's documents are immutable.
 */
const openapiIndexCache = new LRUCache<
    string,
    { docId: string; sourcePath: string; servers: string[] }[],
    { siteId: string; versionId: string }
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: { siteId, versionId } }) => {
        const rows = await db
            .select({
                docId: schema.docsOpenapiDocument.docId,
                sourcePath: schema.docsOpenapiDocument.sourcePath,
                servers: schema.docsOpenapiDocument.servers,
            })
            .from(schema.docsOpenapiDocument)
            .where(
                and(
                    eq(schema.docsOpenapiDocument.versionId, versionId),
                    eq(schema.docsOpenapiDocument.siteId, siteId),
                ),
            )
            .orderBy(schema.docsOpenapiDocument.docId)
        return rows.map((row) => ({
            docId: row.docId,
            sourcePath: row.sourcePath,
            servers: serversSchema.parse(row.servers),
        }))
    },
})

export function openapiDocumentIndex(
    ctx: Pick<DocsHead, "site" | "versionId">,
): Promise<{ docId: string; sourcePath: string; servers: string[] }[]> {
    const versionId = ctx.versionId
    if (!versionId) return Promise.resolve([])
    return openapiIndexCache.forceFetch(`${ctx.site.id}:${versionId}`, {
        context: { siteId: ctx.site.id, versionId },
    })
}

/**
 * The version's OpenAPI documents with the configured primary first — the
 * first string `api.openapi` entry of docs.json, matched on the document's
 * repository path — then the rest by docId. `/api/spec` serves the first
 * one by default; the agent indexes list them in this order.
 */
export function orderOpenapiDocuments<Doc extends { sourcePath: string }>(
    index: Doc[],
    config: Pick<DocsHead, "config">["config"],
): Doc[] {
    // Ingest registers the legacy top-level `openapi` entries first, then
    // `api.openapi`; an entry is a spec path or a {id, spec} object, and the
    // first one that parses is the primary.
    const configured = config?.api?.openapi
    const primary = [
        ...(config?.openapi ?? []),
        ...(Array.isArray(configured) ? configured : [configured]),
    ]
        .flatMap((entry) => {
            if (typeof entry === "string") return [entry]
            const parsed = docsOpenapiConfigEntrySchema.safeParse(entry)
            return parsed.success ? [parsed.data.spec] : []
        })[0]
        ?.replace(/^\.?\//, "")
    return [
        ...index.filter((doc) => doc.sourcePath === primary),
        ...index.filter((doc) => doc.sourcePath !== primary),
    ]
}

/**
 * ONE bundled spec by docId (docs_openapi_document_version_docid_uidx) —
 * what kind="openapi" pages reference via openapiProps.document. Server-side
 * only: the loader reads it for the endpoint bar, and the browser fetches the
 * same body from /api/spec, never through the loader payload. Memoized per
 * (version, doc). A miss is not memoized: /api/spec takes arbitrary doc ids
 * from the query string, and caching those nulls would let junk ids evict
 * real specs from this shared bounded map.
 */
const openapiDocCache = new LRUCache<
    string,
    OpenapiBundledDocument,
    { siteId: string; versionId: string; docId: string }
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: async (
        _key,
        _stale,
        { context: { siteId, versionId, docId } },
    ) => {
        const [row] = await db
            .select({ document: schema.docsOpenapiDocument.document })
            .from(schema.docsOpenapiDocument)
            .where(
                and(
                    eq(schema.docsOpenapiDocument.versionId, versionId),
                    eq(schema.docsOpenapiDocument.siteId, siteId),
                    eq(schema.docsOpenapiDocument.docId, docId),
                ),
            )
            .limit(1)
        // undefined is a miss LRUCache never stores.
        return row
            ? openapiBundledDocumentSchema.parse(row.document)
            : undefined
    },
})

export async function openapiDocument(
    ctx: Pick<DocsHead, "site" | "versionId">,
    docId: string,
): Promise<OpenapiBundledDocument | null> {
    const versionId = ctx.versionId
    if (!versionId) return null
    return (
        (await openapiDocCache.fetch(`${ctx.site.id}:${versionId}:${docId}`, {
            context: { siteId: ctx.site.id, versionId, docId },
        })) ?? null
    )
}

/**
 * Resolve every `icon` name in a JSON tree to the committed map's SVG, leaving
 * image refs alone and dropping inline markup. Names the map lacks stay names,
 * which the client renders as "no icon" — the same outcome the client-side
 * lookup produced before the map left the browser bundle.
 */
function resolveConfigIcons(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(resolveConfigIcons)
    if (typeof node !== "object" || node === null) return node
    return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
            key,
            key === "icon" && typeof value === "string"
                ? iconIsImageRef(value)
                    ? value
                    : // Inline markup is never an authorable icon; a stored
                      // "<"-leading config value is author-supplied (ingest
                      // passes config icons through untouched) and must not
                      // reach the browser's trusted-SVG sink. Unknown names
                      // stay names and render as "no icon".
                      value.trimStart().startsWith("<")
                      ? undefined
                      : (resolveDocsIconSvg(value) ?? value)
                : resolveConfigIcons(value),
        ]),
    )
}

/** Served layout config per (site, version, locale) — see
 * serveLayoutConfig. A config-less version memoizes `{ config: null }`:
 * LRUCache never stores a bare null. */
const layoutConfigs = new LRUCache<
    string,
    { config: LayoutConfig | null },
    DocsContext
>({
    max: 64,
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context }) => ({
        config: await buildLayoutConfig(context),
    }),
})

/**
 * THE layout config the browser receives (root loader, page loader, 404):
 * chrome icon names resolved to SVG server-side — the 2 MB icon map never
 * ships — and `__resolvedNav` tab page-membership lists (every served path,
 * the heavy part of the stamped nav) stripped: the loader computes the active
 * tab before returning and only `resolvedHref` matters to chrome. A pure
 * function of the immutable version config (+ its logo asset sizes), so it
 * is built once per (site, version, locale) instead of on every loader
 * call — two full-nav parses and an icon walk per call otherwise.
 */
export async function serveLayoutConfig(
    ctx: DocsContext,
): Promise<LayoutConfig | null> {
    if (!ctx.versionId) return buildLayoutConfig(ctx)
    return (
        await layoutConfigs.forceFetch(
            `${ctx.site.id}:${ctx.versionId}:${ctx.activeLocale ?? ""}`,
            { context: ctx },
        )
    ).config
}

async function buildLayoutConfig(
    ctx: DocsContext,
): Promise<LayoutConfig | null> {
    const parsed = layoutConfigSchema.safeParse(ctx.config)
    if (!parsed.success) return null
    const resolved = layoutConfigSchema.safeParse(
        resolveConfigIcons(parsed.data),
    )
    if (!resolved.success) return null
    const nav = resolved.data.__resolvedNav
    // Header wordmark box: ingest measures every image asset's intrinsic
    // size (docs_asset.width/height) but config.logo carries only the
    // /_assets URLs, so the header <img> had no dimensions to reserve its
    // box with. Resolve them here — one query for both modes, memoized with
    // the rest of the layout config. A string logo becomes
    // the light/dark pair so it carries the size too.
    const logo = resolved.data.logo
    const sources =
        typeof logo === "string"
            ? { light: logo, dark: logo }
            : logo
              ? { light: logo.light, dark: logo.dark }
              : null
    const hashOf = (src: string) =>
        src.startsWith("/_assets/")
            ? (src.slice("/_assets/".length).split(/[?#]/)[0] ?? "")
            : ""
    const hashes = sources
        ? [...new Set([hashOf(sources.light), hashOf(sources.dark)])].filter(
              (hash) => hash.length > 0,
          )
        : []
    let sizedLogo = logo
    if (sources && hashes.length > 0 && ctx.versionId) {
        const rows = await db
            .select({
                contentHash: schema.docsAsset.contentHash,
                width: schema.docsAsset.width,
                height: schema.docsAsset.height,
            })
            .from(schema.docsAsset)
            .where(
                and(
                    eq(schema.docsAsset.versionId, ctx.versionId),
                    eq(schema.docsAsset.siteId, ctx.site.id),
                    inArray(schema.docsAsset.contentHash, hashes),
                ),
            )
        const measured = new Map<string, { width: number; height: number }>()
        for (const row of rows) {
            if (row.width !== null && row.height !== null)
                measured.set(row.contentHash, {
                    width: row.width,
                    height: row.height,
                })
        }
        // Light and dark wordmarks almost always share a box; the light
        // asset's size wins when they differ.
        const size =
            measured.get(hashOf(sources.light)) ??
            measured.get(hashOf(sources.dark))
        if (size)
            sizedLogo = {
                ...(typeof logo === "object" && logo !== null ? logo : {}),
                light: sources.light,
                dark: sources.dark,
                ...size,
            }
    }
    // The sidebar GitHub widget (stars/forks) only renders for a repo the
    // site links publicly — socials (navbar, then footer), then a
    // navbar.primary of type github. The repoOwner/repoName source mirror is
    // often private, and fetching it would fail. Derived here once per
    // version so the page loader's star lookup needs no chrome derivation.
    let githubUrl: string | undefined
    for (const chrome of [
        chromeSchema.safeParse(resolved.data.navbar),
        chromeSchema.safeParse(resolved.data.footer),
    ]) {
        if (!chrome.success || !chrome.data.socials) continue
        const socials = chrome.data.socials
        githubUrl = Array.isArray(socials)
            ? socials.find(
                  (social) =>
                      social.type?.toLowerCase() === "github" ||
                      social.label?.toLowerCase() === "github",
              )?.href
            : socials.github
        if (githubUrl && isAllowedUrl(githubUrl)) break
        githubUrl = undefined
    }
    if (resolved.data.navbar?.primary !== undefined) {
        const primary = chromePrimarySchema.safeParse(
            resolved.data.navbar.primary,
        )
        if (!primary.success)
            console.warn("[field_invalid] Dropped invalid navbar.primary entry")
        // A github-type navbar.primary renders a repo shortcut, not a CTA
        // (navbarChromeLinks excludes it) — the last GitHub link fallback.
        else if (
            !githubUrl &&
            primary.data.type?.toLowerCase() === "github" &&
            isAllowedUrl(primary.data.href)
        )
            githubUrl = primary.data.href
    }
    let githubRepo: { owner: string; repo: string } | undefined
    // isAllowedUrl also admits relative hrefs, which one-argument new URL()
    // throws on.
    if (githubUrl && /^https?:\/\//i.test(githubUrl)) {
        const { hostname, pathname } = new URL(githubUrl)
        const [owner, repo, ...rest] = pathname.split("/").filter(Boolean)
        if (hostname === "github.com" && owner && repo && rest.length === 0)
            githubRepo = { owner, repo }
    }
    return {
        ...resolved.data,
        logo: sizedLogo,
        githubRepo,
        __resolvedNav: nav
            ? {
                  ...nav,
                  tabs: nav.tabs?.map((tab) => ({
                      tab: tab.tab,
                      icon: tab.icon,
                      href: tab.href,
                      align: tab.align,
                      hidden: tab.hidden,
                      resolvedHref: tab.resolvedHref,
                      // Mega-menu tabs: the header dropdown needs each
                      // item's label, blurb and landing link — nothing
                      // else from the authored subtree.
                      ...(tab.menu
                          ? {
                                menu: tab.menu.map((item) => ({
                                    item: item.item,
                                    icon: item.icon,
                                    description: item.description,
                                    href: item.href,
                                    hidden: item.hidden,
                                    resolvedHref: item.resolvedHref,
                                })),
                            }
                          : {}),
                  })),
              }
            : undefined,
    }
}
