import { z } from "zod"
import type {
    AnchorNode,
    Diagnostic,
    DocsConfigSuperset,
    DropdownNode,
    GlobalNode,
    LanguageNode,
    MenuItemNode,
    PageRef,
    ProductNode,
    TabNode,
    VersionNode,
    VersionsManifest,
} from "../types/docs"
import {
    CONFIG_EXTENSION_KEY,
    CONFIG_EXTENSION_VERSION_DEFAULT_KEY,
    CONFIG_EXTENSION_VERSION_KEY,
} from "../types/docs"
import type { CompiledDocsMeta, CompiledDocsPage } from "./compile"

/**
 * Docs serve at the site root. Keep this constant outside compile.ts to
 * avoid a bundler import cycle that could leave it in the temporal dead zone.
 */
export const DOCS_ROUTE = ""

export function pathToSlugs(
    path: string,
    preserveAuthoredGroups = false,
): string[] {
    const slugs = path
        .replace(/\.(mdx|md)$/i, "")
        .split("/")
        .filter(
            (segment) =>
                Boolean(segment) &&
                (preserveAuthoredGroups || !/^\(.+\)$/.test(segment)),
        )
    if (slugs.at(-1) === "index") slugs.pop()
    return slugs
}

export type { VersionsManifest } from "../types/docs"

export type VersionedCompiledDocsPage = CompiledDocsPage & {
    versionLabel: string | null
    /** navigation.languages locale tag; null = the default locale. */
    localeLabel: string | null
    servedUrl: string
}

interface VersionRoot {
    label: string
    directory: string
    href?: string
    configDefault: boolean
    metaDefault: boolean
    /** Declared inside a titled navigation container — see VersionsManifest. */
    nested: boolean
    /** docs.json version.hidden — routable but absent from the switcher. */
    hidden: boolean
    /** docs.json version.tag — a badge beside the switcher entry. */
    tag?: string
    seq: number
}

interface VersionContainer {
    versions?: VersionNode[]
    languages?: LanguageNode[]
    tabs?: TabNode[]
    anchors?: AnchorNode[]
    dropdowns?: DropdownNode[]
    products?: ProductNode[]
    menu?: MenuItemNode[]
    global?: GlobalNode | null
}

