import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, posix } from "node:path"
import { createCompiler } from "@fumadocs/mdx-remote"
import {
    type RemarkHeadingOptions,
    rehypeCodeDefaultOptions,
    remarkMdxMermaid,
    remarkStructure,
    type StructuredData,
} from "fumadocs-core/mdx-plugins"
import {
    type LLMsOptions,
    remarkLLMs,
} from "fumadocs-core/mdx-plugins/remark-llms"
import { replaceSource } from "fumadocs-core/mdx-plugins/stringifier"
import type { TOCItemType } from "fumadocs-core/toc"
import type { Element as HastElement, Root as HastRoot } from "hast"
import ignore from "ignore"
import type { Nodes, Parents, Root, RootContent } from "mdast"
import { type MdxJsxTextElement, mdxJsxToMarkdown } from "mdast-util-mdx-jsx"
import { phrasing } from "mdast-util-phrasing"
import { type Handle, toMarkdown } from "mdast-util-to-markdown"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import remarkSmartypants from "remark-smartypants"
// Type-only: loads the unified `Data.toMarkdownExtensions` declaration.
import type {} from "remark-stringify"
import type { LanguageRegistration } from "shiki"
import type { Plugin } from "unified"
import { SKIP, visit } from "unist-util-visit"
import { visitParents } from "unist-util-visit-parents"
import { z } from "zod"
import {
    type AnchorNode,
    CONFIG_EXTENSION_KEY,
    type Diagnostic,
    type DocsCodeExample,
    type DocsConfigSuperset,
    type DocsPageKind,
    type DocsPageOpenapiProps,
    type DocsPageUpdates,
    type DropdownNode,
    docsFrontmatterSchema,
    docsLocaleTagSchema,
    docsMetaFileSchema,
    formatDocsPath,
    type GlobalNode,
    type GroupNode,
    isAllowedUrl,
    type LanguageNode,
    type LayoutPreset,
    type LocalesManifest,
    type MenuItemNode,
    type NavSource,
    type PageRef,
    type ProductNode,
    type ResolvedNavigation,
    type TabNode,
    type ThemeTokens,
    type VersionNode,
} from "../types/docs"
import {
    evaluateStaticMdxExpression,
    type StaticMdxValue,
} from "../types/docs-hast"
import { resolveDocsIconSvg } from "../types/docs-icons"
import { stripMarkdocTags } from "../types/docs-shared"
import {
    isAssetShapedReference,
    type PreparedAsset,
    prepareAssets,
    resolveAssetReference,
} from "./assets"
import { extractCodeExamplesFromMdast } from "./code-examples"
import {
    type NormalizedRedirect,
    parseDocsConfig,
    resolveDeploymentConfig,
    type StoredIntegrations,
    type StoredSeo,
} from "./config"
import { type DocsFontInputs, MAX_FONT_IMPORTS } from "./fonts"
import { type HastFallbackReason, prepareHastArtifact } from "./hast-artifact"
import { headingSlug } from "./heading-slug"
import {
    remarkResolveIconAttributes,
    transformerAuthoredIcon,
    transformerExpandableCode,
    transformerLineNumbers,
    transformerMetaHighlight,
    transformerTerminalPrompt,
    transformerWrapCode,
} from "./icons"
import { deriveAccent, deriveFavicon } from "./images"
import {
    compileNavigation,
    enumerateLocales,
    resolveNavigationModel,
} from "./nav"
import {
    type CompiledOpenapiDocument,
    compileOpenapiDocs,
    parseOpenapiFrontmatterRef,
    resolveFrontmatterOpenapiRef,
} from "./openapi"
import {
    createAgentBlockStash,
    remarkAgentBlocks,
    remarkDetachAgentBlocks,
    remarkReattachAgentBlocks,
} from "./remark-agent-blocks"
import { remarkCodeGroupTabs } from "./remark-code-group-tabs"
import { remarkViewGroups } from "./remark-view-groups"
import { generateSdkDocs } from "./sdk"
import {
    type CompiledDocsSkill,
    discoverDocsSkills,
    isSkillPath,
} from "./skills"
import type { DocsSnapshotFile } from "./snapshot"
import {
    type CompiledJsSnippet,
    compileJsSnippet,
    failedModuleFallback,
    inlineJsSnippets,
    type JsSnippetBinding,
    mdxSnippetExportsKey,
    remarkExtractSnippetExports,
    remarkSnippetImports,
    substituteStaticBindings,
} from "./snippet-imports"
import { resolveLayoutPreset, resolveThemeTokens, sanitizeCss } from "./theme"
import { extractUpdatesFromMdast } from "./updates"
import {
    type DocsViolation,
    remarkDocsAllowList,
    remarkDocsVariables,
    validateInternalLinks,
} from "./validate"
import {
    DOCS_ROUTE,
    discoverVersions,
    partitionRebase,
    partitionRootsFor,
    partitionVersions,
    pathToSlugs,
    type VersionedCompiledDocsPage,
    type VersionsManifest,
} from "./versions"

// remarkLLMs({ _data: true }) stashes the processed agent markdown on the
// vfile but ships no DataMap augmentation for it (remarkStructure does).
declare module "vfile" {
    interface DataMap {
        markdown?: string
    }
}

export const MAX_PAGE_BYTES = 1024 * 1024
// Our protective bound, not a docs.json semantic. A version tree carries the
// version's own pages PLUS every unversioned page, and localized sites keep
// whole language trees unversioned. Serving trees are request-memoized; persist
// inserts are 2MB-sliced, so real-scale trees are fine; the cap only guards
// against runaway generated content.
export const MAX_PAGES_PER_VERSION = 4000

/**
 * Tenant Tailwind utilities. Utility classes authored in MDX
 * (`<div className="grid sm:grid-cols-2 …">`) are written for stock Tailwind;
 * the framework's own Tailwind build only scans the framework source, so tenant
 * classes got CSS only when a framework component happened to share them.
 * Every content version now compiles its own class candidates once, with
 * Tailwind's pure-JS compiler, and ships the result ahead of the authored
 * CSS in theme_css.
 *
 * - `theme(reference inline)`: no `:root { --spacing… --font-sans… }`
 *   emission (an unlayered re-declaration would clobber the framework's
 *   Inter/Geist Mono tokens) and literal values baked into each utility, so
 *   nothing depends on variables the framework build never emitted. Stock
 *   breakpoints on purpose: `md:` here is the stock 48rem, while the
 *   framework's 64rem `--breakpoint-md` is a chrome decision.
 * - Fonts re-declared WITHOUT inline so `font-sans` follows the tenant or
 *   framework font token at runtime.
 * - Colour aliases are exactly the names Mintlify-authored content uses.
 * - `@custom-variant dark` mirrors fumadocs' `.dark` class strategy.
 * - No preflight. Output lands in the document-global `utilities` layer,
 *   every rule scoped under `:where(#nd-page, [data-rail])` (article and
 *   pinned rail — the only places tenant markup renders): tenant utilities
 *   win ties with framework utilities on tenant elements (later source
 *   order), beat the zero-specificity `.prose :where()` typography, never
 *   touch chrome outside the article, and never beat the framework's
 *   unlayered rules or the tenant's own unlayered authored CSS.
 */
const TAILWIND_UTILITY_SOURCE = `@import "tailwindcss/theme.css" theme(reference inline);
@theme reference {
    --font-sans: initial;
    --font-sans: ui-sans-serif;
    --font-mono: initial;
    --font-mono: ui-monospace;
}
@theme inline reference {
    --color-primary: var(--color-fd-primary);
    --color-primary-light: var(--color-fd-primary);
    --color-primary-dark: var(--color-fd-primary);
    --color-background-light: var(--color-fd-background);
    --color-background-dark: var(--color-fd-background);
}
@custom-variant dark (&:where(.dark, .dark *));
@import "tailwindcss/utilities.css" layer(utilities);
`
// Default code themes are GitHub Light Default / Dark+ unless docs.json
// styling.codeblocks says otherwise; fumadocs' github-light/github-dark
// pair coloured tags and attributes differently.
const MINTLIFY_CODE_THEMES = {
    light: "github-light-default",
    dark: "dark-plus",
}
export const MAX_UTILITY_CANDIDATES = 20_000
export const MAX_UTILITY_CSS_BYTES = 128 * 1024
// A Tailwind candidate as it appears inside a class string: no whitespace,
// quotes, braces or angle brackets (the only characters that could break
// out of a selector or the inline <style>), ≤200 chars. Tailwind itself
// drops tokens that are not utilities, so recall matters more than
// precision; `url(` is refused because arbitrary `bg-[url(…)]` values would
// bypass the authored-CSS asset allow-list.
const UTILITY_CANDIDATE = /^[!-]?[a-z0-9@*[][\w\-:./[\]()%#,&>~+=*'!]{0,199}$/i

interface ExplicitReferenceContainer {
    directory?: string
    pages?: PageRef[]
    groups?: GroupNode[]
    tabs?: TabNode[]
    anchors?: AnchorNode[]
    dropdowns?: DropdownNode[]
    versions?: VersionNode[]
    languages?: LanguageNode[]
    products?: ProductNode[]
    menu?: MenuItemNode[]
    global?: GlobalNode | null
}

export type { DocsSnapshotFile } from "./snapshot"

export interface CompiledDocsPage {
    kind: DocsPageKind
    /** Virtual path within the docs root, e.g. "guides/intro.mdx". */
    path: string
    url: string
    slugs: string[]
    title: string
    description: string | null
    icon: string | null
    hidden: boolean
    frontmatter: Record<string, unknown>
    /**
     * Human rendition for the PDF export. kind="mdx": the page as MDX with
     * snippets, snippet props, page constants and docs variables resolved
     * (the authored source when it cannot be stringified). kind="openapi":
     * the same deterministic markdown as processedMarkdown.
     */
    source: string
    /**
     * Client-executed MDX function body — the FALLBACK path, kept only for
     * pages whose tree is not pure data (MDX expressions, snippet imports).
     * null for kind="openapi" and for SSR-eligible pages (which carry hast).
     */
    compiledJs: string | null
    /**
     * Final post-rehype hast for SSR-eligible pages (prepareHastArtifact) —
     * data the framework renders server-side; null → compiledJs path.
     */
    hast: HastRoot | null
    /**
     * Desktop right-rail tree (authored <Panel> / pinned examples), split out
     * of `hast` at ingest — null when the page pins nothing or rides the
     * compiled-JS fallback (which renders inline as before).
     */
    railHast: HastRoot | null
    processedMarkdown: string
    /**
     * The page's `<page>.agent.md` sibling, verbatim: served by every agent
     * read of the page in place of processedMarkdown. null when it has none.
     */
    agentMarkdown: string | null
    /**
     * In-memory only (title/excerpt derivation, code-example extraction) —
     * NOT persisted; null for kind="openapi".
     */
    mdast: Root | null
    /** Precomputed at ingest from the mdast; served verbatim by MCP/agents. */
    codeExamples: DocsCodeExample[]
    /** Authored <Update> entries from the mdast; null when none are authored. */
    updates: DocsPageUpdates | null
    structuredData: StructuredData
    toc: TOCItemType[]
    /** Serialized fumadocs-openapi page props; null for kind="mdx". */
    openapiProps: DocsPageOpenapiProps | null
}

export interface CompiledDocsMeta {
    path: string
    data: Record<string, unknown>
}

export interface RawDocsAsset {
    path: string
    bytes: Uint8Array
}

export type CompileDocsResult =
    | {
          ok: true
          pages: VersionedCompiledDocsPage[]
          metas: CompiledDocsMeta[]
          openapiDocuments: CompiledOpenapiDocument[]
          /** Authored Agent Skills (skills.ts) — not pages. */
          skills: CompiledDocsSkill[]
          assets: PreparedAsset[]
          cssFiles: Array<{ path: string; content: string }>
          config: DocsConfigSuperset | null
          diagnostics: Diagnostic[]
          navSource: NavSource
          themeTokens: ThemeTokens
          themeCss: string
          /** Resolve via fonts.ts/resolveFontCss after compile; store as font_css. */
          fontInputs: DocsFontInputs
          /** Why pages stayed on the compiled-JS path — ingest reporting only. */
          ssrFallbacks: Partial<Record<HastFallbackReason, number>>
          layoutPreset: LayoutPreset
          versionsManifest: VersionsManifest
          localesManifest: LocalesManifest
          redirects: NormalizedRedirect[]
          seo: StoredSeo
          integrations: StoredIntegrations
      }
    | { ok: false; violations: DocsViolation[] }

/**
 * Acronyms in fallback titles keep uppercase: humanize("api-reference")
 * should produce "API Reference", not "Api reference". Other words use
 * Title Case.
 */
const HUMANIZE_ACRONYMS = new Set([
    "ai",
    "api",
    "cd",
    "ci",
    "cli",
    "faq",
    "llm",
    "llms",
    "mcp",
    "sdk",
    "sdks",
    "seo",
    "sso",
    "ui",
    "url",
    "ux",
])

function humanize(value: string): string {
    return value
        .replace(/\.(mdx|md)$/i, "")
        .split(/[-_]+/)
        .filter(Boolean)
        .map((word) => {
            const lower = word.toLowerCase()
            if (HUMANIZE_ACRONYMS.has(lower)) return lower.toUpperCase()
            return `${word.charAt(0).toUpperCase()}${lower.slice(1)}`
        })
        .join(" ")
}

const HEADING_OPTIONS: RemarkHeadingOptions = {
    slug: (root, _heading, text) => headingSlug(root, text),
}

/**
 * Unconditional source preprocessing: authored `## Heading {#custom-id}`
 * anchors → the `[#custom-id]` form fumadocs' remarkHeading understands
 * (the raw form parses as a broken JSX expression).
 */
function preprocessMdxSource(source: string): string {
    return source.replace(
        /^(#{1,6}[^\n]*?)\s*\{#([^}\s]+)\}[ \t]*$/gm,
        "$1 [#$2]",
    )
}

function collectLinks(tree: Root): string[] {
    const links: string[] = []
    visit(tree, (node) => {
        if (node.type === "link" && typeof node.url === "string") {
            if (!node.url.startsWith("/_assets/")) links.push(node.url)
            return
        }
        // Allowed components carry links too (<Card href="/x">) — the
        // allow-list already forces attribute values to literal strings, so
        // href/to attributes validate exactly like markdown links.
        if (
            node.type === "mdxJsxFlowElement" ||
            node.type === "mdxJsxTextElement"
        ) {
            for (const attr of node.attributes) {
                if (
                    attr.type === "mdxJsxAttribute" &&
                    (attr.name === "href" || attr.name === "to") &&
                    typeof attr.value === "string"
                ) {
                    if (!attr.value.startsWith("/_assets/"))
                        links.push(attr.value)
                }
            }
        }
    })
    return links
}

/**
 * Authored table cells embed multi-line code as inline spans with `<br/>`
 * separators (`` `js<br/>import x from "y";<br/>` ``), meant to render as
 * highlighted blocks. Rewrite the hast inline <code> into a real pre>code
 * BEFORE rehypeCode runs so shiki highlights it instead of the cell printing
 * literal "<br/>" text.
 */
function rehypeTableCellCode() {
    return (tree: HastRoot) => {
        visit(tree, "element", (node: HastElement) => {
            if (node.tagName !== "td" && node.tagName !== "th") return
            node.children = node.children.map((child) => {
                if (
                    child.type !== "element" ||
                    child.tagName !== "code" ||
                    child.children.length !== 1 ||
                    child.children[0]?.type !== "text" ||
                    !child.children[0].value.includes("<br/>")
                )
                    return child
                const parts = child.children[0].value.split("<br/>")
                const lang = /^[a-z0-9]+$/.test(parts[0] ?? "")
                    ? parts.shift()
                    : null
                const pre: HastElement = {
                    type: "element",
                    tagName: "pre",
                    properties: {},
                    children: [
                        {
                            type: "element",
                            tagName: "code",
                            properties: {
                                className: [`language-${lang ?? "plaintext"}`],
                            },
                            children: [
                                {
                                    type: "text",
                                    value: parts.join("\n").trim(),
                                },
                            ],
                        },
                    ],
                }
                return pre
            })
        })
    }
}

/** Normalize links that resolve within this snapshot to canonical root-relative
 * paths. Resolve relative links against the source file (docs.json semantics),
 * then map to served paths; leave external and unresolved links for validation. */
function remarkRebaseRootLinks(input: {
    knownStems: ReadonlySet<string>
    /** Source-path stem (extension stripped) → served slug stem, every page. */
    servedStemBySourceStem: ReadonlyMap<string, string>
    /**
     * Source directory of the page being compiled ("." at the repo root);
     * null disables relative-link rebasing — config markdown has no source
     * location for relatives to resolve against.
     */
    sourceDir: string | null
    /** seo.trailingSlash — rebased links render the canonical spelling. */
    trailingSlash: boolean
}) {
    const rebase = (value: string): string | null => {
        if (value.startsWith("//")) return null
        const split = /^([^#?]*)([#?].*)?$/.exec(value)
        const raw = split?.[1] ?? ""
        const suffix = split?.[2] ?? ""
        if (value.startsWith("/")) {
            const stem = raw
                .replace(/\.(mdx|md)$/i, "")
                .replace(/^\/+|\/+$/g, "")
            if (!stem || !input.knownStems.has(stem)) return null
            return formatDocsPath(`/${stem}${suffix}`, input.trailingSlash)
        }
        // Relative target: anchors/query-only values and protocols
        // (https:, mailto:) pass through.
        if (input.sourceDir === null || !raw) return null
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
        const joined = posix
            .join(input.sourceDir, raw)
            .replace(/\.(mdx|md)$/i, "")
            .replace(/\/+$/, "")
        if (joined === "" || joined === ".." || joined.startsWith("../"))
            return null
        // ".." chains to the repository root normalize to "." — that IS the
        // root index page, whose source stem is "index".
        const resolved = joined === "." ? "index" : joined
        const served =
            input.servedStemBySourceStem.get(resolved) ??
            // "../guide" may address guide/index.mdx (served at /guide).
            input.servedStemBySourceStem.get(`${resolved}/index`)
        if (served === undefined) return null
        return formatDocsPath(`/${served}${suffix}`, input.trailingSlash)
    }
    return () => (tree: Root) => {
        visit(tree, (node) => {
            if (node.type === "link" && typeof node.url === "string") {
                node.url = rebase(node.url) ?? node.url
                return
            }
            if (
                node.type === "mdxJsxFlowElement" ||
                node.type === "mdxJsxTextElement"
            ) {
                for (const attr of node.attributes) {
                    if (
                        attr.type === "mdxJsxAttribute" &&
                        (attr.name === "href" || attr.name === "to") &&
                        typeof attr.value === "string"
                    ) {
                        attr.value = rebase(attr.value) ?? attr.value
                    }
                }
            }
        })
    }
}

// Broken/external asset references render as-is rather than blocking the
// deploy: rewrite what resolves, warn about the rest, and leave the URL
// untouched so the page still ships.
function remarkRewriteAssetReferences(input: {
    path: string
    assetHashes: ReadonlyMap<string, string>
    /** Intrinsic image sizes by content hash (see prepareAssets). */
    assetDimensions?: ReadonlyMap<string, { width: number; height: number }>
    allowedHosts: string[]
    diagnostics: Diagnostic[]
}) {
    const warn = (message: string) =>
        input.diagnostics.push({
            code: "asset_missing",
            severity: "warn",
            message,
            path: input.path,
        })
    const dimensionsFor = (url: string) =>
        input.assetDimensions?.get(
            url.replace(/^\/_assets\//, "").replace(/[?#].*$/, ""),
        )
    return () => (tree: Root) => {
        visit(tree, (node) => {
            if (
                node.type === "link" ||
                node.type === "image" ||
                node.type === "definition"
            ) {
                const assetContext = isAssetShapedReference(node.url)
                if (!assetContext) return
                const resolved = resolveAssetReference({
                    value: node.url,
                    sourcePath: input.path,
                    assetHashes: input.assetHashes,
                    allowedHosts: input.allowedHosts,
                })
                if (resolved.kind === "asset") {
                    node.url = resolved.url
                    const size =
                        node.type === "image"
                            ? dimensionsFor(resolved.url)
                            : undefined
                    if (size) {
                        node.data ??= {}
                        node.data.hProperties = {
                            ...node.data.hProperties,
                            width: size.width,
                            height: size.height,
                        }
                    }
                } else if (resolved.kind === "missing") {
                    warn(
                        `broken asset reference: ${node.url} (${resolved.path} was not ingested)`,
                    )
                }
                return
            }
            if (
                node.type !== "mdxJsxFlowElement" &&
                node.type !== "mdxJsxTextElement"
            )
                return
            for (const attribute of node.attributes) {
                if (
                    attribute.type !== "mdxJsxAttribute" ||
                    typeof attribute.value !== "string" ||
                    (attribute.name !== "src" &&
                        attribute.name !== "href" &&
                        attribute.name !== "poster" &&
                        attribute.name !== "icon" &&
                        // Card thumbnails (<Card img="/images/…">).
                        attribute.name !== "img")
                )
                    continue
                const assetContext = isAssetShapedReference(attribute.value)
                if (!assetContext) continue
                const resolved = resolveAssetReference({
                    value: attribute.value,
                    sourcePath: input.path,
                    assetHashes: input.assetHashes,
                    allowedHosts: input.allowedHosts,
                })
                if (resolved.kind === "asset") {
                    attribute.value = resolved.url
                    // Only image elements take intrinsic dimensions; <a
                    // href>, <video poster>, and Card thumbnails size
                    // themselves.
                    const size =
                        attribute.name === "src" &&
                        (node.name === "img" ||
                            node.name === "Image" ||
                            node.name === "Frame")
                            ? dimensionsFor(resolved.url)
                            : undefined
                    if (
                        size &&
                        !node.attributes.some(
                            (other) =>
                                other.type === "mdxJsxAttribute" &&
                                (other.name === "width" ||
                                    other.name === "height"),
                        )
                    ) {
                        node.attributes.push(
                            {
                                type: "mdxJsxAttribute",
                                name: "width",
                                value: String(size.width),
                            },
                            {
                                type: "mdxJsxAttribute",
                                name: "height",
                                value: String(size.height),
                            },
                        )
                    }
                } else if (resolved.kind === "missing") {
                    warn(
                        `broken asset reference: ${attribute.value} (${resolved.path} was not ingested)`,
                    )
                }
            }
        })
    }
}

/** Split top-level Panel and request/response examples into the desktop TOC
 * rail after HAST preparation. Original content stays inline on mobile; a
 * Panel owns its full rail subtree. */
function splitPageRail(tree: HastRoot): HastRoot | null {
    const hasPanel = tree.children.some(
        (child) => child.type === "mdxJsxFlowElement" && child.name === "Panel",
    )
    const railChildren: HastRoot["children"] = []
    tree.children = tree.children.map((child) => {
        if (child.type !== "mdxJsxFlowElement" || !child.name) return child
        const pins = hasPanel
            ? child.name === "Panel"
            : child.name === "RequestExample" ||
              child.name === "ResponseExample"
        if (!pins) return child
        if (hasPanel) railChildren.push(...structuredClone(child.children))
        else railChildren.push(structuredClone(child))
        return {
            type: "element",
            tagName: "div",
            // data-rail-inline lets serve UN-hide the inline copy when the
            // page mode/preset suppresses the rail (wide/center/frame,
            // editorial) — otherwise pinned content would vanish on xl.
            properties: { className: ["xl:hidden"], "data-rail-inline": "" },
            children: [child],
        }
    })
    if (railChildren.length === 0) return null
    const rail: HastRoot = { type: "root", children: railChildren }
    // The inline copy keeps the authored heading IDs (the TOC never links
    // into the rail, and the rail is the desktop-only clone) — strip them
    // from the clone so a page never ships duplicate anchor IDs.
    visit(rail, "element", (node) => {
        if (node.properties && "id" in node.properties)
            delete node.properties.id
    })
    return rail
}

/** Compile snapshot pages into serving artifacts with one Markdown parse each.
 * Invalid page content rejects the snapshot; config errors warn and fall back
 * field by field. */
export async function compileDocs(
    files: DocsSnapshotFile[],
): Promise<CompileDocsResult> {
    const { bundledLanguages, bundledThemes, createHighlighter } = await import(
        "shiki"
    )
    const violations: DocsViolation[] = []
    const ignoreRules = files
        .filter(
            (file): file is Extract<DocsSnapshotFile, { kind: "text" }> =>
                file.kind === "text" &&
                /^\.(mintignore|docsignore)$/i.test(file.path),
        )
        .sort((a, b) => a.path.localeCompare(b.path))
    const ignoreMatcher = ignore()
    for (const file of ignoreRules) ignoreMatcher.add(file.content)
    const admittedFiles = files.filter((file) => {
        const normalized = file.path.replaceAll("\\", "/").replace(/^\.\//, "")
        return !ignoreMatcher.ignores(normalized)
    })

    // _remote/ is the ingest fetcher's synthetic namespace (content-hash
    // keyed rows for admitted external images) — an authored file there
    // could collide with a generated row's (version, path) identity and
    // orphan the fetched bytes.
    const reservedAssetDiagnostics: Diagnostic[] = []
    const rawAssets = admittedFiles.flatMap((file) => {
        if (file.kind !== "binary") return []
        if (file.path === "_remote" || file.path.startsWith("_remote/")) {
            reservedAssetDiagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Asset path "${file.path}" is reserved for ingest-fetched remote assets and was skipped.`,
                path: file.path,
            })
            return []
        }
        return [{ path: file.path, bytes: file.bytes } satisfies RawDocsAsset]
    })
    const prepared = await prepareAssets(rawAssets)
    const assets = [...prepared.assets]
    const assetHashes = new Map(
        assets.map((asset) => [asset.path, asset.contentHash]),
    )
    // Intrinsic sizes by content hash, stamped onto rewritten <img>/image
    // references so the served page reserves layout before the bytes land.
    const assetDimensions = new Map(
        assets.flatMap((asset) =>
            asset.width !== null && asset.height !== null
                ? [
                      [
                          asset.contentHash,
                          { width: asset.width, height: asset.height },
                      ] as const,
                  ]
                : [],
        ),
    )
    const parsedConfig = parseDocsConfig(admittedFiles)
    parsedConfig.diagnostics.push(
        ...reservedAssetDiagnostics,
        ...prepared.diagnostics,
    )
    if (parsedConfig.fatal) {
        violations.push(parsedConfig.fatal)
        return { ok: false, violations }
    }
    const pages: CompiledDocsPage[] = []
    const metas: CompiledDocsMeta[] = []
    const ssrFallbacks: Partial<Record<HastFallbackReason, number>> = {}
    const textFiles = admittedFiles.filter(
        (file): file is Extract<DocsSnapshotFile, { kind: "text" }> =>
            file.kind === "text",
    )

    // SDK reference sections (navigation sdk nodes, typedoc-first): each
    // node's typedoc --json artifact becomes markdown pages appended to
    // textFiles BEFORE the page loop, so they compile through the standard
    // MDX pipeline (hast, search, agent markdown) with zero serving changes,
    // and the rewritten navigation lists them under their sdk node. Must run
    // before the structuredClone below so both config views agree.
    if (parsedConfig.config?.navigation !== undefined) {
        const sdkResult = generateSdkDocs({
            navigation: parsedConfig.config.navigation,
            files: textFiles,
            diagnostics: parsedConfig.diagnostics,
        })
        parsedConfig.config = {
            ...parsedConfig.config,
            navigation: sdkResult.navigation,
        }
        for (const file of sdkResult.files) {
            textFiles.push({ ...file, kind: "text" })
        }
    }
    const allowedHosts =
        parsedConfig.config?.[CONFIG_EXTENSION_KEY]?.assets?.allowExternal ?? []
    // lucide AND FontAwesome vocabulary both resolve through the committed
    // maps (docs-icon-map + docs-icon-fa-map). docs.json's DEFAULT library
    // when icons is absent is FontAwesome — authored FA names need no
    // icons block at all. Other libraries (tabler) stay best-effort.
    const iconLibrary = parsedConfig.config?.icons?.library ?? "fontawesome"
    if (iconLibrary !== "lucide" && iconLibrary !== "fontawesome") {
        parsedConfig.diagnostics.push({
            code: "icon_lib_unsupported",
            severity: "warn",
            message: `icons.library "${iconLibrary}" is best-effort: names are resolved through the lucide-vocabulary icon map; unresolved names fall back to the default glyph.`,
            path: "docs.json",
        })
    }
    const hadConfig = parsedConfig.config !== null
    const config: DocsConfigSuperset = structuredClone(
        parsedConfig.config ?? {},
    )
    let hasResolvedBranding = hadConfig
    let lightLogoAsset: PreparedAsset | undefined
    const rewriteConfigValue = (
        value: string,
        field: string,
        sourcePath = "docs.json",
    ): string | null => {
        const resolved = resolveAssetReference({
            value,
            sourcePath,
            assetHashes,
            allowedHosts,
        })
        if (resolved.kind === "asset") return resolved.url
        if (resolved.kind === "missing") {
            parsedConfig.diagnostics.push({
                code: "asset_missing",
                severity: "warn",
                message: `Field "${field}" references an asset that was not ingested: ${value}.`,
                path: sourcePath,
            })
        } else if (resolved.kind === "external" && !resolved.allowed) {
            parsedConfig.diagnostics.push({
                code: "asset_missing",
                severity: "warn",
                message: `Field "${field}" uses an external asset host that is not allow-listed: ${value}.`,
                path: sourcePath,
            })
            return null
        }
        return value
    }
    // Icon values are either vocabulary names (lucide/FontAwesome, resolved
    // through the committed maps) or asset references (such as
    // `/images/icons/amp.svg` frontmatter, hosted https URLs).
    // Asset-shaped ones hash like every other asset so the serve side can
    // render them as <img>; names pass through untouched.
    const iconIsAssetShaped = (value: string) =>
        value.startsWith("/") ||
        value.startsWith("./") ||
        value.startsWith("../") ||
        /^https?:\/\//i.test(value)
    const rewriteIconValue = (
        value: string | undefined,
        field: string,
        sourcePath = "docs.json",
    ): string | undefined => {
        const trimmed = value?.trim()
        if (!trimmed || !iconIsAssetShaped(trimmed)) return value
        // External image icons follow the CONTENT-image policy (pass
        // through unchanged when hosted externally), not the
        // stricter branding policy that drops non-allow-listed hosts.
        // Protocol-relative //cdn… counts as external too.
        if (/^(?:https?:)?\/\//i.test(trimmed)) return trimmed
        return rewriteConfigValue(trimmed, field, sourcePath) ?? undefined
    }

    if (typeof config.logo === "string") {
        config.logo = rewriteConfigValue(config.logo, "logo")
    } else if (config.logo) {
        const light = rewriteConfigValue(config.logo.light, "logo.light")
        const dark = rewriteConfigValue(config.logo.dark, "logo.dark")
        config.logo = light && dark ? { ...config.logo, light, dark } : null
    }

    const assetByPath = new Map(
        assets.map((asset) => [asset.path.toLowerCase(), asset]),
    )
    if (config.logo === undefined) {
        const modePairLight = assetByPath.get("logo/light.svg")
        const modePairDark = assetByPath.get("logo/dark.svg")
        const rootAndFolderCandidates = assets
            .filter((asset) => {
                const path = asset.path.toLowerCase()
                return (
                    path === "logo.svg" ||
                    path === "logo.png" ||
                    /^logo\/logo\.(?:svg|png|webp|jpe?g|gif)$/i.test(path)
                )
            })
            .sort((a, b) => {
                const aPath = a.path.toLowerCase()
                const bPath = b.path.toLowerCase()
                const aPriority =
                    aPath === "logo.svg"
                        ? 0
                        : aPath === "logo.png"
                          ? 1
                          : aPath.endsWith(".svg")
                            ? 2
                            : aPath.endsWith(".png")
                              ? 3
                              : 4
                const bPriority =
                    bPath === "logo.svg"
                        ? 0
                        : bPath === "logo.png"
                          ? 1
                          : bPath.endsWith(".svg")
                            ? 2
                            : bPath.endsWith(".png")
                              ? 3
                              : 4
                return aPriority - bPriority || a.path.localeCompare(b.path)
            })
        const detectedChoices =
            (modePairLight && modePairDark ? 1 : 0) +
            rootAndFolderCandidates.length
        if (detectedChoices > 1) {
            parsedConfig.diagnostics.push({
                code: "logo_multiple",
                severity: "info",
                message:
                    "Multiple conventional logo candidates were found; the §1.8 cascade selected the highest-priority asset.",
            })
        }
        if (modePairLight && modePairDark) {
            config.logo = {
                light: `/_assets/${modePairLight.contentHash}`,
                dark: `/_assets/${modePairDark.contentHash}`,
            }
            lightLogoAsset = modePairLight
            hasResolvedBranding = true
        } else {
            const detected = rootAndFolderCandidates[0]
            if (detected) {
                const darkPath = detected.path.replace(/(\.[^./]+)$/, "-dark$1")
                const dark = assetByPath.get(darkPath.toLowerCase())
                config.logo = dark
                    ? {
                          light: `/_assets/${detected.contentHash}`,
                          dark: `/_assets/${dark.contentHash}`,
                      }
                    : `/_assets/${detected.contentHash}`
                lightLogoAsset = detected
                hasResolvedBranding = true
            }
        }
    } else if (config.logo !== null) {
        const lightLogoUrl =
            typeof config.logo === "string" ? config.logo : config.logo.light
        const lightLogoHash = /^\/_assets\/([a-f\d]{64})/i.exec(
            lightLogoUrl,
        )?.[1]
        lightLogoAsset = lightLogoHash
            ? assets.find((asset) => asset.contentHash === lightLogoHash)
            : undefined
    }

    // docs.json background.image — hashed like every branding asset so the
    // served layer is immutable; allow-listed external URLs pass through.
    const backgroundImage = config.background?.image
    if (typeof backgroundImage === "string") {
        const rewritten = rewriteConfigValue(
            backgroundImage,
            "background.image",
        )
        config.background = {
            ...config.background,
            ...(rewritten ? { image: rewritten } : { image: undefined }),
        }
    } else if (backgroundImage) {
        const light = rewriteConfigValue(
            backgroundImage.light,
            "background.image.light",
        )
        const dark = rewriteConfigValue(
            backgroundImage.dark,
            "background.image.dark",
        )
        config.background = {
            ...config.background,
            ...(light && dark
                ? { image: { light, dark } }
                : { image: undefined }),
        }
    }

    // Custom contextual options may carry an image icon (src) —
    // hashed like every branding asset; allow-listed externals pass through,
    // anything else drops the src so the renderer falls back to the glyph.
    const contextualOptions = config.contextual?.options
    if (contextualOptions?.some((option) => typeof option !== "string")) {
        config.contextual = {
            ...config.contextual,
            options: contextualOptions.map((option, index) => {
                if (
                    typeof option === "string" ||
                    typeof option.src !== "string"
                )
                    return option
                const rewritten = rewriteConfigValue(
                    option.src,
                    `contextual.options[${index}].src`,
                )
                return {
                    ...option,
                    ...(rewritten ? { src: rewritten } : { src: undefined }),
                }
            }),
        }
    }

    // docs.json thumbnails.background — hashed like the branding assets so
    // the OG renderer can load the bytes by content hash.
    const thumbnailsBackground = config.thumbnails?.background
    if (typeof thumbnailsBackground === "string") {
        const rewritten = rewriteConfigValue(
            thumbnailsBackground,
            "thumbnails.background",
        )
        config.thumbnails = {
            ...config.thumbnails,
            ...(rewritten
                ? { background: rewritten }
                : { background: undefined }),
        }
    }

    if (typeof config.favicon === "string") {
        config.favicon = rewriteConfigValue(config.favicon, "favicon")
    } else if (config.favicon) {
        const light = rewriteConfigValue(config.favicon.light, "favicon.light")
        const dark = rewriteConfigValue(config.favicon.dark, "favicon.dark")
        config.favicon = light && dark ? { light, dark } : null
    }
    if (config.favicon === undefined) {
        const detectedFavicon = ["favicon.ico", "favicon.svg", "favicon.png"]
            .map((path) => assetByPath.get(path))
            .find((asset) => asset !== undefined)
        if (detectedFavicon) {
            config.favicon = `/_assets/${detectedFavicon.contentHash}`
            hasResolvedBranding = true
        } else if (lightLogoAsset?.bytes) {
            const generated = await deriveFavicon(
                lightLogoAsset.bytes,
                lightLogoAsset.mimeType,
            )
            if (generated) {
                const generatedAsset = (
                    await prepareAssets([
                        {
                            path: "__generated/favicon.png",
                            bytes: generated.bytes,
                        },
                    ])
                ).assets[0]
                if (generatedAsset) {
                    assets.push(generatedAsset)
                    assetHashes.set(
                        generatedAsset.path,
                        generatedAsset.contentHash,
                    )
                    config.favicon = `/_assets/${generatedAsset.contentHash}`
                    hasResolvedBranding = true
                }
            } else {
                parsedConfig.diagnostics.push({
                    code: "asset_missing",
                    severity: "warn",
                    message:
                        "The detected logo could not be decoded to generate a favicon; the framework monogram fallback will be used.",
                    path: lightLogoAsset.path,
                })
            }
        }
    }
    // Hash asset-shaped `icon` values across navigation + navbar BEFORE the
    // merge-back below: every nav derivation (resolveNavigationModel, locale
    // enumeration, compileNavigation, membership stamping) reads
    // parsedConfig.config.navigation, so rewriting here puts /_assets URLs
    // into __resolvedNav and every locale manifest in one pass. Reflect
    // read/write keeps the walk cast-free over the loosely-typed nav tree.
    {
        const rewriteIconsDeep = (node: unknown, field: string): void => {
            if (Array.isArray(node)) {
                for (const [index, item] of node.entries())
                    rewriteIconsDeep(item, `${field}[${index}]`)
                return
            }
            if (typeof node !== "object" || node === null) return
            for (const [key, value] of Object.entries(node)) {
                if (key === "icon" && typeof value === "string") {
                    if (iconIsAssetShaped(value.trim()))
                        Reflect.set(
                            node,
                            key,
                            rewriteIconValue(value, `${field}.icon`),
                        )
                    continue
                }
                rewriteIconsDeep(value, `${field}.${key}`)
            }
        }
        rewriteIconsDeep(config.navigation, "navigation")
        rewriteIconsDeep(config.navbar, "navbar")
        // Custom contextual option objects carry icons too — hash asset-
        // shaped values so the menu can render them.
        rewriteIconsDeep(config.contextual, "contextual")
    }
    parsedConfig.config = hasResolvedBranding ? config : null
    const cssFiles = textFiles
        .filter((file) => /\.css$/i.test(file.path))
        .map((file) => ({ path: file.path, content: file.content }))
    const snippetFiles = textFiles.filter((file) =>
        /^snippets\/.*\.(mdx|md)$/i.test(file.path),
    )
    // js/jsx snippet modules — importable from pages (reusable snippet
    // components); compiled with esbuild and inlined into the importing
    // page's client-executed JS on demand.
    const jsSnippetSources = new Map(
        textFiles
            .filter((file) =>
                /^snippets\/.*\.(js|jsx|ts|tsx)$/i.test(file.path),
            )
            .map((file) => [file.path, file.content]),
    )
    const compiledJsSnippets = new Map<string, CompiledJsSnippet>()
    const failedJsSnippets = new Map<string, string>()
    // Version-wide Tailwind class candidates (TAILWIND_UTILITY_SOURCE above).
    // Fed from every page's HAST and, for JS-path inputs whose class strings
    // are only visible as source text (page-local components, js snippets,
    // dynamic className expressions), from the string literals in that text.
    const utilityCandidates = new Set<string>()
    let utilityCandidatesOverflowed = false
    const collectUtilityTokens = (text: string) => {
        for (const token of text.split(/\s+/)) {
            if (!token || !UTILITY_CANDIDATE.test(token)) continue
            // Case-insensitive: `[background-image:URL(https://…)]` would
            // otherwise slip past the authored-CSS asset allow-list.
            if (/(?:url|image-set|src)\(/i.test(token)) continue
            if (utilityCandidates.size >= MAX_UTILITY_CANDIDATES) {
                utilityCandidatesOverflowed = true
                return
            }
            utilityCandidates.add(token)
        }
    }
    // String-literal pass for source text: bare-word scanning of MDX prose
    // would make every English word a candidate, so only quoted literals
    // count. A small lexer rather than a regex — a quote or brace inside a
    // template hole (`${v === "}" ? "a" : "b"}`) or a template nested in a
    // hole would desync a brace count or a quote match. Single/double-quoted
    // strings stop at a newline so an apostrophe in JSX prose ("Don't")
    // never swallows the rest of the file. Comments and regex literals are
    // not recognised: the inputs include MDX prose, where `//` (URLs) and
    // `/*` (globs) are ordinary text. Returns the index of the `}` closing
    // the enclosing hole (or the end of the text).
    const collectUtilityLiterals = (
        source: string,
        from = 0,
        inHole = false,
    ): number => {
        let depth = 0
        let i = from
        while (i < source.length) {
            const ch = source[i]
            if (ch === '"' || ch === "'") {
                let j = i + 1
                while (
                    j < source.length &&
                    source[j] !== ch &&
                    source[j] !== "\n"
                ) {
                    if (source[j] === "\\") j += 1
                    j += 1
                }
                if (source[j] === ch) {
                    collectUtilityTokens(source.slice(i + 1, j))
                    i = j + 1
                } else i += 1
                continue
            }
            if (ch === "`") {
                // Static chunks are candidates; each `${…}` hole is JS of its
                // own (strings, nested templates, object braces).
                let j = i + 1
                let chunk = j
                while (j < source.length && source[j] !== "`") {
                    if (source[j] === "\\") {
                        j += 2
                        continue
                    }
                    if (source[j] === "$" && source[j + 1] === "{") {
                        collectUtilityTokens(source.slice(chunk, j))
                        j = collectUtilityLiterals(source, j + 2, true) + 1
                        chunk = j
                        continue
                    }
                    j += 1
                }
                collectUtilityTokens(source.slice(chunk, j))
                i = j + 1
                continue
            }
            if (inHole) {
                if (ch === "{") depth += 1
                else if (ch === "}") {
                    if (depth === 0) return i
                    depth -= 1
                }
            }
            i += 1
        }
        return source.length
    }
    const classAttributeSchema = z.object({
        type: z.literal("mdxJsxAttribute"),
        name: z.enum(["className", "class"]),
        value: z.union([
            z.string(),
            z.object({
                type: z.literal("mdxJsxAttributeValueExpression"),
                data: z
                    .object({
                        estree: z
                            .object({
                                body: z.array(
                                    z.object({
                                        type: z.string(),
                                        expression: z.unknown().optional(),
                                    }),
                                ),
                            })
                            .optional(),
                    })
                    .optional(),
            }),
        ]),
    })
    const classCarrierSchema = z.object({
        properties: z
            .object({
                className: z
                    .array(z.union([z.string(), z.number()]))
                    .optional(),
            })
            .optional(),
        attributes: z.array(z.unknown()).optional(),
    })
    const metaFiles = textFiles.filter((f) => /(^|\/)meta\.json$/i.test(f.path))
    const explicitReferences = new Set<string>()

    for (const file of metaFiles) {
        let parsed: unknown
        try {
            parsed = JSON.parse(file.content)
        } catch {
            violations.push({ path: file.path, message: "invalid JSON" })
            continue
        }
        const meta = docsMetaFileSchema.safeParse(parsed)
        if (!meta.success) {
            violations.push({
                path: file.path,
                message: `invalid meta.json: ${meta.error.issues[0]?.message ?? "schema error"}`,
            })
            continue
        }
        if (typeof meta.data.icon === "string") {
            // Authored meta.json icons follow the same name-or-asset split
            // as nav icons; relative paths resolve beside the meta file.
            meta.data.icon = rewriteIconValue(
                meta.data.icon,
                "meta icon",
                file.path,
            )
        }
        metas.push({ path: file.path, data: meta.data })
        const directory = file.path.includes("/")
            ? file.path.slice(0, file.path.lastIndexOf("/"))
            : ""
        for (const page of meta.data.pages ?? []) {
            if (/^(\.\.\.|z\.\.\.a|!|---|\[|external:)/.test(page)) continue
            explicitReferences.add(
                [directory, page]
                    .filter(Boolean)
                    .join("/")
                    .replace(/^\//, "")
                    .replace(/\.(mdx|md)$/i, ""),
            )
        }
    }

    const navigationStack: ExplicitReferenceContainer[] = parsedConfig.config
        ?.navigation
        ? [parsedConfig.config.navigation]
        : []
    while (navigationStack.length > 0) {
        const current = navigationStack.pop()
        if (!current) continue
        if (current.directory) {
            explicitReferences.add(
                current.directory
                    .replace(/^\//, "")
                    .replace(/\.(mdx|md)$/i, ""),
            )
        }
        for (const page of current.pages ?? []) {
            if (typeof page !== "string") continue
            explicitReferences.add(
                page.replace(/^\//, "").replace(/\.(mdx|md)$/i, ""),
            )
        }
        navigationStack.push(
            ...(current.groups ?? []),
            ...(current.tabs ?? []),
            ...(current.anchors ?? []),
            ...(current.dropdowns ?? []),
            ...(current.versions ?? []),
            ...(current.languages ?? []),
            ...(current.products ?? []),
            ...(current.menu ?? []),
            ...(current.global ? [current.global] : []),
        )
    }

    // `.agent.md` siblings are agent renditions of the adjacent page, not
    // pages: each is stored on its page (agentMarkdown) and never becomes a
    // `<slug>.agent` page or a navigation entry. A root README.md is repo
    // documentation, not docs content.
    // Authored Agent Skills are served as skills, not pages — and so is
    // everything beside a SKILL.md (references/, assets/): a skill's access
    // policy covers its whole directory, so none of it may publish as a page.
    const skillDirectories = textFiles
        .filter((file) => isSkillPath(file.path))
        .map((file) => file.path.replace(/(?:^|\/)[^/]+$/, ""))
        .filter((directory) => directory !== "")
    const authoredPageFiles = textFiles.filter(
        (file) =>
            /\.(mdx|md)$/i.test(file.path) &&
            !/\.agent\.md$/i.test(file.path) &&
            !/^readme\.md$/i.test(file.path) &&
            !/^snippets\//i.test(file.path) &&
            !isSkillPath(file.path) &&
            !skillDirectories.some((directory) =>
                file.path.startsWith(`${directory}/`),
            ),
    )
    // Renditions keyed by the stem they belong to (`guide.agent.md` →
    // `guide`); one beside no page is reported and dropped. Snippets and
    // skill directories never publish pages, so nothing there is an orphan.
    const agentRenditionByStem = new Map<string, string>()
    for (const file of textFiles) {
        if (
            !/\.agent\.md$/i.test(file.path) ||
            /^snippets\//i.test(file.path) ||
            isSkillPath(file.path) ||
            skillDirectories.some((directory) =>
                file.path.startsWith(`${directory}/`),
            )
        )
            continue
        const stem = file.path.replace(/\.agent\.md$/i, "")
        if (
            authoredPageFiles.some(
                (page) => page.path.replace(/\.(mdx|md)$/i, "") === stem,
            )
        ) {
            agentRenditionByStem.set(stem, file.content)
            continue
        }
        parsedConfig.diagnostics.push({
            code: "agent_rendition_orphaned",
            severity: "warn",
            path: file.path,
            message: `Agent rendition has no page beside it: add ${stem}.mdx or remove this file. It is not served.`,
        })
    }
    const pageFiles = authoredPageFiles.filter((file) => {
        const stem = file.path.replace(/\.(mdx|md)$/i, "")
        const containsDraftFolder = stem
            .split("/")
            .some((segment) => segment.startsWith("_"))
        if (!containsDraftFolder) return true
        return [...explicitReferences].some(
            (reference) =>
                stem === reference || stem.startsWith(`${reference}/`),
        )
    })

    // Derive source-to-served stems with partitionVersions' locale/version
    // rules. Membership uses served paths; relative targets resolve through
    // authored paths, so rebased links match persisted routes.
    const servedStemBySourceStem = (() => {
        const navigation =
            parsedConfig.navSource === "config"
                ? (parsedConfig.config?.navigation ?? null)
                : null
        const localeModels = navigation ? enumerateLocales(navigation) : []
        const defaultModel =
            localeModels.find((model) => model.default) ??
            localeModels[0] ??
            null
        // Mirrors servableLocaleRuns below: non-default locales with a real
        // directory and a URL-safe tag own the pages under their directory.
        const servableModels = localeModels.filter(
            (model) =>
                model !== defaultModel &&
                model.locale !== null &&
                model.directory !== "" &&
                docsLocaleTagSchema.safeParse(model.locale).success,
        )
        // FIRST matching servable locale owns a page — the same rule the
        // real partition applies via ownerOf(...).find(...), so overlapping
        // locale directories can never double-assign a stem here.
        const localeOwnerOf = (stem: string) =>
            servableModels.find(
                (model) =>
                    stem === model.directory ||
                    stem.startsWith(`${model.directory}/`),
            ) ?? null
        const scopes = [
            {
                model: defaultModel,
                files: pageFiles.filter(
                    (file) =>
                        localeOwnerOf(file.path.replace(/\.(mdx|md)$/i, "")) ===
                        null,
                ),
                // A default locale rooted in its own directory still serves
                // UNPREFIXED (strip the directory, no label) — mirrors the
                // default partition below.
                locale:
                    defaultModel && defaultModel.directory !== ""
                        ? { label: null, directory: defaultModel.directory }
                        : null,
            },
            ...servableModels.map((model) => ({
                model,
                files: pageFiles.filter(
                    (file) =>
                        localeOwnerOf(file.path.replace(/\.(mdx|md)$/i, "")) ===
                        model,
                ),
                locale: { label: model.locale, directory: model.directory },
            })),
        ]
        const map = new Map<string, string>()
        for (const scope of scopes) {
            // Version discovery under the scope's own resolved navigation —
            // the same config shape each partitionVersions call sees.
            const scopeNavigation =
                scope.model?.navigation ??
                parsedConfig.config?.navigation ??
                null
            const partitionRoots = partitionRootsFor(
                discoverVersions({
                    pages: scope.files,
                    metas,
                    config: parsedConfig.config
                        ? {
                              ...parsedConfig.config,
                              ...(scopeNavigation
                                  ? {
                                        __resolvedNav:
                                            resolveNavigationModel(
                                                scopeNavigation,
                                            ),
                                    }
                                  : {}),
                          }
                        : null,
                    diagnostics: [],
                }).roots,
                scope.locale,
            )
            for (const file of scope.files) {
                const stem = file.path.replace(/\.(mdx|md)$/i, "")
                const rebased = partitionRebase(
                    file.path,
                    partitionRoots,
                    scope.locale,
                )
                if (rebased) {
                    map.set(stem, rebased.slugs.join("/"))
                    continue
                }
                const explicitlyAuthored = [...explicitReferences].some(
                    (reference) =>
                        stem === reference || stem.startsWith(`${reference}/`),
                )
                map.set(
                    stem,
                    pathToSlugs(file.path, explicitlyAuthored).join("/"),
                )
            }
            // Version homes synthesized later (landingTargets) must resolve
            // too: "." / "./index" from inside a version tree addresses the
            // generated landing even without an authored index.mdx. Authored
            // indexes already claimed their stem above and win.
            for (const root of partitionRoots) {
                const syntheticStem = root.directory
                    ? `${root.directory}/index`
                    : "index"
                if (map.has(syntheticStem)) continue
                const rebased = partitionRebase(
                    `${syntheticStem}.mdx`,
                    partitionRoots,
                    scope.locale,
                )
                if (rebased) map.set(syntheticStem, rebased.slugs.join("/"))
            }
            // Locale-root landings: a version whose directory IS the locale
            // directory normalizes to "" and never appears in partitionRoots
            // — its synthesized home still needs a map
            // entry so "./index" inside the locale resolves. Same for the
            // scope's own root index.
            if (scope.locale) {
                const localeIndexStem = `${scope.locale.directory}/index`
                if (!map.has(localeIndexStem)) {
                    const rebased = partitionRebase(
                        `${localeIndexStem}.mdx`,
                        partitionRoots,
                        scope.locale,
                    )
                    map.set(
                        localeIndexStem,
                        rebased
                            ? rebased.slugs.join("/")
                            : (scope.locale.label ?? ""),
                    )
                }
            }
        }
        // The repository-root landing is synthesized (or redirected) when no
        // index.mdx is authored — "../index" chains must still resolve to /.
        if (!map.has("index")) map.set("index", "")
        return map
    })()
    const knownStems = new Set(servedStemBySourceStem.values())

    // Tenant shiki themes (styling.codeblocks.theme, ) bake into
    // compiled_js here — a theme change needs a re-ingest. Unknown names warn
    // and keep fumadocs' defaults instead of failing every fence.
    const codeThemes = (() => {
        const codeblocks = parsedConfig.config?.styling?.codeblocks
        if (!codeblocks) return null
        if (typeof codeblocks === "string") {
            // docs.json mode string: "dark" forces the dark theme in BOTH
            // color schemes; "system" is the explicit zero-config default.
            if (codeblocks === "dark")
                return { light: "github-dark", dark: "github-dark" }
            if (codeblocks !== "system") {
                parsedConfig.diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `styling.codeblocks "${codeblocks}" is not a known mode ("system" or "dark"); the default themes were used.`,
                    path: "docs.json",
                })
            }
            return null
        }
        const theme = codeblocks.theme
        if (theme === undefined) return null
        const pair =
            typeof theme === "string" ? { light: theme, dark: theme } : theme
        const unknown = [...new Set([pair.light, pair.dark])].filter(
            (name) => !(name in bundledThemes),
        )
        if (unknown.length > 0) {
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `styling.codeblocks.theme names unknown shiki theme(s): ${unknown.join(", ")}; the default themes were used.`,
                path: "docs.json",
            })
            return null
        }
        return pair
    })()

    // docs.json styling.latex — remark-math + rehype-katex join the chain;
    // KaTeX emits static HAST (SSR-safe, zero client JS). The agent
    // markdown keeps the raw $…$ source (remarkLLMs runs before rehype).
    const latexEnabled = parsedConfig.config?.styling?.latex === true

    // Custom TextMate grammars (styling.codeblocks.languages): tenant JSON
    // files load from the snapshot and register as shiki languages. Shape is
    // Zod-gated and size-capped; anything invalid warns and its fences fall
    // back to plaintext like every unknown language.
    const customGrammarShape = z
        .object({
            name: z.string().min(1).max(64),
            scopeName: z.string().min(1).max(255),
            patterns: z.array(z.record(z.string(), z.unknown())),
        })
        .passthrough()
    // z.custom + structural predicate (hastRootSchema precedent): shiki's
    // LanguageRegistration is a deep interface no hand-written schema should
    // duplicate; the predicate gates the shape we rely on.
    const customGrammarSchema = z.custom<LanguageRegistration>(
        (value) => customGrammarShape.safeParse(value).success,
    )
    const customLanguages = await (async () => {
        const codeblocks = parsedConfig.config?.styling?.codeblocks
        if (!codeblocks || typeof codeblocks === "string") return []
        const configured = Array.isArray(codeblocks.languages)
            ? codeblocks.languages
            : (codeblocks.languages?.custom ?? [])
        const grammars: LanguageRegistration[] = []
        for (const rawPath of configured) {
            const path = rawPath.replaceAll("\\", "/").replace(/^\/+/, "")
            const file = textFiles.find((candidate) => candidate.path === path)
            const fail = (reason: string) =>
                parsedConfig.diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `styling.codeblocks.languages "${rawPath}" ${reason}; its fences fall back to plain text.`,
                    path: "docs.json",
                })
            if (!file) {
                fail("was not found in the snapshot")
                continue
            }
            if (file.content.length > 256 * 1024) {
                fail("exceeds the 256KB grammar cap")
                continue
            }
            let parsed: unknown
            try {
                parsed = JSON.parse(file.content)
            } catch {
                fail("is not valid JSON")
                continue
            }
            const grammar = customGrammarSchema.safeParse(parsed)
            if (!grammar.success) {
                fail("is not a TextMate grammar (name/scopeName/patterns)")
                continue
            }
            // Preflight through shiki itself: a structurally-plausible
            // grammar can still fail Oniguruma compilation, and a broken
            // preloaded lang would otherwise reject every page compile.
            try {
                const probe = await createHighlighter({
                    langs: [grammar.data],
                    themes: [],
                })
                probe.dispose()
            } catch {
                fail("failed to load as a shiki grammar")
                continue
            }
            grammars.push(grammar.data)
        }
        return grammars
    })()
    const customLanguageNames = new Set(
        customLanguages.map((grammar) => grammar.name),
    )

    // Shared shiki transformer list for both compiler sites.
    const codeTransformers = [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerAuthoredIcon({ assetHashes }),
        transformerTerminalPrompt(),
        transformerExpandableCode(),
        transformerMetaHighlight(),
        transformerWrapCode(),
        transformerLineNumbers(),
    ]

    // ── Config markdown surfaces (banner.content, errors.404.description) ──
    // Compiled ONCE at ingest through the same chain as page content and
    // stored as HAST in the resolved config — serve only ever renders stored
    // trees, never parses. Failures never reject the snapshot: the surface
    // falls back to plain text with a diagnostic naming why.
    const compileConfigMarkdown = async (input: {
        source: string
        field: string
    }): Promise<HastRoot | null> => {
        const localViolations: DocsViolation[] = []
        const capturedTrees: HastRoot[] = []
        const compiler = createCompiler({
            remarkImageOptions: false,
            remarkHeadingOptions: HEADING_OPTIONS,
            rehypeCodeOptions: {
                ...rehypeCodeDefaultOptions,
                engine: "oniguruma",
                themes: codeThemes ?? MINTLIFY_CODE_THEMES,
                fallbackLanguage: "plaintext",
                ...(customLanguages.length > 0
                    ? { langs: customLanguages }
                    : {}),
                transformers: codeTransformers,
            },
            remarkPlugins: () => [
                // styling.latex covers every compiled markdown surface —
                // banner/404 math must render like page math does.
                ...(latexEnabled ? [remarkMath] : []),
                remarkRewriteAssetReferences({
                    path: "docs.json",
                    assetHashes,
                    allowedHosts,
                    diagnostics: parsedConfig.diagnostics,
                }),
                remarkDocsVariables({
                    variables: parsedConfig.config?.variables ?? {},
                    diagnostics: parsedConfig.diagnostics,
                    path: "docs.json",
                }),
                remarkResolveIconAttributes({
                    path: "docs.json",
                    library: iconLibrary,
                    diagnostics: parsedConfig.diagnostics,
                }),
                remarkDocsAllowList({
                    path: "docs.json",
                    violations: localViolations,
                    diagnostics: parsedConfig.diagnostics,
                }),
                // Config-only compilation lacks Snippet expansion and View
                // grouping. Reject these components here to avoid silently
                // dropping text or rendering an orphan selector at serve time.
                () => (tree: Root) => {
                    visit(tree, (node) => {
                        if (
                            (node.type === "mdxJsxFlowElement" ||
                                node.type === "mdxJsxTextElement") &&
                            (node.name === "Snippet" || node.name === "View")
                        )
                            localViolations.push({
                                path: "docs.json",
                                message: `<${node.name}> is not supported in config markdown`,
                            })
                    })
                },
                // Same root-relative link normalization pages get —
                // "[guide](/guide.mdx)" in a banner must serve /guide.
                remarkRebaseRootLinks({
                    knownStems,
                    servedStemBySourceStem,
                    // Config markdown has no source location — relative
                    // links pass through.
                    sourceDir: null,
                    trailingSlash:
                        parsedConfig.config?.seo?.trailingSlash === true,
                }),
            ],
            rehypePlugins: (v) => [
                // KaTeX first — same ordering rationale as the page
                // compiler (block math parses as a language-math fence).
                ...(latexEnabled ? [rehypeKatex] : []),
                rehypeTableCellCode,
                ...v,
                () => (tree: HastRoot) => {
                    capturedTrees.push(structuredClone(tree))
                },
            ],
        })
        const fail = (reason?: string) => {
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Config field "${input.field}" could not be compiled as markdown${reason ? ` (${reason})` : ""}; it renders as plain text.`,
                path: "docs.json",
            })
            return null
        }
        try {
            await compiler.compile({
                source: preprocessMdxSource(input.source),
                filePath: "docs.json",
                skipRender: true,
            })
        } catch {
            return fail()
        }
        const captured = capturedTrees[0]
        if (!captured || localViolations.length > 0)
            return fail(localViolations[0]?.message)
        const prepared = prepareHastArtifact({
            tree: captured,
            hasJsSnippetBindings: false,
        })
        if (!prepared.ok) return fail()
        return prepared.hast
    }
    if (config.banner?.content) {
        const tree = await compileConfigMarkdown({
            source: config.banner.content,
            field: "banner.content",
        })
        if (tree) {
            // Banners are ONE inline line: the compiled tree must be exactly
            // a single paragraph (whitespace aside) — its children become the
            // stored inline fragment. Anything block-level renders as plain
            // text instead, with the diagnostic naming the rule.
            const meaningful = tree.children.filter(
                (child) =>
                    !(child.type === "text" && child.value.trim() === ""),
            )
            const paragraph = meaningful[0]
            if (
                meaningful.length === 1 &&
                paragraph?.type === "element" &&
                paragraph.tagName === "p"
            ) {
                config.banner = {
                    ...config.banner,
                    contentHast: { type: "root", children: paragraph.children },
                }
            } else {
                parsedConfig.diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message:
                        'Config field "banner.content" supports inline markdown only (links, emphasis, code); block elements render as plain text.',
                    path: "docs.json",
                })
            }
        }
    }
    const errors404 = config.errors?.["404"]
    if (errors404?.description) {
        const tree = await compileConfigMarkdown({
            source: errors404.description,
            field: "errors.404.description",
        })
        if (tree) {
            config.errors = {
                ...config.errors,
                "404": { ...errors404, descriptionHast: tree },
            }
        }
    }

    const snippetTrees = new Map<string, Root>()
    // Raw `export …` blocks lifted out of .mdx snippets (reusable
    // snippets) — compiled through the js-snippet path after this loop so
    // pages can named-import the components they define.
    const snippetExportSources = new Map<string, string>()
    // Static `export const` values per .mdx snippet: substituted into the
    // snippet's own body here and into importing pages (`{ supportEmail }`
    // imported out of the `/snippets/constants.mdx` snippet) at ingest.
    const snippetConstants = new Map<string, Map<string, StaticMdxValue>>()
    for (const file of snippetFiles) {
        let capturedSnippet: Root | null = null
        const constants = new Map<string, StaticMdxValue>()
        snippetConstants.set(file.path, constants)
        const compiler = createCompiler({
            remarkImageOptions: false,
            remarkHeadingOptions: HEADING_OPTIONS,
            rehypeCodeOptions: {
                ...rehypeCodeDefaultOptions,
                // Oniguruma (WASM), not fumadocs' default "js" engine: the JS
                // regex engine fragments trailing `//` comments into stray
                // tokens, which corrupts their colors AND breaks the notation
                // transformers on trailing `// [!code ++]` annotations
                // (consumed without marking the line). Ingest is server-side,
                // so the WASM engine's weight doesn't matter here.
                engine: "oniguruma",
                themes: codeThemes ?? MINTLIFY_CODE_THEMES,
                // Unknown fence languages fall back to plaintext instead
                // of failing the build.
                fallbackLanguage: "plaintext",
                ...(customLanguages.length > 0
                    ? { langs: customLanguages }
                    : {}),
                transformers: codeTransformers,
            },
            remarkPlugins: () => [
                ...(latexEnabled ? [remarkMath] : []),
                remarkRewriteAssetReferences({
                    path: file.path,
                    assetHashes,
                    assetDimensions,
                    allowedHosts,
                    diagnostics: parsedConfig.diagnostics,
                }),
                remarkDocsVariables({
                    variables: parsedConfig.config?.variables ?? {},
                    diagnostics: parsedConfig.diagnostics,
                    path: file.path,
                }),
                // Icon names stay names here: snippet trees inline into
                // pages, whose chain resolves icons AFTER remarkLLMs so the
                // agent markdown keeps `icon="rocket"` and only the HAST
                // carries the SVG.
                remarkExtractSnippetExports({
                    onExports: (source) =>
                        snippetExportSources.set(
                            file.path,
                            `${snippetExportSources.get(file.path) ?? ""}${source}\n`,
                        ),
                    constants,
                }),
                () => (tree: Root) =>
                    substituteStaticBindings({ tree, bindings: constants }),
                remarkDocsAllowList({
                    path: file.path,
                    violations,
                    diagnostics: parsedConfig.diagnostics,
                }),
                () => (tree: Root) => {
                    capturedSnippet = structuredClone(tree)
                },
            ],
        })
        try {
            await compiler.compile({
                source: preprocessMdxSource(file.content),
                filePath: file.path,
                skipRender: true,
            })
            if (capturedSnippet) snippetTrees.set(file.path, capturedSnippet)
        } catch (error) {
            // Rescue retry: strip Markdoc tags only for sources that fail
            // as authored — pages that compile are never touched.
            const rescued = stripMarkdocTags(preprocessMdxSource(file.content))
            if (rescued !== preprocessMdxSource(file.content)) {
                try {
                    await compiler.compile({
                        source: rescued,
                        filePath: file.path,
                        skipRender: true,
                    })
                    if (capturedSnippet)
                        snippetTrees.set(file.path, capturedSnippet)
                    parsedConfig.diagnostics.push({
                        code: "content_suspect",
                        severity: "warn",
                        message:
                            "Markdoc tags ({% … %}) were stripped so the snippet compiles as MDX.",
                        path: file.path,
                    })
                    continue
                } catch {
                    // fall through to the original violation
                }
            }
            violations.push({
                path: file.path,
                message: `MDX compile error: ${error instanceof Error ? error.message : String(error)}`,
            })
        }
    }

    // Precompile every js snippet module BEFORE any page compiles: a module
    // that fails (npm imports, syntax errors) must never bind — pages that
    // import from it skip the binding, so its usages unwrap under the
    // component_unknown policy instead of dereferencing undefined at render.
    for (const [snippetPath, source] of jsSnippetSources) {
        const result = await compileJsSnippet({
            path: snippetPath,
            source,
            resolveSnippet: (path) =>
                jsSnippetSources.get(path) ?? snippetExportSources.get(path),
        })
        if ("error" in result) {
            failedJsSnippets.set(snippetPath, result.error)
            parsedConfig.diagnostics.push({
                code: "js_snippet_rejected",
                severity: "warn",
                message: `Snippet module failed to compile — its usages were dropped: ${result.error}`,
                path: snippetPath,
            })
        } else {
            compiledJsSnippets.set(snippetPath, result)
        }
    }

    // Compile the lifted .mdx snippet export blocks like .jsx snippet
    // modules; pages that named-import from those snippets inline the result.
    const mdxExportModules = new Map<string, CompiledJsSnippet>()
    for (const [snippetPath, source] of snippetExportSources) {
        const result = await compileJsSnippet({
            path: snippetPath,
            source,
            loader: "jsx",
            resolveSnippet: (path) =>
                jsSnippetSources.get(path) ?? snippetExportSources.get(path),
        })
        if ("error" in result) {
            parsedConfig.diagnostics.push({
                code: "js_snippet_rejected",
                severity: "warn",
                message: `Snippet component exports failed to compile: ${result.error}`,
                path: snippetPath,
            })
            continue
        }
        mdxExportModules.set(snippetPath, result)
        compiledJsSnippets.set(mdxSnippetExportsKey(snippetPath), result)
    }

    if (parsedConfig.config?.navigation) {
        parsedConfig.config = {
            ...parsedConfig.config,
            __resolvedNav: resolveNavigationModel(
                parsedConfig.config.navigation,
            ),
        }
    }
    const preliminaryVersions = discoverVersions({
        pages: pageFiles,
        metas,
        config: parsedConfig.config,
        diagnostics: [],
    }).manifest
    // The first page in the navigation is the site home:
    // when a repo has no root index, the root URL redirects there instead of
    // serving a synthesized landing that redirects to an introduction page.
    // The synthesized Overview stays as the fallback for configs whose
    // navigation names no resolvable page (and for version roots below).
    const firstNavPagePath = (() => {
        const existingPagePath = (reference: string): string | null => {
            const stem = reference
                .replaceAll("\\", "/")
                .replace(/^\//, "")
                .replace(/\.(mdx|md)$/i, "")
            if (!stem) return null
            for (const extension of [".mdx", ".md"]) {
                const path = `${stem}${extension}`
                if (pageFiles.some((file) => file.path === path)) return path
            }
            return null
        }
        const fromRefs = (refs: PageRef[] | undefined): string | null => {
            for (const ref of refs ?? []) {
                if (typeof ref === "string") {
                    const path = existingPagePath(ref)
                    if (path) return path
                    continue
                }
                if ("group" in ref && ref.hidden !== true) {
                    const nested = fromRefs(ref.pages)
                    if (nested) return nested
                }
            }
            return null
        }
        // The default language/version renders as home, not the first
        // authored one — mirror the nav compiler's selection.
        const defaultFirst = <Node extends { default?: boolean }>(
            nodes: Node[] | undefined,
        ): Node[] =>
            [...(nodes ?? [])].sort(
                (a, b) =>
                    Number(b.default === true) - Number(a.default === true),
            )
        const fromContainer = (
            container:
                | (ExplicitReferenceContainer & {
                      hidden?: boolean
                      default?: boolean
                  })
                | null
                | undefined,
        ): string | null => {
            // Hidden containers never become the home target — the nav
            // compiler drops their pages via the inherited navigable flag.
            if (!container || container.hidden === true) return null
            const direct = fromRefs(container.pages)
            if (direct) return direct
            for (const group of container.groups ?? []) {
                if (group.hidden === true) continue
                const nested = fromRefs(group.pages)
                if (nested) return nested
            }
            for (const child of [
                ...(container.tabs ?? []),
                ...(container.anchors ?? []),
                ...(container.dropdowns ?? []),
                ...defaultFirst(container.versions),
                ...defaultFirst(container.languages),
                ...(container.products ?? []),
                ...(container.menu ?? []),
            ]) {
                const nested = fromContainer(child)
                if (nested) return nested
            }
            return null
        }
        return fromContainer(parsedConfig.config?.navigation ?? null)
    })()
    const landingTargets = [
        ...(firstNavPagePath ? [] : [{ directory: "", label: null }]),
        ...preliminaryVersions.flatMap((version) =>
            version.directory.length > 0
                ? [{ directory: version.directory, label: version.label }]
                : [],
        ),
    ]
    for (const target of landingTargets) {
        const filesInTarget = pageFiles.filter((file) =>
            target.directory.length === 0
                ? !preliminaryVersions.some(
                      (version) =>
                          version.directory.length > 0 &&
                          file.path.startsWith(`${version.directory}/`),
                  )
                : file.path.startsWith(`${target.directory}/`),
        )
        const indexPath = target.directory
            ? `${target.directory}/index.mdx`
            : "index.mdx"
        if (
            filesInTarget.length === 0 ||
            pageFiles.some((file) => file.path === indexPath)
        )
            continue
        const landingLinks = new Map<string, { title: string; url: string }>()
        for (const file of filesInTarget) {
            const explicitlyAuthored = [...explicitReferences].some(
                (reference) =>
                    file.path.replace(/\.(mdx|md)$/i, "") === reference,
            )
            const relativePath = target.directory
                ? file.path.slice(target.directory.length + 1)
                : file.path
            const slugs = pathToSlugs(relativePath, explicitlyAuthored)
            const first = slugs[0]
            if (!first || landingLinks.has(first)) continue
            landingLinks.set(first, {
                title: humanize(first),
                url: `/${[target.label, ...slugs].filter(Boolean).join("/")}`,
            })
        }
        const links = [...landingLinks.values()]
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((link) => `- [${link.title}](${link.url})`)
            .join("\n")
        // Title/description live in frontmatter, NOT a body H1: DocsTitle
        // renders the title already (a body H1 doubled it), and without a
        // frontmatter description the derivation walked into the link list
        // and made the first link's text the page description.
        pageFiles.push({
            path: indexPath,
            kind: "text",
            content: `---\ntitle: Overview\ndescription: "Explore the documentation."\nhidden: false\nsynthesized: true\n---\n\n${links}\n`,
        })
    }

    for (const file of pageFiles) {
        if (Buffer.byteLength(file.content, "utf8") > MAX_PAGE_BYTES) {
            violations.push({
                path: file.path,
                message: `page exceeds ${MAX_PAGE_BYTES / 1024}KB`,
            })
            continue
        }

        // A `---` block with key: lines past the real frontmatter is almost
        // always a stray frontmatter paste (seen in agent renditions) — in
        // markdown it parses as a thematic break plus a setext heading whose
        // text is the YAML lines, polluting the page and the agent markdown.
        const pastFrontmatter = file.content.replace(
            /^---\r?\n[\s\S]*?\r?\n---\r?\n?/,
            "",
        )
        if (
            /(^|\n)---\r?\n(?:[A-Za-z_][\w-]*:[^\n]*\r?\n)+---(\r?\n|$)/.test(
                pastFrontmatter,
            )
        ) {
            parsedConfig.diagnostics.push({
                code: "content_suspect",
                severity: "warn",
                path: file.path,
                message:
                    "Mid-document '---' block looks like frontmatter; it renders as a horizontal rule plus a heading of the raw key: lines.",
            })
        }

        // Per-file compiler: our remark plugins close over per-file state
        // (violations list, mdast capture), and processor instances memoize
        // their plugin chain.
        const capturedMdasts: Root[] = []
        const capturedHasts: HastRoot[] = []
        // The human rendition stored as docs_page.source (see below).
        let humanSource: string | null = null
        const agentBlockStash = createAgentBlockStash()
        const moduleScopeNames = new Set<string>()
        const jsBindings: JsSnippetBinding[] = []
        const pageLocalExportSources: string[] = []
        const pageLocalExportNames = new Set<string>()
        const pageConstants = new Map<string, StaticMdxValue>()
        const compiler = createCompiler({
            remarkImageOptions: false,
            remarkHeadingOptions: HEADING_OPTIONS,
            rehypeCodeOptions: {
                ...rehypeCodeDefaultOptions,
                // Oniguruma (WASM), not fumadocs' default "js" engine: the JS
                // regex engine fragments trailing `//` comments into stray
                // tokens, which corrupts their colors AND breaks the notation
                // transformers on trailing `// [!code ++]` annotations
                // (consumed without marking the line). Ingest is server-side,
                // so the WASM engine's weight doesn't matter here.
                engine: "oniguruma",
                themes: codeThemes ?? MINTLIFY_CODE_THEMES,
                // Unknown fence languages fall back to plaintext instead
                // of failing the build.
                fallbackLanguage: "plaintext",
                ...(customLanguages.length > 0
                    ? { langs: customLanguages }
                    : {}),
                transformers: codeTransformers,
            },
            remarkPlugins: (v) => [
                ...(latexEnabled ? [remarkMath] : []),
                remarkRewriteAssetReferences({
                    path: file.path,
                    assetHashes,
                    assetDimensions,
                    allowedHosts,
                    diagnostics: parsedConfig.diagnostics,
                }),
                remarkDocsVariables({
                    variables: parsedConfig.config?.variables ?? {},
                    diagnostics: parsedConfig.diagnostics,
                    path: file.path,
                }),
                remarkSnippetImports({
                    path: file.path,
                    snippetTrees,
                    jsSnippetSources,
                    failedJsSnippets,
                    mdxExportModules,
                    mdxSnippetConstants: snippetConstants,
                    violations,
                    diagnostics: parsedConfig.diagnostics,
                    moduleScopeNames,
                    jsBindings,
                }),
                // Page-local component definitions (`export const ThemeCard
                // = …`, as in a theme gallery page) lift out here
                // and compile as a page-local module below, instead of
                // being stripped by the allow-list (which orphaned and then
                // dropped every usage).
                remarkExtractSnippetExports({
                    onExports: (source) => pageLocalExportSources.push(source),
                    moduleScopeNames,
                    exportNames: pageLocalExportNames,
                    constants: pageConstants,
                    deferConstantOnlyBlocks: true,
                }),
                () => (tree: Root) =>
                    substituteStaticBindings({ tree, bindings: pageConstants }),
                // After snippet inlining so transcluded links rebase too
                // (relative snippet links resolve against the INCLUDING
                // page's source directory).
                remarkRebaseRootLinks({
                    knownStems,
                    servedStemBySourceStem,
                    sourceDir: posix.dirname(file.path),
                    trailingSlash:
                        parsedConfig.config?.seo?.trailingSlash === true,
                }),
                // Typography: prose "->" renders as "→". Text nodes
                // only — code fences and inline code are other node types.
                () => (tree: Root) => {
                    visit(tree, "text", (node) => {
                        if (node.value.includes("->"))
                            node.value = node.value.replaceAll("->", "→")
                    })
                },
                // fallbackLanguage silently downgrades unknown fence langs to
                // plaintext — surface which fences that
                // hit so mis-typed languages are findable.
                () => (tree: Root) => {
                    visit(tree, "code", (node) => {
                        if (
                            !node.lang ||
                            node.lang in bundledLanguages ||
                            customLanguageNames.has(node.lang) ||
                            /^(?:te?xt|plaintext|plain)$/i.test(node.lang)
                        )
                            return
                        parsedConfig.diagnostics.push({
                            code: "field_invalid",
                            severity: "info",
                            message: `Unknown code fence language "${node.lang}" was highlighted as plain text.`,
                            path: file.path,
                        })
                    })
                },
                remarkDocsAllowList({
                    path: file.path,
                    violations,
                    diagnostics: parsedConfig.diagnostics,
                    moduleScopeNames,
                }),
                () => (tree: Root) => {
                    visit(tree, (node, index, parent) => {
                        if (
                            (node.type !== "mdxJsxFlowElement" &&
                                node.type !== "mdxJsxTextElement") ||
                            node.name !== "Snippet"
                        )
                            return
                        const fileAttribute = node.attributes.find(
                            (attribute) =>
                                attribute.type === "mdxJsxAttribute" &&
                                attribute.name === "file" &&
                                typeof attribute.value === "string",
                        )
                        const requested =
                            fileAttribute?.type === "mdxJsxAttribute" &&
                            typeof fileAttribute.value === "string"
                                ? fileAttribute.value
                                : null
                        if (!requested) {
                            violations.push({
                                path: file.path,
                                message:
                                    '<Snippet> requires a literal "file" attribute',
                                line: node.position?.start.line,
                            })
                            return
                        }
                        const normalized = requested
                            .replaceAll("\\", "/")
                            .replace(/^\//, "")
                        if (normalized.split("/").includes("..")) {
                            violations.push({
                                path: file.path,
                                message: `snippet path may not traverse directories: ${requested}`,
                                line: node.position?.start.line,
                            })
                            return
                        }
                        const base = normalized.startsWith("snippets/")
                            ? normalized
                            : `snippets/${normalized}`
                        const candidates = /\.(mdx|md)$/i.test(base)
                            ? [base]
                            : [`${base}.mdx`, `${base}.md`]
                        const snippetPath = candidates.find((candidate) =>
                            snippetTrees.has(candidate),
                        )
                        const snippet = snippetPath
                            ? snippetTrees.get(snippetPath)
                            : undefined
                        if (!snippet) {
                            violations.push({
                                path: file.path,
                                message: `missing snippet file: ${requested}`,
                                line: node.position?.start.line,
                            })
                            return
                        }
                        if (
                            typeof index === "number" &&
                            parent &&
                            "children" in parent &&
                            Array.isArray(parent.children)
                        ) {
                            parent.children.splice(
                                index,
                                1,
                                ...structuredClone(snippet.children),
                            )
                        }
                    })
                },
                // The human rendition (docs_page.source): the page as MDX
                // once snippets, snippet props, page constants and docs
                // variables are resolved and links/assets rebased — before
                // any UI-shaping transform. The PDF export reads it, since
                // snippet bodies do not exist at serve time. Stringified with
                // the processor's own syntax extensions (MDX, GFM, math); a
                // node they cannot print keeps the authored source instead.
                function captureHumanSource(
                    this: ThisParameterType<Plugin<[], Root>>,
                ) {
                    const extensions = this.data("toMarkdownExtensions") ?? []
                    return (tree: Root) => {
                        const copy = structuredClone(tree)
                        copy.children = copy.children.filter(
                            (node) => node.type !== "yaml",
                        )
                        // A flow element holding bare phrasing (`<Check>Run
                        // `x` now.</Check>`) would print each inline node as
                        // its own block; wrap the run in one paragraph.
                        visit(copy, "mdxJsxFlowElement", (node) => {
                            if (
                                node.children.length > 0 &&
                                node.children.every((child) => phrasing(child))
                            )
                                node.children = [
                                    {
                                        type: "paragraph",
                                        children: node.children.filter(
                                            (child) => phrasing(child),
                                        ),
                                    },
                                ]
                        })
                        try {
                            humanSource = toMarkdown(copy, { extensions })
                        } catch {
                            // The authored source is stored instead; the
                            // PDF prints it as written (variables and
                            // snippets unresolved), so say so.
                            humanSource = null
                            parsedConfig.diagnostics.push({
                                code: "content_suspect",
                                severity: "warn",
                                message:
                                    "The PDF export uses the authored source for this page: snippets and docs variables print unresolved.",
                                path: file.path,
                            })
                        }
                    }
                },
                remarkAgentBlocks,
                remarkCodeGroupTabs,
                // Empty <Agent> blocks across the default chain so the TOC
                // (remarkHeading) and search index (remarkStructure) only see
                // human-visible content; reattached before remarkLLMs so the
                // agent markdown rendition is built from the whole tree.
                remarkDetachAgentBlocks(agentBlockStash),
                ...v,
                remarkStructure,
                remarkReattachAgentBlocks(agentBlockStash),
                // View grouping AFTER structure/heading (the injected
                // **title** label paragraphs stay out of the search index and
                // TOC) and BEFORE remarkLLMs (the labels shape the stored
                // agent markdown). remarkDocsAllowList already neutralized
                // any authored <ViewGroup> far above, so every group element
                // reaching rehype is synthetic.
                remarkViewGroups({
                    path: file.path,
                    diagnostics: parsedConfig.diagnostics,
                    moduleScopeNames,
                }),
                // Comment-only expressions (`{/* vale off */}`) render
                // nothing: drop them so neither the agent markdown nor the
                // stored HAST carries them (and SSR classification never
                // trips on them). Runs after snippet inlining so transcluded
                // comments vanish too.
                () => (tree: Root) => {
                    visit(tree, (node, index, parent) => {
                        if (
                            (node.type !== "mdxFlowExpression" &&
                                node.type !== "mdxTextExpression") ||
                            !parent ||
                            typeof index !== "number"
                        )
                            return
                        const estree = node.data?.estree
                        if (!estree || estree.body.length > 0) return
                        parent.children.splice(index, 1)
                        return index
                    })
                },
                // Fumadocs 16.17 stringifies authored source. Replace that
                // source with the fully transformed agent tree so snippets,
                // variables and synthetic UI nodes keep their ingest semantics.
                function agentSource(
                    this: ThisParameterType<Plugin<[], Root>>,
                ) {
                    const extensions = this.data("toMarkdownExtensions") ?? []
                    const stringify = (
                        node: Nodes,
                        parent: Parents | undefined,
                        state: Parameters<Handle>[2],
                        info: Parameters<Handle>[3],
                    ): string => {
                        if (
                            node.type !== "mdxJsxFlowElement" &&
                            node.type !== "mdxJsxTextElement"
                        )
                            return ""
                        // Visibility directives (remarkAgentBlocks tags
                        // <Human>/<Agent>/<Visibility> with _stringify)
                        // belong to fumadocs' default handling: drop or
                        // unwrap. Rebuilding them below would lose the
                        // tag and leak human-only text to agents.
                        const visibility = z
                            .union([
                                z.literal("children-only"),
                                z.object({ text: z.string() }),
                            ])
                            .safeParse(
                                node.data
                                    ? Reflect.get(node.data, "_stringify")
                                    : undefined,
                            )
                        if (visibility.success) {
                            if (typeof visibility.data === "object")
                                return visibility.data.text
                            return node.type === "mdxJsxFlowElement"
                                ? state.containerFlow(node, info)
                                : state.containerPhrasing(node, info)
                        }
                        // Serialise with the raw mdx-jsx handler: the
                        // fumadocs default drops boolean attributes
                        // (`value: null`), so ParamField `required` /
                        // `deprecated` vanished. Everything else mirrors
                        // that default: spreads drop, expression values
                        // print as their source text.
                        const serialize = (
                            element: typeof node | MdxJsxTextElement,
                        ) => {
                            const attributes: MdxJsxTextElement["attributes"] =
                                []
                            for (const attribute of element.attributes) {
                                if (
                                    attribute.type ===
                                    "mdxJsxExpressionAttribute"
                                )
                                    continue
                                if (
                                    attribute.value === null ||
                                    attribute.value === undefined
                                ) {
                                    attributes.push(attribute)
                                    continue
                                }
                                const value =
                                    typeof attribute.value === "string"
                                        ? attribute.value
                                        : attribute.value.value
                                if (value)
                                    attributes.push({
                                        type: "mdxJsxAttribute",
                                        name: attribute.name,
                                        value,
                                    })
                            }
                            const handlers = mdxJsxToMarkdown().handlers
                            return element.type === "mdxJsxFlowElement"
                                ? handlers?.mdxJsxFlowElement?.(
                                      { ...element, attributes },
                                      parent,
                                      state,
                                      info,
                                  )
                                : handlers?.mdxJsxTextElement?.(
                                      { ...element, attributes },
                                      parent,
                                      state,
                                      info,
                                  )
                        }
                        if (node.type === "mdxJsxTextElement")
                            return serialize(node) ?? ""
                        if (node.name === "ViewGroup" || node.name === "View")
                            return state.containerFlow(node, info)
                        // remarkCodeTab's generated tab shell is UI
                        // chrome: emit only the fences, carrying the tab
                        // label back as a `title=` (remarkCodeGroupTabs
                        // moved it to `tab=`, which remarkCodeTab
                        // consumed) so ```bash title="curl" reads like
                        // the source and the rest of the meta (icon=,
                        // {1,3}) follows untouched.
                        if (node.name === "CodeBlockTabs") {
                            const fences: RootContent[] = []
                            for (const tab of node.children) {
                                if (
                                    tab.type !== "mdxJsxFlowElement" ||
                                    tab.name !== "CodeBlockTab"
                                )
                                    continue
                                const valueAttribute = tab.attributes.find(
                                    (attribute) =>
                                        attribute.type === "mdxJsxAttribute" &&
                                        attribute.name === "value",
                                )
                                const title =
                                    valueAttribute?.type ===
                                        "mdxJsxAttribute" &&
                                    typeof valueAttribute.value === "string"
                                        ? valueAttribute.value
                                        : null
                                for (const child of tab.children) {
                                    if (
                                        child.type !== "code" ||
                                        title === null
                                    ) {
                                        fences.push(child)
                                        continue
                                    }
                                    fences.push({
                                        ...child,
                                        meta: [
                                            `title="${title.replaceAll('"', "")}"`,
                                            child.meta?.trim() ?? "",
                                        ]
                                            .filter(Boolean)
                                            .join(" "),
                                    })
                                }
                            }
                            return state.containerFlow(
                                { type: "root", children: fences },
                                info,
                            )
                        }
                        // A flow element holding only inline content
                        // (<Tip>verify with `bun --version`.</Tip>) is
                        // serialised as a text element: one line, no
                        // blank-line-separated fragments. A single
                        // paragraph child is unwrapped the same way.
                        const [only] = node.children
                        const inline =
                            node.children.length === 1 &&
                            only?.type === "paragraph"
                                ? only.children
                                : node.children.every((child) =>
                                        phrasing(child),
                                    )
                                  ? node.children.filter((child) =>
                                        phrasing(child),
                                    )
                                  : null
                        if (inline === null || inline.length === 0)
                            return serialize(node) ?? ""
                        return (
                            serialize({
                                type: "mdxJsxTextElement",
                                name: node.name,
                                attributes: node.attributes,
                                children: inline,
                            }) ?? ""
                        )
                    }
                    const transform: ReturnType<Plugin<[], Root>> = (
                        tree,
                        file,
                    ) => {
                        replaceSource(
                            file,
                            tree,
                            toMarkdown(tree, {
                                extensions,
                                handlers: {
                                    mdxJsxFlowElement: stringify,
                                    mdxJsxTextElement: stringify,
                                    mdxjsEsm: () => "",
                                },
                            }),
                        )
                    }
                    return transform
                },
                [
                    remarkLLMs,
                    { _data: true, headingIds: false } satisfies LLMsOptions,
                ],
                // After remarkLLMs: the agent markdown keeps the authored
                // icon NAME while the compiled/HAST render gets the inline
                // SVG (the browser bundle cannot ship the icon dataset).
                remarkResolveIconAttributes({
                    path: file.path,
                    library: iconLibrary,
                    diagnostics: parsedConfig.diagnostics,
                }),
                // Typographic punctuation for the human render only — after
                // remarkLLMs so agent markdown keeps source bytes. Quotes
                // and apostrophes only: hyphen/ellipsis conversion would
                // corrupt CLI flags (--force) in prose.
                [
                    remarkSmartypants,
                    { dashes: false, ellipses: false, backticks: false },
                ],
                // After remarkLLMs so the agent markdown keeps the readable
                // ```mermaid fence while the human render gets <Mermaid>.
                remarkMdxMermaid,
                // Capture the fully-transformed MDAST last — the stored tree
                // is what code-example extraction walks at serve time.
                () => (tree: Root) => {
                    capturedMdasts.push(structuredClone(tree))
                },
            ],
            // rehypeTableCellCode before rehypeCode so the synthesized
            // pre>code gets highlighted; the terminal capture runs after
            // every rehype transform and before rehype-recma, so it sees the
            // exact tree the compiled JS renders — the SSR hast artifact.
            rehypePlugins: (v) => [
                // KaTeX first: block math parses as a language-math fence,
                // which rehypeCode (inside the default chain) would otherwise
                // claim before the math renderer sees it.
                ...(latexEnabled ? [rehypeKatex] : []),
                rehypeTableCellCode,
                ...v,
                () => (tree: HastRoot) => {
                    capturedHasts.push(structuredClone(tree))
                },
                // Compiled JS only (the hast above is already captured):
                // MDX resolves markdown elements through the component map
                // but emits authored lowercase JSX as bare intrinsics, which
                // would skip what the stored-hast path applies (HastBody maps
                // every element): the iframe sandbox, image zoom and loading
                // hints, video playback defaults, and the link href guard.
                // Pipeline-internal names route them through the same
                // components; authors cannot write those names themselves.
                () => (tree: HastRoot) => {
                    const pipelineNames: Record<string, string> = {
                        iframe: "SandboxedIframe",
                        img: "ArticleImage",
                        video: "DocsVideo",
                        a: "SafeLink",
                    }
                    visit(tree, (node) => {
                        if (
                            (node.type === "mdxJsxFlowElement" ||
                                node.type === "mdxJsxTextElement") &&
                            node.name &&
                            Object.hasOwn(pipelineNames, node.name)
                        )
                            node.name = pipelineNames[node.name] ?? node.name
                    })
                },
            ],
        })

        let compiled: Awaited<ReturnType<typeof compiler.compile>> | null = null
        let compileError: unknown = null
        try {
            compiled = await compiler.compile({
                source: preprocessMdxSource(file.content),
                filePath: file.path,
                skipRender: true,
            })
        } catch (error) {
            compileError = error
            // Rescue retry: strip Markdoc tags only for pages that fail as
            // authored (bun's routing.mdx `{% callout %}`) — valid pages
            // carrying `{% %}` in quoted attributes, frontmatter, or code
            // are never touched (review findings on the unconditional pass).
            const rescued = stripMarkdocTags(preprocessMdxSource(file.content))
            if (rescued !== preprocessMdxSource(file.content)) {
                try {
                    capturedMdasts.length = 0
                    capturedHasts.length = 0
                    humanSource = null
                    compiled = await compiler.compile({
                        source: rescued,
                        filePath: file.path,
                        skipRender: true,
                    })
                    parsedConfig.diagnostics.push({
                        code: "content_suspect",
                        severity: "warn",
                        message:
                            "Markdoc tags ({% … %}) were stripped so the page compiles as MDX.",
                        path: file.path,
                    })
                } catch {
                    // fall through to the original violation
                }
            }
        }
        if (compiled === null) {
            violations.push({
                path: file.path,
                message: `MDX compile error: ${compileError instanceof Error ? compileError.message : String(compileError)}`,
            })
            continue
        }

        // Page-local export blocks compile like a .jsx snippet module and
        // bind every named export into the page's component scope. When the
        // tenant's source fails to compile, the usages were already admitted
        // by the allow-list (names registered at lift time) — bind them to a
        // scoped notice so the prose still renders, with this diagnostic
        // naming the cause. A toolchain failure throws
        // SnippetCompilerUnavailableError out of compileDocs instead: the
        // ingest goes red rather than persisting broken pages.
        let compiledJs = compiled.compiled
        if (pageLocalExportSources.length > 0) {
            const localKey = `${file.path}::locals`
            const compiledLocal = await compileJsSnippet({
                path: file.path,
                source: pageLocalExportSources.join("\n"),
                loader: "jsx",
                resolveSnippet: (path) =>
                    jsSnippetSources.get(path) ??
                    snippetExportSources.get(path),
            })
            let localModule: CompiledJsSnippet
            if ("error" in compiledLocal) {
                const message = `Page-local component exports failed to compile — their usages render as an error notice: ${compiledLocal.error}`
                parsedConfig.diagnostics.push({
                    code: "js_snippet_rejected",
                    severity: "warn",
                    message,
                    path: file.path,
                })
                localModule = failedModuleFallback({
                    names: pageLocalExportNames,
                    message: "This component failed to compile.",
                })
            } else {
                localModule = compiledLocal
            }
            compiledJsSnippets.set(localKey, localModule)
            for (const name of localModule.exportedNames) {
                jsBindings.push({
                    localName: name,
                    importedName: name,
                    snippetPath: localKey,
                })
            }
        }

        // Inline imported js/jsx snippet components into this page's
        // client-executed JS. Modules were precompiled above; a failed module
        // never produced a binding, so everything here resolves.
        if (jsBindings.length > 0) {
            const inlined = inlineJsSnippets({
                compiledJs,
                bindings: jsBindings,
                modules: compiledJsSnippets,
            })
            if (typeof inlined !== "string") {
                violations.push({ path: file.path, message: inlined.error })
                continue
            }
            compiledJs = inlined
        }

        let frontmatterCandidate = compiled.frontmatter
        if (
            "ogImage" in frontmatterCandidate &&
            typeof frontmatterCandidate.ogImage === "string" &&
            !isAllowedUrl(frontmatterCandidate.ogImage)
        ) {
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    'Invalid frontmatter field "ogImage" was dropped; the generated Open Graph image will be used.',
                path: file.path,
            })
            frontmatterCandidate = Object.fromEntries(
                Object.entries(frontmatterCandidate).filter(
                    ([key]) => key !== "ogImage",
                ),
            )
        }
        let frontmatter = docsFrontmatterSchema.safeParse(frontmatterCandidate)
        while (!frontmatter.success) {
            const invalidKey = frontmatter.error.issues.find(
                (issue) => typeof issue.path[0] === "string",
            )?.path[0]
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    typeof invalidKey === "string"
                        ? `Invalid frontmatter field "${invalidKey}" was dropped; using the derived default.`
                        : "Invalid frontmatter was dropped; using derived defaults.",
                path: file.path,
            })
            frontmatterCandidate =
                typeof invalidKey === "string"
                    ? Object.fromEntries(
                          Object.entries(frontmatterCandidate).filter(
                              ([key]) => key !== invalidKey,
                          ),
                      )
                    : {}
            frontmatter = docsFrontmatterSchema.safeParse(frontmatterCandidate)
        }
        let pageFrontmatter = frontmatter.data
        if (
            pageFrontmatter.provenance !== undefined &&
            !parsedConfig.config?.[CONFIG_EXTENSION_KEY]?.seo?.provenance
        ) {
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Frontmatter "provenance" requires ${CONFIG_EXTENSION_KEY}.seo.provenance; no upstream relationship was inferred.`,
                path: file.path,
            })
            pageFrontmatter = Object.fromEntries(
                Object.entries(pageFrontmatter).filter(
                    ([key]) => key !== "provenance",
                ),
            )
        }

        // Page-level contextual overrides REPLACE the global config at serve,
        // so their custom-option images need the same asset hashing and
        // external-host admission the global options get — otherwise a page
        // can smuggle an unadmitted src/icon straight to the renderer.
        const contextualOverride = pageFrontmatter.contextual
        if (
            contextualOverride?.options?.some(
                (option) => typeof option !== "string",
            )
        ) {
            pageFrontmatter = {
                ...pageFrontmatter,
                contextual: {
                    ...contextualOverride,
                    options: contextualOverride.options.map((option, index) => {
                        if (typeof option === "string") return option
                        const next = { ...option }
                        if (typeof next.src === "string") {
                            next.src =
                                rewriteConfigValue(
                                    next.src,
                                    `contextual.options[${index}].src`,
                                    file.path,
                                ) ?? undefined
                        }
                        if (typeof next.icon === "string") {
                            next.icon = rewriteIconValue(
                                next.icon,
                                `contextual.options[${index}].icon`,
                                file.path,
                            )
                        }
                        return next
                    }),
                },
            }
        }

        const data = compiled.vfile.data
        let processedMarkdown =
            typeof data.markdown === "string" ? data.markdown : null
        // The .md rendition quotes the frontmatter description under
        // the title; the framework prepends `# Title (/url)` at serve time
        // (agent-content.ts getLLMText), so the quote leads the body — or
        // follows an authored H1 when the page opens with one.
        if (
            processedMarkdown !== null &&
            typeof pageFrontmatter.description === "string" &&
            pageFrontmatter.description.trim() !== ""
        ) {
            const quote = `> ${pageFrontmatter.description.trim().replace(/\s*\n\s*/g, " ")}`
            const authoredH1 = /^# [^\n]*\n/.exec(processedMarkdown)
            processedMarkdown = authoredH1
                ? `${authoredH1[0]}\n${quote}\n${processedMarkdown.slice(authoredH1[0].length)}`
                : `${quote}\n\n${processedMarkdown}`
        }
        const structuredData = data.structuredData
        const capturedMdast = capturedMdasts[0]
        const capturedHast = capturedHasts[0]
        if (
            !capturedMdast ||
            !capturedHast ||
            processedMarkdown === null ||
            !structuredData
        ) {
            violations.push({
                path: file.path,
                message: "compile produced incomplete artifacts",
            })
            continue
        }

        // Tailwind candidates from the rendered tree: hast `className`
        // arrays and lowercase-JSX `className`/`class` attributes (strings or
        // static expressions — string arrays included). Dynamic expressions
        // are left to the source-text pass below; such a page falls back to
        // the JS path anyway.
        visit(capturedHast, (node) => {
            const carrier = classCarrierSchema.safeParse(node)
            if (!carrier.success) return
            for (const token of carrier.data.properties?.className ?? [])
                if (typeof token === "string") collectUtilityTokens(token)
            for (const raw of carrier.data.attributes ?? []) {
                const attribute = classAttributeSchema.safeParse(raw)
                if (!attribute.success) continue
                if (typeof attribute.data.value === "string") {
                    collectUtilityTokens(attribute.data.value)
                    continue
                }
                const statement = attribute.data.value.data?.estree?.body[0]
                const evaluated =
                    statement?.type === "ExpressionStatement"
                        ? evaluateStaticMdxExpression(statement.expression)
                        : { ok: false as const }
                if (!evaluated.ok) continue
                const values = Array.isArray(evaluated.value)
                    ? evaluated.value
                    : [evaluated.value]
                for (const value of values)
                    if (typeof value === "string") collectUtilityTokens(value)
            }
        })

        // SSR classification: a pure-data tree is stored as hast and rendered
        // server-side; anything executable keeps the client-only compiled-JS
        // path. The captured clone is owned here — prepareHastArtifact scrubs
        // it in place.
        const preparedHast = prepareHastArtifact({
            tree: capturedHast,
            hasJsSnippetBindings:
                jsBindings.length > 0 || pageLocalExportSources.length > 0,
        })
        if (!preparedHast.ok) {
            ssrFallbacks[preparedHast.fallback] =
                (ssrFallbacks[preparedHast.fallback] ?? 0) + 1
            parsedConfig.diagnostics.push({
                code: "ssr_fallback",
                severity: "info",
                message: `Page renders client-side instead of from stored HAST: ${preparedHast.fallback}.`,
                path: file.path,
            })
        }

        // Class strings the tree cannot show: page-local component bodies
        // (compiled as a module, never in the HAST) and, on JS-path pages,
        // conditional/template `className` expressions in the page source.
        if (pageLocalExportSources.length > 0)
            collectUtilityLiterals(pageLocalExportSources.join("\n"))
        if (!preparedHast.ok) collectUtilityLiterals(file.content)

        const pageStem = file.path.replace(/\.(mdx|md)$/i, "")
        const explicitlyAuthored = [...explicitReferences].some(
            (reference) =>
                pageStem === reference || pageStem.startsWith(`${reference}/`),
        )
        const slugs = pathToSlugs(file.path, explicitlyAuthored)
        // Title and excerpt must come from HUMAN-visible prose: the captured
        // mdast still contains <Agent> subtrees (hidden in the human render),
        // and a list item's content is a paragraph in mdast — a page opening
        // with a link list would otherwise get its first bullet as the
        // description shown in the page header and every prev/next card.
        const h1Text: string[] = []
        let foundH1 = false
        const agentOnlyNode = (node: {
            type: string
            name?: string | null
            attributes?: Array<{
                type: string
                name?: string
                value?: unknown
            }>
        }): boolean =>
            (node.type === "mdxJsxFlowElement" ||
                node.type === "mdxJsxTextElement") &&
            (node.name === "Agent" ||
                (node.name === "Visibility" &&
                    (node.attributes ?? []).some(
                        (attribute) =>
                            attribute.type === "mdxJsxAttribute" &&
                            attribute.name === "for" &&
                            attribute.value === "agents",
                    )))
        visitParents(capturedMdast, "heading", (node, ancestors) => {
            if (foundH1 || node.depth !== 1) return
            if (
                ancestors.some(
                    (ancestor) =>
                        // Variant-specific headings must not become the
                        // page title/SEO — same rule as the excerpt pass.
                        (ancestor.type === "mdxJsxFlowElement" &&
                            ancestor.name === "ViewGroup") ||
                        agentOnlyNode(ancestor),
                )
            )
                return
            // Descendants need the same skip as ancestors: an inline
            // <Visibility for="agents"> nested inside a human heading or
            // paragraph must not leak into titles/excerpts/search/SEO.
            const parts: string[] = []
            visit(node, (child) => {
                if (agentOnlyNode(child)) return SKIP
                if (child.type === "text" || child.type === "inlineCode")
                    parts.push(child.value)
                if (child.type === "image" && child.alt) parts.push(child.alt)
                if (
                    child.type === "break" ||
                    (child.type === "mdxJsxTextElement" && child.name === "br")
                )
                    parts.push(" ")
                return
            })
            // Only human-visible text claims the slot — a candidate whose
            // entire content is agent-only falls through to the next one.
            if (parts.length === 0) return
            foundH1 = true
            h1Text.push(...parts)
        })
        const paragraphText: string[] = []
        let foundParagraph = false
        visitParents(capturedMdast, "paragraph", (node, ancestors) => {
            if (foundParagraph) return
            if (
                ancestors.some(
                    (ancestor) =>
                        ancestor.type === "listItem" ||
                        // ViewGroup content is variant-specific and includes
                        // the synthetic **label** paragraphs — neither may
                        // become the derived page description.
                        (ancestor.type === "mdxJsxFlowElement" &&
                            ancestor.name === "ViewGroup") ||
                        agentOnlyNode(ancestor),
                )
            )
                return
            const parts: string[] = []
            visit(node, (child) => {
                if (agentOnlyNode(child)) return SKIP
                if (child.type === "text" || child.type === "inlineCode")
                    parts.push(child.value)
                if (child.type === "image" && child.alt) parts.push(child.alt)
                if (
                    child.type === "break" ||
                    (child.type === "mdxJsxTextElement" && child.name === "br")
                )
                    parts.push(" ")
                return
            })
            if (parts.length === 0) return
            foundParagraph = true
            paragraphText.push(...parts)
        })
        // Derived excerpts are meta/search-only (the framework renders a
        // subtitle only for authored frontmatter descriptions), but they still
        // reach crawlers — cut at a sentence boundary where one exists and
        // mark harder cuts with an ellipsis instead of stopping mid-sentence.
        // Text nodes carry their own spacing: joining with "" keeps
        // "minutes, bandwidth" from becoming "minutes , bandwidth" where
        // inline markup (`code`, **bold**) split the text.
        const rawExcerpt = paragraphText.join("").replace(/\s+/g, " ").trim()
        let excerpt = rawExcerpt
        if (excerpt.length > 160) {
            const head = excerpt.slice(0, 161)
            const sentence = Math.max(
                head.lastIndexOf(". "),
                head.lastIndexOf("! "),
                head.lastIndexOf("? "),
            )
            if (sentence > 40) {
                excerpt = excerpt.slice(0, sentence + 1)
            } else {
                const word = head.lastIndexOf(" ")
                excerpt = `${excerpt.slice(0, word > 0 ? word : 160).trim()}…`
            }
        }
        const pathSegments = pageStem.split("/").filter(Boolean)
        const filename = pathSegments.at(-1) ?? "index"
        const parent = [...pathSegments]
            .slice(0, -1)
            .reverse()
            .find((segment) => !/^\(.+\)$/.test(segment))
        const fallbackTitle =
            filename.toLowerCase() === "index"
                ? parent
                    ? humanize(parent)
                    : "Overview"
                : humanize(filename)
        const headingTitle = h1Text.join("").replace(/\s+/g, " ").trim()
        const resolvedTitle =
            pageFrontmatter.title ?? (headingTitle || fallbackTitle)
        // Headings inside <View> alternatives stay OUT of the "On this page"
        // rail: every view but the selected one renders under `hidden`, so a
        // rail link into an inactive alternative cannot scroll anywhere
        // The headings keep their ids — in-page anchors
        // still work while their view is active — and search is untouched.
        const viewHeadingIds = new Set<string>()
        visitParents(capturedMdast, "heading", (node, ancestors) => {
            if (
                !ancestors.some(
                    (ancestor) =>
                        ancestor.type === "mdxJsxFlowElement" &&
                        ancestor.name === "View",
                )
            )
                return
            const id = node.data?.hProperties?.id
            if (typeof id === "string") viewHeadingIds.add(id)
        })
        pages.push({
            kind: "mdx",
            path: file.path,
            url: slugs.length ? `/${slugs.join("/")}` : "/",
            slugs,
            title: resolvedTitle.slice(0, 255),
            description: pageFrontmatter.description ?? (excerpt || null),
            // Asset-shaped frontmatter icons (for example, /images/icons/client.svg)
            // hash to /_assets URLs; names stay stored as names.
            icon:
                rewriteIconValue(
                    pageFrontmatter.icon,
                    "frontmatter icon",
                    file.path,
                ) ?? null,
            hidden: pageFrontmatter.hidden === true,
            frontmatter: pageFrontmatter,
            source: humanSource ?? file.content,
            compiledJs: preparedHast.ok ? null : compiledJs,
            hast: preparedHast.ok ? preparedHast.hast : null,
            railHast: preparedHast.ok ? splitPageRail(preparedHast.hast) : null,
            processedMarkdown,
            agentMarkdown: agentRenditionByStem.get(pageStem) ?? null,
            mdast: capturedMdast,
            codeExamples: extractCodeExamplesFromMdast(capturedMdast),
            updates: extractUpdatesFromMdast(capturedMdast),
            structuredData,
            // DocsTitle already renders the page H1 — a depth-1 TOC entry
            // duplicates it in the "On this page" rail. View-contained
            // headings are alternatives (viewHeadingIds above) — out too.
            toc: (compiled.toc ?? []).filter(
                (item) =>
                    item.depth > 1 && !viewHeadingIds.has(item.url.slice(1)),
            ),
            openapiProps: null,
        })
    }

    // Authored operation-reference pages (frontmatter `openapi:` —
    // generated API pages must not become empty MDX-only shells):
    // parse the refs up front so the referenced specs register as documents,
    // then attach the resolved operation to each page after the OpenAPI
    // compile below.
    const frontmatterOpenapiRefs = pages.flatMap((page) => {
        if (page.kind !== "mdx") return []
        const rawRef = page.frontmatter.openapi
        if (typeof rawRef !== "string") return []
        const ref = parseOpenapiFrontmatterRef(rawRef)
        if (!ref) {
            parsedConfig.diagnostics.push({
                code: "openapi_ref_unresolved",
                severity: "warn",
                message: `Unparseable frontmatter openapi reference "${rawRef}" — the page renders without its API console.`,
                path: page.path,
            })
            return []
        }
        return [{ page, ref }]
    })
    const frontmatterSpecPaths = new Set(
        frontmatterOpenapiRefs.flatMap(({ ref }) =>
            ref.specPath !== null ? [ref.specPath] : [],
        ),
    )

    // OpenAPI reference sections — synthesized pages/metas join the same
    // collision and link checks below so a spec can never shadow an authored
    // page (or vice versa) silently.
    const openapi = await compileOpenapiDocs(
        textFiles,
        parsedConfig.config,
        preliminaryVersions,
        frontmatterSpecPaths,
        parsedConfig.diagnostics,
        violations,
    )
    pages.push(...openapi.pages)

    // Attach each resolved operation to its authored page — openapiProps
    // rides ALONGSIDE the compiled MDX body (the served page renders the
    // authored prose plus the API console). `api`/`deprecated` are stamped
    // into frontmatter only where the author left them unset, so the sidebar
    // badge plumbing works unchanged; the wide layout is derived at serving
    // from the console's presence, never stamped.
    const bareResolvedDocIds = new Set<string>()
    for (const { page, ref } of frontmatterOpenapiRefs) {
        const resolved = resolveFrontmatterOpenapiRef(
            openapi.documents,
            ref,
            page.path,
            parsedConfig.config?.markdown?.schema !== false,
        )
        if (resolved.ok && ref.specPath === null)
            bareResolvedDocIds.add(resolved.docId)
        if (!resolved.ok) {
            parsedConfig.diagnostics.push({
                code: "openapi_ref_unresolved",
                severity: "warn",
                message: `Frontmatter openapi reference could not be resolved (${resolved.reason}) — the page renders without its API console.`,
                path: page.path,
            })
            continue
        }
        if (resolved.ambiguousAmong) {
            parsedConfig.diagnostics.push({
                code: "openapi_ref_unresolved",
                severity: "warn",
                message: `Frontmatter openapi reference matches ${resolved.ambiguousAmong.length} specs (${resolved.ambiguousAmong.join(", ")}); resolved to the first alphabetically — add a spec path to disambiguate.`,
                path: page.path,
            })
        }
        page.openapiProps = resolved.props
        // The operation's own description shows under the title (and as
        // the meta description) when the page frontmatter has none.
        const hasAuthoredDescription =
            typeof page.frontmatter.description === "string" &&
            page.frontmatter.description.trim() !== ""
        if (!hasAuthoredDescription && resolved.description) {
            page.description = resolved.description
        }
        page.frontmatter = {
            ...page.frontmatter,
            ...(!hasAuthoredDescription && resolved.description
                ? { description: resolved.description }
                : {}),
            api:
                typeof page.frontmatter.api === "string"
                    ? page.frontmatter.api
                    : resolved.api,
            ...(resolved.deprecated && page.frontmatter.deprecated === undefined
                ? { deprecated: true }
                : {}),
        }
        page.processedMarkdown = `${page.processedMarkdown.trimEnd()}\n\n${resolved.detailMarkdown}`
    }

    // A BARE ref (no spec path) resolving into a convention-discovered spec
    // makes the authored pages that spec's canonical routes — drop the
    // convention-generated section or every operation serves at two routes
    // (review finding). Explicit config/nav registrations keep their
    // generated routes (the author asked for a generated section), and the
    // document row itself always stays — the authored pages reference it.
    const suppressedDocs = openapi.documents.filter(
        (doc) =>
            doc.origin === "convention" && bareResolvedDocIds.has(doc.docId),
    )
    const suppressedRouteDocIds = new Set(
        suppressedDocs.map((doc) => doc.docId),
    )
    if (suppressedDocs.length > 0) {
        for (let i = pages.length - 1; i >= 0; i--) {
            const page = pages[i]
            if (
                page?.kind === "openapi" &&
                page.openapiProps !== null &&
                suppressedRouteDocIds.has(page.openapiProps.document)
            )
                pages.splice(i, 1)
        }
        // openapi.metas haven't merged into `metas` yet — prune in place.
        for (let i = openapi.metas.length - 1; i >= 0; i--) {
            const meta = openapi.metas[i]
            if (
                meta &&
                suppressedDocs.some(
                    (doc) =>
                        meta.path === `${doc.basePath}/meta.json` ||
                        meta.path.startsWith(`${doc.basePath}/`),
                )
            )
                openapi.metas.splice(i, 1)
        }
    }

    const metaPaths = new Set(metas.map((m) => m.path))
    for (const meta of openapi.metas) {
        if (metaPaths.has(meta.path)) {
            violations.push({
                path: meta.path,
                message: `meta collision: an authored meta.json occupies the generated OpenAPI folder "${meta.path}"`,
            })
        } else {
            metaPaths.add(meta.path)
            metas.push(meta)
        }
    }
    // An authored meta.json with an explicit `pages` list hides unlisted
    // children — for every ancestor folder of a generated section (root
    // included, e.g. reference/meta.json above reference/payments), append
    // the next path segment so the convention stays zero-config. (No meta /
    // no `pages` → fumadocs shows every folder; "..." → the rest operator
    // covers it.)
    const metaByPath = new Map(metas.map((m) => [m.path, m]))
    for (const doc of openapi.documents) {
        // Suppressed sections (bare-ref canonical routes) mint no folder —
        // don't wire them into ancestor metas either.
        if (suppressedRouteDocIds.has(doc.docId)) continue
        const segments = doc.basePath.split("/").filter(Boolean)
        for (let depth = 0; depth < segments.length; depth++) {
            const metaPath =
                depth === 0
                    ? "meta.json"
                    : `${segments.slice(0, depth).join("/")}/meta.json`
            const meta = metaByPath.get(metaPath)
            if (!meta || !Array.isArray(meta.data.pages)) continue
            const metaPages = meta.data.pages.filter(
                (p): p is string => typeof p === "string",
            )
            const segment = segments[depth]
            if (
                !segment ||
                metaPages.includes("...") ||
                metaPages.includes(segment)
            )
                continue
            meta.data = { ...meta.data, pages: [...metaPages, segment] }
        }
    }

    // Version markers (the config extension version keys) are read from the
    // AUTHORED meta.json rows: the §5.2 default cascade puts the meta marker
    // first even when a navigation block supersedes metas for tree structure.
    const authoredMetas = metas.map((meta) => ({
        ...meta,
        data: { ...meta.data },
    }))
    // ── Locale enumeration (Phase A) ───────────────────────────────────
    // Every navigation.languages[] locale compiles: the default serves
    // unprefixed (exactly the single-language behavior) and non-default
    // locales serve under /<locale>/. Configs without a languages block get
    // one default model, so there is exactly one code path.
    const configNavigation =
        parsedConfig.navSource === "config"
            ? (parsedConfig.config?.navigation ?? null)
            : null
    const localeModels = configNavigation
        ? enumerateLocales(configNavigation)
        : []
    const localeRuns = localeModels.map((model) => ({
        model,
        result: compileNavigation({
            navigation: model.navigation,
            pages,
            openapiDocuments: openapi.documents,
            existingMetas: metas,
        }),
    }))
    const defaultRun =
        localeRuns.find((run) => run.model.default) ?? localeRuns[0] ?? null
    const navigation =
        defaultRun?.result ??
        compileNavigation({
            navigation: null,
            pages,
            openapiDocuments: openapi.documents,
            existingMetas: metas,
        })
    parsedConfig.diagnostics.push(...navigation.diagnostics)
    // Non-default locale runs re-diagnose config-level issues; keep only
    // what is scoped inside the locale's own directory.
    for (const run of localeRuns) {
        if (run === defaultRun) continue
        if (run.model.directory === "") {
            parsedConfig.diagnostics.push({
                code: "locale_unpartitioned",
                severity: "warn",
                message: `Locale "${run.model.locale ?? "?"}" has no derivable content directory; it is skipped from locale serving.`,
                path: "docs.json",
            })
            continue
        }
        parsedConfig.diagnostics.push(
            ...run.result.diagnostics.filter((diagnostic) =>
                diagnostic.path?.startsWith(`${run.model.directory}/`),
            ),
        )
    }
    // Merged-tree metas: the default locale's rows plus each locale's rows
    // inside its own directory (locale runs win there).
    const combinedMetaByPath = new Map(
        navigation.metas.map((meta) => [meta.path, meta]),
    )
    for (const run of localeRuns) {
        if (run === defaultRun || run.model.directory === "") continue
        for (const meta of run.result.metas) {
            if (
                meta.path === `${run.model.directory}/meta.json` ||
                meta.path.startsWith(`${run.model.directory}/`)
            )
                combinedMetaByPath.set(meta.path, meta)
        }
    }
    metas.splice(
        0,
        metas.length,
        ...[...combinedMetaByPath.values()].sort((a, b) =>
            a.path.localeCompare(b.path),
        ),
    )
    // Sidebar/nav icons stay stored as names (the serve side resolves them
    // through the shared Hugeicons map) — validate them here so authors learn
    // about unknown names at build time, not from a silent default glyph.
    // Asset-shaped values (hashed /_assets URLs, allow-listed https) render
    // as images and are exempt from name validation.
    for (const page of pages) {
        if (
            page.icon &&
            !iconIsAssetShaped(page.icon) &&
            !resolveDocsIconSvg(page.icon)
        ) {
            parsedConfig.diagnostics.push({
                code: "icon_unresolved",
                severity: "warn",
                message: `Frontmatter icon "${page.icon}" is not a known ${iconLibrary} icon name; the default glyph will render.`,
                path: page.path,
            })
        }
    }
    for (const meta of metas) {
        const icon = meta.data.icon
        if (
            typeof icon === "string" &&
            icon &&
            !iconIsAssetShaped(icon) &&
            !resolveDocsIconSvg(icon)
        ) {
            parsedConfig.diagnostics.push({
                code: "icon_unresolved",
                severity: "warn",
                message: `Navigation icon "${icon}" is not a known ${iconLibrary} icon name; the default glyph will render.`,
                path: meta.path,
            })
        }
    }
    // A page is hidden only when NO locale's navigation references it, and
    // searchable when ANY locale marks it so.
    const allRuns =
        localeRuns.length > 0
            ? localeRuns.map((run) => run.result)
            : [navigation]
    for (const page of pages)
        page.hidden = allRuns.every((run) => run.hiddenPaths.has(page.path))
    for (const page of pages) {
        page.frontmatter = {
            ...page.frontmatter,
            searchable: allRuns.some((run) =>
                run.searchablePaths.has(page.path),
            ),
        }
    }

    // ── Locale page ownership + per-locale version partitioning ─────────
    // Non-default locales own the pages under their directory (the
    // docs.json convention: es/…); the default locale owns the rest.
    const servableLocaleRuns = localeRuns.filter((run) => {
        if (run === defaultRun || run.model.locale === null) return false
        // The tag doubles as the leading URL segment: reject anything that
        // is not BCP-47-shaped/segment-safe at INGEST (the same schema
        // parses the stored manifest, so nothing persisted can throw at
        // serve time — review finding).
        if (!docsLocaleTagSchema.safeParse(run.model.locale).success) {
            parsedConfig.diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Locale tag "${run.model.locale}" is not a valid URL-safe language tag; the locale is skipped from locale serving.`,
                path: "docs.json",
            })
            return false
        }
        return run.model.directory !== ""
    })
    const ownerOf = (
        page: CompiledDocsPage,
    ): (typeof localeRuns)[number] | null => {
        const stem = page.path.replace(/\.(mdx|md)$/i, "")
        return (
            servableLocaleRuns.find(
                (run) =>
                    stem === run.model.directory ||
                    stem.startsWith(`${run.model.directory}/`),
            ) ?? null
        )
    }
    const defaultPages: CompiledDocsPage[] = []
    const localePageSets = new Map<string, CompiledDocsPage[]>()
    for (const page of pages) {
        const owner = ownerOf(page)
        if (owner?.model.locale) {
            const set = localePageSets.get(owner.model.locale) ?? []
            set.push(page)
            localePageSets.set(owner.model.locale, set)
        } else defaultPages.push(page)
    }

    const stampNav = (
        resolvedNav: ResolvedNavigation,
        tabPages: ReturnType<typeof compileNavigation>["tabPages"],
        servedUrlByPath: Map<string, string>,
    ): ResolvedNavigation => {
        // Stamp each top-level tab with its compiled page membership (exact
        // paths + landing URL) so the serve side can scope the sidebar and
        // pick the active tab without directory heuristics — and re-derive
        // the landing href from POST-partition servedUrl (pre-partition
        // page.url 404s once product versioning moves the page).
        // Applied to navigation.tabs AND navigation.global.tabs — the band
        // renders both — each against its own membership map and by
        // position, so tabs sharing a label (across or within a list) keep
        // their own pages.
        const stampTab = (
            tab: TabNode,
            scope: "tabs" | "global",
            index: number,
        ): TabNode => {
            const membership = tabPages[scope].get(index)
            if (!membership) return tab
            const first = membership.pages[0]
            const served =
                first !== undefined ? servedUrlByPath.get(first) : undefined
            return {
                ...tab,
                ...(membership.hidden ? { hidden: true } : {}),
                resolvedPages: membership.pages,
                resolvedGroups: membership.groups,
                ...(served !== undefined
                    ? { resolvedHref: served }
                    : membership.href
                      ? { resolvedHref: membership.href }
                      : {}),
                // Header dropdown items land on their first page's
                // post-partition URL, like the tab itself.
                ...(tab.menu
                    ? {
                          menu: tab.menu.map((item, index) => {
                              const itemMembership = membership.menu[index]
                              const first = itemMembership?.pages[0]
                              const itemServed =
                                  first !== undefined
                                      ? servedUrlByPath.get(first)
                                      : undefined
                              return {
                                  ...item,
                                  ...(itemServed !== undefined
                                      ? { resolvedHref: itemServed }
                                      : {}),
                                  ...(itemMembership
                                      ? {
                                            resolvedPages: itemMembership.pages,
                                            resolvedGroups:
                                                itemMembership.groups,
                                        }
                                      : {}),
                              }
                          }),
                      }
                    : {}),
            }
        }
        return {
            ...resolvedNav,
            tabs: resolvedNav.tabs.map((tab, index) =>
                stampTab(tab, "tabs", index),
            ),
            ...(resolvedNav.global?.tabs
                ? {
                      global: {
                          ...resolvedNav.global,
                          tabs: resolvedNav.global.tabs.map((tab, index) =>
                              stampTab(tab, "global", index),
                          ),
                      },
                  }
                : {}),
        }
    }

    // Default-locale partition: identical to the historical single-language
    // flow (its manifest and stamped nav populate the legacy columns).
    const defaultResolvedNav =
        configNavigation && defaultRun
            ? resolveNavigationModel(defaultRun.model.navigation)
            : null
    if (defaultResolvedNav && parsedConfig.config) {
        parsedConfig.config = {
            ...parsedConfig.config,
            __resolvedNav: defaultResolvedNav,
        }
    }
    const defaultPartition = partitionVersions({
        pages: defaultPages,
        metas: authoredMetas,
        config: parsedConfig.config,
        diagnostics: parsedConfig.diagnostics,
        // A default locale rooted in its own directory (languages[en] with
        // en/… content) still serves UNPREFIXED: strip the directory, keep
        // localeLabel null — otherwise the advertised default routes never
        // exist and locale alternates 404 (review finding).
        locale:
            defaultRun && defaultRun.model.directory !== ""
                ? { label: null, directory: defaultRun.model.directory }
                : null,
    })
    parsedConfig.diagnostics.splice(
        0,
        parsedConfig.diagnostics.length,
        ...defaultPartition.diagnostics,
    )

    interface LocaleCompilation {
        locale: string | null
        hidden: boolean
        directory: string
        manifest: VersionsManifest
        pages: VersionedCompiledDocsPage[]
        nav: ResolvedNavigation | null
    }
    const compilations: LocaleCompilation[] = []
    {
        const servedUrlByPath = new Map(
            defaultPartition.pages.map((page) => [page.path, page.servedUrl]),
        )
        const stamped =
            defaultResolvedNav && defaultRun
                ? stampNav(
                      defaultResolvedNav,
                      defaultRun.result.tabPages,
                      servedUrlByPath,
                  )
                : null
        if (stamped && parsedConfig.config) {
            parsedConfig.config = {
                ...parsedConfig.config,
                __resolvedNav: stamped,
            }
        }
        compilations.push({
            locale: defaultRun?.model.locale ?? null,
            hidden: false,
            directory: defaultRun?.model.directory ?? "",
            manifest: defaultPartition.manifest,
            pages: defaultPartition.pages,
            nav: stamped,
        })
    }
    for (const run of servableLocaleRuns) {
        const locale = run.model.locale
        if (!locale) continue
        const resolvedNav = resolveNavigationModel(run.model.navigation)
        // Locale tags share the leading URL segment with version labels;
        // the locale wins at resolution time — surface the shadowing.
        if (
            defaultPartition.manifest.some(
                (entry) => entry.label === locale && !entry.nested,
            )
        ) {
            parsedConfig.diagnostics.push({
                code: "locale_shadowed",
                severity: "warn",
                message: `Locale "${locale}" shares its URL prefix with a product version label; the locale wins at request resolution.`,
                path: "docs.json",
            })
        }
        const partition = partitionVersions({
            pages: localePageSets.get(locale) ?? [],
            metas: authoredMetas,
            config: parsedConfig.config
                ? { ...parsedConfig.config, __resolvedNav: resolvedNav }
                : null,
            diagnostics: [],
            locale: { label: locale, directory: run.model.directory },
        })
        parsedConfig.diagnostics.push(...partition.diagnostics)
        const servedUrlByPath = new Map(
            partition.pages.map((page) => [page.path, page.servedUrl]),
        )
        compilations.push({
            locale,
            hidden: run.model.hidden,
            directory: run.model.directory,
            manifest: partition.manifest,
            pages: partition.pages,
            nav: stampNav(resolvedNav, run.result.tabPages, servedUrlByPath),
        })
    }
    const partitioned = {
        pages: compilations.flatMap((compilation) => compilation.pages),
        manifest: defaultPartition.manifest,
    }
    const localesManifest: LocalesManifest =
        localeModels.length > 0 && localeModels[0]?.locale
            ? compilations.flatMap((compilation) =>
                  compilation.locale === null || compilation.nav === null
                      ? []
                      : [
                            {
                                locale: compilation.locale,
                                default: compilation === compilations[0],
                                ...(compilation.hidden ? { hidden: true } : {}),
                                directory: compilation.directory,
                                nav: compilation.nav,
                                versionsManifest: compilation.manifest,
                            },
                        ],
              )
            : []

    // ── Per-locale page caps, collisions, and link validation ───────────
    const globalServedUrls = new Set(
        partitioned.pages.map((page) => page.servedUrl),
    )
    for (const compilation of compilations) {
        const scope = compilation.locale
            ? ` [locale ${compilation.locale}]`
            : ""
        const internalVersions = compilation.manifest.filter(
            (version) => version.directory.length > 0,
        )
        const pageCountTrees =
            internalVersions.length > 0
                ? internalVersions.map((version) => ({
                      label: version.label,
                      pages: compilation.pages.filter(
                          (page) =>
                              page.versionLabel === null ||
                              page.versionLabel === version.label,
                      ),
                  }))
                : [{ label: "unversioned", pages: compilation.pages }]
        for (const tree of pageCountTrees) {
            if (tree.pages.length <= MAX_PAGES_PER_VERSION) continue
            violations.push({
                path: "",
                message: `too many pages in version "${tree.label}"${scope}: ${tree.pages.length} (limit ${MAX_PAGES_PER_VERSION})`,
            })
        }
        const collisionTrees =
            internalVersions.length > 0
                ? internalVersions.map((version) => ({
                      label: version.label,
                      pages: compilation.pages.filter(
                          (page) =>
                              page.versionLabel === null ||
                              page.versionLabel === version.label,
                      ),
                  }))
                : [{ label: null, pages: compilation.pages }]
        for (const tree of collisionTrees) {
            const byServedUrl = new Map<string, string>()
            for (const page of tree.pages) {
                const other = byServedUrl.get(page.servedUrl)
                if (other) {
                    violations.push({
                        path: page.path,
                        message: `route collision: ${page.path} and ${other} both serve ${page.servedUrl}${tree.label ? ` in version ${tree.label}` : ""}${scope}`,
                    })
                } else {
                    byServedUrl.set(page.servedUrl, page.path)
                }
            }
        }

        if (violations.length > 0) continue
        const defaultVersion = internalVersions.find(
            (version) => version.default,
        )
        const defaultKnownUrls = new Set([
            ...(defaultVersion
                ? compilation.pages
                      .filter(
                          (page) =>
                              page.versionLabel === null ||
                              page.versionLabel === defaultVersion.label,
                      )
                      .map((page) => page.servedUrl)
                : compilation.pages.map((page) => page.servedUrl)),
            // Cross-locale (and cross-tree) links resolve globally — a link
            // out of the authoring locale is navigable, not broken.
            ...globalServedUrls,
        ])
        const versionLabels = new Set(
            internalVersions.map((version) => version.label),
        )
        const linkTrees =
            internalVersions.length > 0
                ? internalVersions.map((version) => ({
                      label: version.label,
                      pages: compilation.pages.filter(
                          (page) => page.versionLabel === version.label,
                      ),
                  }))
                : [{ label: null, pages: compilation.pages }]
        // Broken internal links warn instead of failing the build — real
        // docs ship some (bun's own docs carry a few), and blocking every
        // deploy on link rot would reject otherwise-valid content.
        const linkWarnings: DocsViolation[] = []
        for (const tree of linkTrees) {
            const knownUrls = new Set([
                ...compilation.pages
                    .filter((page) => page.versionLabel === null)
                    .map((page) => page.servedUrl),
                ...tree.pages.map((page) => page.servedUrl),
                ...globalServedUrls,
            ])
            linkWarnings.push(
                ...validateInternalLinks({
                    pages: tree.pages.flatMap((page) =>
                        page.mdast
                            ? [
                                  {
                                      path: page.path,
                                      url: page.servedUrl,
                                      links: collectLinks(page.mdast),
                                  },
                              ]
                            : [],
                    ),
                    knownUrls,
                    fallbackKnownUrls: defaultKnownUrls,
                    resolveFallbackTarget: (target) => {
                        if (!defaultVersion) return target
                        const suffix = target.slice(DOCS_ROUTE.length)
                        const segments = suffix.split("/").filter(Boolean)
                        const leading = segments[0]
                        if (tree.label && leading === tree.label) {
                            return [
                                DOCS_ROUTE,
                                defaultVersion.label,
                                ...segments.slice(1),
                            ].join("/")
                        }
                        if (leading && versionLabels.has(leading)) return target
                        return [
                            DOCS_ROUTE,
                            defaultVersion.label,
                            ...segments,
                        ].join("/")
                    },
                }),
            )
        }
        if (internalVersions.length > 0) {
            const sharedPages = compilation.pages.filter(
                (page) => page.versionLabel === null,
            )
            linkWarnings.push(
                ...validateInternalLinks({
                    pages: sharedPages.flatMap((page) =>
                        page.mdast
                            ? [
                                  {
                                      path: page.path,
                                      url: page.servedUrl,
                                      links: collectLinks(page.mdast),
                                  },
                              ]
                            : [],
                    ),
                    knownUrls: defaultKnownUrls,
                    fallbackKnownUrls: defaultKnownUrls,
                    resolveFallbackTarget: (target) => {
                        if (!defaultVersion) return target
                        const suffix = target.slice(DOCS_ROUTE.length)
                        const segments = suffix.split("/").filter(Boolean)
                        const leading = segments[0]
                        if (leading && versionLabels.has(leading)) return target
                        return [
                            DOCS_ROUTE,
                            defaultVersion.label,
                            ...segments,
                        ].join("/")
                    },
                }),
            )
        }
        for (const warning of linkWarnings) {
            parsedConfig.diagnostics.push({
                code: "link_broken",
                severity: "warn",
                message: warning.message,
                path: warning.path,
            })
        }
    }

    if (violations.length > 0) return { ok: false, violations }
    const resolvedLayout = resolveLayoutPreset(parsedConfig.config?.theme)
    if (resolvedLayout.diagnostic)
        parsedConfig.diagnostics.push(resolvedLayout.diagnostic)
    const configuredCss = parsedConfig.config?.[CONFIG_EXTENSION_KEY]?.css
    const orderedCssFiles = [...cssFiles].sort((a, b) =>
        a.path.localeCompare(b.path),
    )
    if (configuredCss !== null && configuredCss !== undefined) {
        for (const configuredPath of typeof configuredCss === "string"
            ? [configuredCss]
            : configuredCss) {
            const file = cssFiles.find(
                (candidate) => candidate.path === configuredPath,
            )
            if (file) orderedCssFiles.push(file)
            else
                parsedConfig.diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `Configured CSS file "${configuredPath}" was not found and was skipped.`,
                    path: "docs.json",
                })
        }
    }
    const sanitizedCss = await sanitizeCss(
        configuredCss === null ? [] : orderedCssFiles,
        allowedHosts,
        assetHashes,
        true,
    )
    parsedConfig.diagnostics.push(...sanitizedCss.diagnostics)
    // docs.json `fonts` roles carry their own font file (source/format) —
    // emit their @font-face rules, ahead of tenant CSS.
    const fontFaces: string[] = []
    const configFonts = parsedConfig.config?.fonts
    const selfHostedFamilies = new Set<string>()
    const fontRoles = [
        configFonts,
        configFonts?.heading,
        configFonts?.body,
        configFonts?.mono,
    ]
    for (const face of fontRoles) {
        if (!face?.family || !face.source || !isAllowedUrl(face.source))
            continue
        const format = face.format ?? "woff2"
        const weight = face.weight ?? "100 900"
        selfHostedFamilies.add(face.family)
        fontFaces.push(
            `@font-face { font-family: ${JSON.stringify(face.family)}; src: url(${JSON.stringify(face.source)}) format(${JSON.stringify(format)}); font-weight: ${weight}; font-display: swap; }`,
        )
    }
    // Resolve bare Google font families and inline @font-face rules into the
    // version's theme CSS. Unknown names keep their system fallback and warn;
    // generic families are never fetched.
    const NON_GOOGLE_FAMILIES = new Set([
        "sans-serif",
        "serif",
        "monospace",
        "system-ui",
        "ui-sans-serif",
        "ui-serif",
        "ui-monospace",
        "sfmono-regular",
        "menlo",
        "monaco",
        "consolas",
        "courier new",
        "arial",
        "helvetica",
        "helvetica neue",
        "georgia",
        "times new roman",
        "intervariable",
        "geistmono",
    ])
    const googleFamilies = new Map<string, number | undefined>()
    for (const face of fontRoles) {
        if (!face?.family || face.source) continue
        // A stack like `"IBM Plex Sans", sans-serif` names its webfont first.
        const family = (face.family.split(",")[0] ?? "")
            .trim()
            .replace(/^['"]|['"]$/g, "")
        if (
            !family ||
            !/^[A-Za-z0-9 -]+$/.test(family) ||
            NON_GOOGLE_FAMILIES.has(family.toLowerCase()) ||
            selfHostedFamilies.has(family) ||
            googleFamilies.has(family)
        )
            continue
        googleFamilies.set(family, face.weight)
    }
    // Configured families and tenant-CSS `@import
    // url(https://fonts.googleapis.com/...)` rules (sanitizeCss lifts them
    // out — an inline <style> ignores mid-sheet @imports anyway) become
    // INPUTS, not fetches: the caller resolves them through
    // fonts.ts/resolveFontCss AFTER compile, keeping compileDocs a pure
    // function of the content tree. Imports are capped so a hostile 256KB
    // stylesheet full of cache-busted URLs cannot pin the resolver.
    const importUrls = [...new Set(sanitizedCss.fontImports)]
    if (importUrls.length > MAX_FONT_IMPORTS) {
        parsedConfig.diagnostics.push({
            code: "css_sanitized",
            severity: "warn",
            message: `Only the first ${MAX_FONT_IMPORTS} Google Fonts @imports were resolved; ${importUrls.length - MAX_FONT_IMPORTS} more were removed.`,
            path: "css",
        })
    }
    const fontInputs: DocsFontInputs = {
        families: [...googleFamilies].map(([family, weight]) => ({
            family,
            ...(weight === undefined ? {} : { weight }),
        })),
        imports: importUrls.slice(0, MAX_FONT_IMPORTS),
    }
    // js/jsx snippet modules are compiled separately (never in a HAST), so
    // their class strings join the candidates here, then the version's
    // utilities compile once. Loaded lazily INSIDE the try like lightningcss:
    // a missing package degrades to a diagnostic, never a poisoned module.
    for (const source of jsSnippetSources.values())
        collectUtilityLiterals(source)
    if (utilityCandidatesOverflowed)
        parsedConfig.diagnostics.push({
            code: "css_sanitized",
            severity: "warn",
            message: `Only the first ${MAX_UTILITY_CANDIDATES} distinct Tailwind class candidates were compiled.`,
            path: "tailwind",
        })
    let utilityCss = ""
    if (utilityCandidates.size > 0) {
        try {
            const { compile } = await import("tailwindcss")
            const require = createRequire(import.meta.url)
            const compiled = await compile(TAILWIND_UTILITY_SOURCE, {
                base: dirname(require.resolve("tailwindcss/theme.css")),
                loadStylesheet: async (id) => {
                    if (
                        id !== "tailwindcss/theme.css" &&
                        id !== "tailwindcss/utilities.css"
                    )
                        throw new Error(`unexpected stylesheet import ${id}`)
                    const path = require.resolve(id)
                    return {
                        path,
                        base: dirname(path),
                        content: await readFile(path, "utf8"),
                    }
                },
            })
            // Sorted candidates → deterministic output across re-ingests.
            const built = compiled.build([...utilityCandidates].sort())
            // Scope every rule to the article (:where keeps specificity):
            // tenant content re-declares base utilities the chrome pairs
            // with responsive variants (`flex` vs the mobile header's
            // `md:hidden`), and a later same-layer `.flex` would win on
            // every chrome element sharing the class name. Framework
            // elements outside #nd-page / the pinned rail never match now.
            const { transform } = await import("lightningcss")
            utilityCss = new TextDecoder().decode(
                transform({
                    filename: "tenant-utilities.css",
                    code: Buffer.from(built),
                    minify: false,
                    // Selector hook, not Rule.style: returning a whole rule
                    // makes lightningcss re-deserialize its declarations,
                    // and Tailwind's `--tw-*` property polyfills do not
                    // round-trip through the JS AST.
                    visitor: {
                        // biome-ignore lint/correctness/noComponentHookFactories: a Lightning CSS visitor, not a component.
                        Selector: (selector) => [
                            {
                                type: "pseudo-class",
                                kind: "where",
                                selectors: [
                                    [{ type: "id", name: "nd-page" }],
                                    [{ type: "attribute", name: "data-rail" }],
                                ],
                            },
                            { type: "combinator", value: "descendant" },
                            ...selector,
                        ],
                    },
                }).code,
            )
            if (/<\/style/i.test(utilityCss))
                throw new Error("generated CSS contains a </style> sequence")
            const bytes = Buffer.byteLength(utilityCss)
            if (bytes > MAX_UTILITY_CSS_BYTES) {
                parsedConfig.diagnostics.push({
                    code: "css_oversize",
                    severity: "warn",
                    message: `Tailwind utility CSS skipped: ${Math.ceil(bytes / 1024)}KB exceeds the ${MAX_UTILITY_CSS_BYTES / 1024}KB cap.`,
                    path: "tailwind",
                })
                utilityCss = ""
            }
        } catch (error) {
            parsedConfig.diagnostics.push({
                code: "css_sanitized",
                severity: "warn",
                message: `Tailwind utilities skipped: ${error instanceof Error ? error.message : String(error)}`,
                path: "tailwind",
            })
            utilityCss = ""
        }
    }
    // Utilities BEFORE the authored CSS: both are tenant-derived, and the
    // string order is the whole cascade contract (layered utilities, then
    // the unlayered authored rules that may override them).
    const themeCss = [...new Set(fontFaces), utilityCss, sanitizedCss.css]
        .filter(Boolean)
        .join("\n")
    const explicitPrimaryExists =
        parsedConfig.config?.colors !== undefined ||
        parsedConfig.config?.[CONFIG_EXTENSION_KEY]?.tokens?.primary !==
            undefined ||
        /--color-fd-primary\s*:/.test(sanitizedCss.css)
    const detectedAccent =
        !explicitPrimaryExists && lightLogoAsset?.bytes
            ? await deriveAccent(lightLogoAsset.bytes)
            : null
    const themeTokens = resolveThemeTokens(
        parsedConfig.config,
        resolvedLayout.preset,
        detectedAccent ?? undefined,
        parsedConfig.diagnostics,
    )
    // No authored root page → "/" redirects to the first navigation page
    // (docs.json home semantics). Validated WITH the authored set so authored
    // redirects targeting "/" stay reachable; an authored "/" source keeps
    // precedence (the synthetic one is skipped entirely).
    const rootRedirectDestination = (() => {
        if (!firstNavPagePath) return null
        if (partitioned.pages.some((page) => page.servedUrl === "/"))
            return null
        const authored = parsedConfig.config?.redirects ?? []
        const authoredRoot = authored.some((redirect) => {
            const slashed = redirect.source.startsWith("/")
                ? redirect.source
                : `/${redirect.source}`
            return slashed === "/" || slashed.replace(/\/+$/, "") === ""
        })
        if (authoredRoot) return null
        const destination = partitioned.pages.find(
            (page) => page.path === firstNavPagePath,
        )?.servedUrl
        return destination && destination !== "/" ? destination : null
    })()
    const deploymentConfig = resolveDeploymentConfig({
        config: parsedConfig.config,
        servedUrls: partitioned.pages.map((page) => page.servedUrl),
        diagnostics: parsedConfig.diagnostics,
        ...(rootRedirectDestination
            ? {
                  syntheticRedirects: [
                      { source: "/", destination: rootRedirectDestination },
                  ],
              }
            : {}),
    })
    const skills = discoverDocsSkills(textFiles)
    parsedConfig.diagnostics.push(...skills.diagnostics)
    return {
        ok: true,
        pages: partitioned.pages,
        metas,
        openapiDocuments: openapi.documents,
        skills: skills.skills,
        assets,
        cssFiles,
        config: parsedConfig.config,
        diagnostics: parsedConfig.diagnostics,
        navSource: navigation.navSource,
        themeTokens,
        themeCss,
        fontInputs,
        ssrFallbacks,
        layoutPreset: resolvedLayout.preset,
        versionsManifest: partitioned.manifest,
        localesManifest,
        redirects: deploymentConfig.redirects,
        seo: deploymentConfig.seo,
        integrations: deploymentConfig.integrations,
    }
}