const VERSION_DIRECTORY_PATTERN = /^(?:v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/i

function normalizeDirectory(value: string): string {
    return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
}

function naturalCompare(left: string, right: string): number {
    return left.localeCompare(right, undefined, { numeric: true })
}

/**
 * Locale-normalized, longest-directory-first partition roots — the subset of
 * discovered roots that actually re-base URLs. Exported for compile-time
 * link rebasing (servedStemBySourceStem) so both sides partition
 * identically.
 */
export function partitionRootsFor(
    roots: readonly VersionRoot[],
    locale: { label: string | null; directory: string } | null,
): VersionRoot[] {
    return (
        roots
            // A version whose derived directory IS the locale directory spans
            // the locale's whole tree — the locale-root analogue of a
            // repo-root version. It must not partition
            // /es into /es/v2.
            .map((root) => ({
                ...root,
                directory:
                    locale && root.directory === locale.directory
                        ? ""
                        : root.directory,
            }))
            .filter((root) => root.directory.length > 0)
            .sort(
                (left, right) => right.directory.length - left.directory.length,
            )
    )
}

/**
 * Re-based served slugs for one source path, or null when nothing re-bases
 * it (no locale scope, no containing version root) — the caller keeps its
 * own pathToSlugs-derived URL, which preserves authored groups. The single
 * source of truth for partitionVersions AND compile-time link rebasing, so
 * emitted body links and persisted servedUrls cannot drift.
 */
export function partitionRebase(
    path: string,
    partitionRoots: readonly VersionRoot[],
    locale: { label: string | null; directory: string } | null,
): { slugs: string[]; versionLabel: string | null } | null {
    const stem = path.replace(/\.(mdx|md)$/i, "")
    const within = (directory: string) =>
        stem === directory || stem.startsWith(`${directory}/`)
    const localePrefix = locale?.label ? [locale.label] : []
    const root = partitionRoots.find((candidate) => within(candidate.directory))
    if (root) {
        return {
            slugs: [
                ...localePrefix,
                root.label,
                ...pathToSlugs(path.slice(root.directory.length + 1)),
            ],
            versionLabel: root.label,
        }
    }
    if (!locale) return null
    const relativePath =
        locale.directory.length > 0 && within(locale.directory)
            ? path.slice(locale.directory.length + 1)
            : path
    return {
        slugs: [...localePrefix, ...pathToSlugs(relativePath)],
        versionLabel: null,
    }
}

function topLevelDirectories(input: {
    pages: Array<{ path: string }>
    metas: CompiledDocsMeta[]
}): Set<string> {
    const directories = new Set<string>()
    for (const path of [
        ...input.pages.map((page) => page.path),
        ...input.metas.map((meta) => meta.path),
    ]) {
        const first = normalizeDirectory(path).split("/")[0]
        if (first && path.includes("/")) directories.add(first)
    }
    return directories
}

export function discoverVersions(input: {
    pages: Array<{ path: string }>
    metas: CompiledDocsMeta[]
    config: DocsConfigSuperset | null
    diagnostics: Diagnostic[]
}): {
    roots: VersionRoot[]
    manifest: VersionsManifest
    diagnostics: Diagnostic[]
} {
    const diagnostics = [...input.diagnostics]
    const directories = topLevelDirectories(input)
    const containerChildren = new Set<string>()
    for (const path of [
        ...input.pages.map((page) => page.path),
        ...input.metas.map((meta) => meta.path),
    ]) {
        const segments = normalizeDirectory(path).split("/").filter(Boolean)
        if (segments[0] === "versions" && segments[1])
            containerChildren.add(segments[1])
    }

    const roots: VersionRoot[] = []
    const claimedDirectories = new Set<string>()
    const claimedLabels = new Set<string>()
    const addRoot = (root: Omit<VersionRoot, "seq">): void => {
        if (
            (root.directory.length > 0 &&
                claimedDirectories.has(root.directory)) ||
            claimedLabels.has(root.label)
        )
            return
        roots.push({ ...root, seq: roots.length })
        if (root.directory.length > 0) claimedDirectories.add(root.directory)
        claimedLabels.add(root.label)
    }

    const configVersions: { node: VersionNode; context: string | null }[] = []
    const navigationStack: {
        container: VersionContainer
        context: string | null
    }[] = input.config?.__resolvedNav
        ? [{ container: input.config.__resolvedNav, context: null }]
        : []
    // Function-scoped, never module scope: the workflow step bundler's __esm
    // wrapper marks a module initialized BEFORE running its body, so a throw
    // in a sibling import's init (e.g. a native module failing to load) left
    // module consts here permanently undefined on warm retries while the
    // hoisted functions stay callable across cyclic module initialization.
    const nonEmpty = z
        .string()
        .min(1)
        .optional()
        .catch(() => undefined)
    const containerTitleSchema = z.object({
        dropdown: nonEmpty,
        anchor: nonEmpty,
        tab: nonEmpty,
        product: nonEmpty,
        language: nonEmpty,
        // MenuItemNode's discriminant — menu entries are version containers too.
        item: nonEmpty,
    })
    const contextOf = (
        child: VersionContainer,
        inherited: string | null,
    ): string | null => {
        const titled = containerTitleSchema.safeParse(child)
        if (!titled.success) return inherited
        return (
            titled.data.dropdown ??
            titled.data.anchor ??
            titled.data.tab ??
            titled.data.product ??
            titled.data.language ??
            titled.data.item ??
            inherited
        )
    }
    while (navigationStack.length > 0) {
        const frame = navigationStack.pop()
        if (!frame) continue
        const { container, context } = frame
        configVersions.push(
            ...(container.versions ?? []).map((node) => ({ node, context })),
        )
        const children: VersionContainer[] = [
            ...(container.versions ?? []),
            ...(container.languages ?? []),
            ...(container.tabs ?? []),
            // SDK versions may be nested under
            // anchors[].dropdowns[].versions[] — anchors are containers too.
            ...(container.anchors ?? []),
            ...(container.dropdowns ?? []),
            ...(container.products ?? []),
            ...(container.menu ?? []),
            ...(container.global ? [container.global] : []),
        ]
        navigationStack.push(
            ...children.map((child) => ({
                container: child,
                context: contextOf(child, context),
            })),
        )
    }
    for (const { node, context } of configVersions) {
        const directory = configDirectoryForNode(
            node,
            directories,
            containerChildren,
        )
        // Version labels are scoped to their switcher in docs.json — JS
        // and Python SDK dropdowns both carry a "v2.11.1". Our version model
        // is flat, so a colliding label is qualified with its container's
        // slug ("sdk-javascript-v2.11.1"); labels double as URL segments, so
        // the qualifier must be URL-safe.
        let label = node.version
        if (claimedLabels.has(label) && context) {
            const qualifier = context
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
            if (qualifier) label = `${qualifier}-${node.version}`
        }
        // A top-level config version with no derivable directory (one whose
        // v2 spans the repo root) still registers with directory "" so it
        // exists in the manifest, can carry the default flag, and simply does
        // not partition — its content serves unprefixed. Nested versions
        // still require a directory or href: a
        // degenerate nested node must not pollute the manifest or the
        // default cascade.
        if (directory === null && !node.href && context !== null) continue
        addRoot({
            label,
            directory: directory ?? "",
            ...(node.href ? { href: node.href } : {}),
            configDefault: node.default === true,
            metaDefault: false,
            nested: context !== null,
            hidden: node.hidden === true,
            ...(node.tag ? { tag: node.tag } : {}),
        })
    }

    const markerMetas = input.metas.flatMap((meta) => {
        const match = /^((?:versions\/)?[^/]+)\/meta\.json$/i.exec(meta.path)
        const label = meta.data[CONFIG_EXTENSION_VERSION_KEY]
        const isDefault =
            meta.data[CONFIG_EXTENSION_VERSION_DEFAULT_KEY] === true
        if (!match?.[1] || (typeof label !== "string" && !isDefault)) return []
        const directory = normalizeDirectory(match[1])
        return [
            {
                directory,
                label:
                    typeof label === "string"
                        ? label
                        : (directory.split("/").at(-1) ?? directory),
                isDefault,
            },
        ]
    })
    for (const marker of markerMetas) {
        const claimed = roots.find(
            (root) => root.directory === marker.directory,
        )
        if (claimed) {
            claimed.metaDefault ||= marker.isDefault
            continue
        }
        addRoot({
            label: marker.label,
            directory: marker.directory,
            configDefault: false,
            metaDefault: marker.isDefault,
            nested: false,
            hidden: false,
        })
    }

    for (const label of [...containerChildren].sort(naturalCompare)) {
        addRoot({
            label,
            directory: `versions/${label}`,
            configDefault: false,
            metaDefault: false,
            nested: false,
            hidden: false,
        })
    }

    // Filesystem sibling detection is a zero-config heuristic. When the
    // config declares ANY version nodes it is authoritative — stray
    // undeclared version-shaped folders (such as v0/ or v1/) must not mint
    // roots the author never declared (the audit's v1/v0-switcher failure).
    // Explicit forms (versions/ container, meta markers) still register.
    if (configVersions.length === 0) {
        const siblingCandidates = [...directories]
            .filter((directory) => VERSION_DIRECTORY_PATTERN.test(directory))
            .sort(naturalCompare)
        const hasSiblingEvidence =
            directories.has("versions") || siblingCandidates.length > 1
        for (const directory of siblingCandidates) {
            if (claimedDirectories.has(directory)) continue
            if (hasSiblingEvidence) {
                addRoot({
                    label: directory,
                    directory,
                    configDefault: false,
                    metaDefault: false,
                    nested: false,
                    hidden: false,
                })
            } else {
                diagnostics.push({
                    code: "version_ambiguous",
                    severity: "info",
                    message: `The lone root folder "${directory}" looks version-like but remains an ordinary group; use versions/${directory}/ or explicit navigation.versions configuration to declare it.`,
                    path: directory,
                })
            }
        }
    }

    const metaDefaults = roots.filter((root) => root.metaDefault)
    const configDefaults = roots.filter((root) => root.configDefault)
    const extensionDefault =
        input.config?.[CONFIG_EXTENSION_KEY]?.versions?.default
    let flagged: VersionRoot[] = []
    if (metaDefaults.length > 0) flagged = metaDefaults
    else if (configDefaults.length > 0) flagged = configDefaults
    else if (extensionDefault) {
        const match = roots.find((root) => root.label === extensionDefault)
        if (match) flagged = [match]
    }

    const defaultRoot = [...(flagged.length > 0 ? flagged : roots)].sort(
        (left, right) => naturalCompare(right.label, left.label),
    )[0]
    if (roots.length > 0 && flagged.length === 0 && defaultRoot) {
        diagnostics.push({
            code: "version_no_default",
            severity: "info",
            message: `No product version was marked default; inferred "${defaultRoot.label}" by natural version order.`,
        })
    }
    if (flagged.length > 1 && defaultRoot) {
        diagnostics.push({
            code: "version_multiple_default",
            severity: "warn",
            message: `Multiple product versions were marked default; "${defaultRoot.label}" wins by natural version order.`,
        })
    }

    return {
        roots,
        manifest: roots.map((root) => ({
            label: root.label,
            directory: root.directory,
            default: root === defaultRoot,
            seq: root.seq,
            ...(root.href ? { href: root.href } : {}),
            ...(root.nested ? { nested: true } : {}),
            ...(root.hidden ? { hidden: true } : {}),
            ...(root.tag ? { tag: root.tag } : {}),
        })),
        diagnostics,
    }
}

function leafPagePaths(refs: readonly PageRef[] | undefined): string[] {
    const paths: string[] = []
    for (const ref of refs ?? []) {
        if (typeof ref === "string") {
            // External URLs and endpoint refs ("GET /users") are not repo
            // paths and must not enter directory derivation.
            if (!/^https?:\/\//i.test(ref) && !ref.includes(" "))
                paths.push(ref)
        } else if ("group" in ref) paths.push(...leafPagePaths(ref.pages))
    }
    return paths
}

/**
 * Every repo-path page ref reachable inside a version node's subtree.
 * Versions are full navigation containers and may hold pages under nested
 * tabs/groups, so directory derivation walks tabs/anchors/dropdowns/menu/global
 * rather than only pages/groups. Nested versions and languages belong to
 * other partitions and are excluded.
 */
function collectVersionLeafPaths(node: VersionNode): string[] {
    const leaves: string[] = []
    const stack: (VersionContainer & {
        pages?: PageRef[]
        groups?: { pages?: PageRef[]; hidden?: boolean }[]
    })[] = [node]
    while (stack.length > 0) {
        const container = stack.pop()
        if (!container) continue
        leaves.push(...leafPagePaths(container.pages))
        for (const group of container.groups ?? [])
            leaves.push(...leafPagePaths(group.pages))
        stack.push(
            ...(container.tabs ?? []),
            ...(container.anchors ?? []),
            ...(container.dropdowns ?? []),
            ...(container.products ?? []),
            ...(container.menu ?? []),
            ...(container.global ? [container.global] : []),
        )
    }
    return leaves
}

function configDirectoryForNode(
    node: VersionNode,
    directories: ReadonlySet<string>,
    containerChildren: ReadonlySet<string>,
): string | null {
    if (node.directory) return normalizeDirectory(node.directory)
    if (containerChildren.has(node.version)) return `versions/${node.version}`
    if (directories.has(node.version)) return node.version
    // Versions declared as explicit page lists (per-SDK-version
    // reference trees: `{version: "v2.29.1", pages: ["docs/sdk-reference/
    // js-sdk/v2.29.1/errors", …]}`) — the pages' common directory IS the
    // version's directory, wherever in the node's subtree those refs live
    // (including pages nested under tabs). Mixed-directory versions stay
    // unpartitioned.
    const leaves = collectVersionLeafPaths(node).map(normalizeDirectory)
    if (leaves.length === 0) return null
    let common = leaves[0]?.split("/").slice(0, -1) ?? []
    for (const leaf of leaves.slice(1)) {
        const segments = leaf.split("/")
        let shared = 0
        while (
            shared < common.length &&
            shared < segments.length - 1 &&
            common[shared] === segments[shared]
        )
            shared += 1
        common = common.slice(0, shared)
        if (common.length === 0) return null
    }
    return common.length > 0 ? common.join("/") : null
}

/**
 * Resolve product-version roots once at ingest. Source precedence is config,
 * top-level meta markers, the versions/ container, then conservative sibling
 * detection. The raw page URL stays intact for source identity; servedUrl is
 * the collision-checked and persisted routing identity.
 */
export function partitionVersions(input: {
    pages: CompiledDocsPage[]
    metas: CompiledDocsMeta[]
    config: DocsConfigSuperset | null
    diagnostics: Diagnostic[]
    /**
     * Locale scope (Phase A): pages are re-based on the locale directory
     * instead of keeping their raw-path URLs, and non-default locales
     * (label set) additionally gain the locale-tag URL prefix. A DEFAULT
     * locale with an explicit directory passes label: null — its directory
     * strips so the advertised unprefixed routes exist while localeLabel
     * stays null. The caller passes only this locale's pages.
     */
    locale?: { label: string | null; directory: string } | null
}): {
    pages: VersionedCompiledDocsPage[]
    manifest: VersionsManifest
    diagnostics: Diagnostic[]
} {
    const discovered = discoverVersions(input)
    const locale = input.locale ?? null
    const manifest = discovered.manifest.map((entry) => ({
        ...entry,
        // Same locale-root normalization partitionRootsFor applies.
        directory:
            locale && entry.directory === locale.directory
                ? ""
                : entry.directory,
    }))
    const { diagnostics } = discovered
    const partitionRoots = partitionRootsFor(discovered.roots, locale)
    const pages = input.pages.map((page): VersionedCompiledDocsPage => {
        const rebased = partitionRebase(page.path, partitionRoots, locale)
        return {
            ...page,
            versionLabel: rebased?.versionLabel ?? null,
            localeLabel: locale?.label ?? null,
            servedUrl: rebased
                ? [DOCS_ROUTE, ...rebased.slugs].join("/")
                : page.url,
        }
    })

    return { pages, manifest, diagnostics }
}
