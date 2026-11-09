import {
    type AnchorNode,
    type Diagnostic,
    type DropdownNode,
    type GlobalNode,
    type GroupNode,
    type LanguageNode,
    type MenuItemNode,
    type Navigation,
    type PageRef,
    type ProductNode,
    type ResolvedNavigation,
    type ResolvedTabEntry,
    type ResolvedTabGroup,
    resolvedNavigationSchema,
    type TabNode,
    type VersionNode,
} from "../types/docs"
import type { CompiledDocsMeta, CompiledDocsPage } from "./compile"
import type { CompiledOpenapiDocument } from "./openapi"

export { resolvedNavigationSchema } from "../types/docs"

const endpointReferencePattern =
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)$/i

interface NavigationContainer {
    hidden?: boolean
    searchable?: boolean
    directory?: string
    openapi?: string
    pages?: PageRef[]
    groups?: GroupNode[]
    tabs?: TabNode[]
    anchors?: AnchorNode[]
    dropdowns?: DropdownNode[]
    versions?: VersionNode[]
    languages?: LanguageNode[]
    products?: ProductNode[]
    menu?: MenuItemNode[]
    global?: GlobalNode
}

interface NavTarget {
    path: string
    folder: boolean
}

function normalizeReference(value: string): string {
    return value
        .replaceAll("\\", "/")
        .replace(/^\//, "")
        .replace(/\.(mdx|md)$/i, "")
        .replace(/\/$/, "")
}

function targetDirectory(target: NavTarget): string {
    if (target.folder)
        return target.path.includes("/")
            ? target.path.slice(0, target.path.lastIndexOf("/"))
            : ""
    return target.path.includes("/")
        ? target.path.slice(0, target.path.lastIndexOf("/"))
        : ""
}

function deepestCommonDirectory(targets: NavTarget[]): string {
    const directories = targets.map((target) =>
        targetDirectory(target).split("/").filter(Boolean),
    )
    const first = directories[0]
    if (!first) return ""
    const common: string[] = []
    for (const [index, segment] of first.entries()) {
        if (directories.every((directory) => directory[index] === segment))
            common.push(segment)
        else break
    }
    return common.join("/")
}

function containerDirectory(targets: NavTarget[]): string {
    const folderPaths = targets
        .filter((target) => target.folder)
        .map((target) => target.path)
    if (folderPaths.length === targets.length && folderPaths.length > 0) {
        const first = folderPaths[0]
        if (first && folderPaths.every((path) => path === first)) return first
    }
    return deepestCommonDirectory(targets)
}

function entryAtDirectory(target: NavTarget, directory: string): string | null {
    const relative = directory
        ? target.path.startsWith(`${directory}/`)
            ? target.path.slice(directory.length + 1)
            : target.path
        : target.path
    const first = relative.split("/").filter(Boolean)[0]
    return first?.replace(/\.(mdx|md)$/i, "") ?? null
}

function matchesOpenapiDocument(
    value: string,
    document: CompiledOpenapiDocument,
): boolean {
    const normalized = normalizeReference(value)
    const source = normalizeReference(document.sourcePath)
    const sourceWithoutSpecSuffix = source.replace(/\.(openapi|swagger)$/i, "")
    const sourceBasename = sourceWithoutSpecSuffix.split("/").at(-1)
    return (
        normalized === document.docId ||
        normalized === document.basePath ||
        normalized === source ||
        normalized === sourceWithoutSpecSuffix ||
        normalized === sourceBasename
    )
}

function selectLanguage(container: NavigationContainer): {
    container: NavigationContainer
    language: string | null
} {
    if (!container.languages || container.languages.length === 0)
        return { container, language: null }
    const selected =
        container.languages.find((language) => language.default) ??
        container.languages[0]
    if (!selected) return { container, language: null }
    // `global` beside `languages` applies to every language (site-wide
    // anchors live there); a language's own `global` wins.
    return {
        container:
            selected.global || !container.global
                ? selected
                : { ...selected, global: container.global },
        language: selected.language,
    }
}

/**
 * One entry per navigation.languages[] node — the multi-language serving
 * model (Phase A): every locale compiles, the default serves unprefixed and
 * the rest under /<locale>/. Single-language configs yield one default
 * entry so the compile orchestration has exactly one code path.
 */
export interface LocaleModel {
    /** Language tag; null for configs without a languages block. */
    locale: string | null
    default: boolean
    hidden: boolean
    /** Locale root directory ("" when the locale spans the repo root). */
    directory: string
    /** The navigation scoped to exactly this locale. */
    navigation: Navigation
}

/** Repo-path page refs anywhere in a container subtree (locale-directory
 * derivation — includes version children, unlike version-directory walks). */
function containerLeafPaths(root: NavigationContainer): string[] {
    const leaves: string[] = []
    const stack: NavigationContainer[] = [root]
    while (stack.length > 0) {
        const container = stack.pop()
        if (!container) continue
        for (const ref of container.pages ?? []) {
            if (typeof ref === "string") {
                if (!/^https?:\/\//i.test(ref) && !ref.includes(" "))
                    leaves.push(ref)
            } else if ("group" in ref) stack.push(ref)
        }
        stack.push(
            ...(container.groups ?? []),
            ...(container.tabs ?? []),
            ...(container.anchors ?? []),
            ...(container.dropdowns ?? []),
            ...(container.versions ?? []),
            ...(container.products ?? []),
            ...(container.menu ?? []),
            ...(container.global ? [container.global] : []),
        )
    }
    return leaves
}

export function enumerateLocales(navigation: Navigation): LocaleModel[] {
    const languages = navigation.languages ?? []
    if (languages.length === 0) {
        return [
            {
                locale: null,
                default: true,
                hidden: false,
                directory: "",
                navigation,
            },
        ]
    }
    const defaultNode =
        languages.find((node) => node.default === true) ?? languages[0]
    return languages.map((node) => {
        let directory = node.directory ? normalizeReference(node.directory) : ""
        if (!node.directory) {
            const leaves = containerLeafPaths(node).map(normalizeReference)
            let common: string[] | null = null
            for (const leaf of leaves) {
                const segments = leaf.split("/").slice(0, -1)
                if (common === null) {
                    common = segments
                    continue
                }
                let shared = 0
                while (
                    shared < common.length &&
                    shared < segments.length &&
                    common[shared] === segments[shared]
                )
                    shared += 1
                common = common.slice(0, shared)
                if (common.length === 0) break
            }
            directory = (common ?? []).join("/")
        }
        return {
            locale: node.language,
            default: node === defaultNode,
            hidden: node.hidden === true,
            directory,
            navigation: { ...navigation, languages: [node] },
        }
    })
}

/** Content-bearing anchors define docs.json tabs and page membership, which
 * per-directory `meta.json` cannot represent. OpenAPI anchors also own their
 * generated endpoint pages; link-only anchors remain ordinary links. */
function splitAnchorTabs(container: NavigationContainer): {
    tabs: TabNode[]
    anchors: AnchorNode[]
} {
    const tabs: TabNode[] = []
    const anchors: AnchorNode[] = []
    for (const anchor of container.anchors ?? []) {
        if (
            anchor.groups ||
            anchor.pages ||
            anchor.dropdowns ||
            anchor.versions ||
            anchor.openapi
        ) {
            tabs.push({
                tab: anchor.anchor,
                ...(anchor.icon ? { icon: anchor.icon } : {}),
                ...(anchor.href ? { href: anchor.href } : {}),
                ...(anchor.hidden !== undefined
                    ? { hidden: anchor.hidden }
                    : {}),
                ...(anchor.directory ? { directory: anchor.directory } : {}),
                ...(anchor.openapi ? { openapi: anchor.openapi } : {}),
                ...(anchor.languages ? { languages: anchor.languages } : {}),
                ...(anchor.versions ? { versions: anchor.versions } : {}),
                // Anchors are full containers — authored nested tabs must
                // survive the promotion or their page structure is lost.
                ...(anchor.tabs ? { tabs: anchor.tabs } : {}),
                ...(anchor.dropdowns ? { dropdowns: anchor.dropdowns } : {}),
                ...(anchor.groups ? { groups: anchor.groups } : {}),
                ...(anchor.pages ? { pages: anchor.pages } : {}),
            })
        } else {
            anchors.push(anchor)
        }
    }
    return { tabs, anchors }
}

/** Some sites nest navigation under the default version. Hoist that version's
 * children to preserve top-level tabs, then exclude the hoisted node from
 * version recursion. */
export function hoistDefaultVersion(container: NavigationContainer): {
    container: NavigationContainer
    hoisted: VersionNode | null
} {
    const versions = container.versions ?? []
    const hoisted =
        versions.find(
            (node) => node.default === true && node.hidden !== true,
        ) ??
        versions.find((node) => node.hidden !== true) ??
        versions[0] ??
        null
    if (!hoisted) return { container, hoisted: null }
    // VersionNode carries tabs/groups/pages/global (§7 versionNode) — the
    // full child set a version subtree can declare.
    const merged: NavigationContainer = {
        ...container,
        ...(hoisted.tabs || container.tabs
            ? { tabs: [...(container.tabs ?? []), ...(hoisted.tabs ?? [])] }
            : {}),
        ...(hoisted.groups || container.groups
            ? {
                  groups: [
                      ...(container.groups ?? []),
                      ...(hoisted.groups ?? []),
                  ],
              }
            : {}),
        ...(hoisted.pages || container.pages
            ? { pages: [...(container.pages ?? []), ...(hoisted.pages ?? [])] }
            : {}),
        ...(container.global || hoisted.global
            ? { global: container.global ?? hoisted.global }
            : {}),
    }
    return { container: merged, hoisted }
}

export function resolveNavigationModel(
    navigation: Navigation,
): ResolvedNavigation {
    const selected = selectLanguage(navigation)
    const { container } = hoistDefaultVersion(selected.container)
    const split = splitAnchorTabs(container)
    return resolvedNavigationSchema.parse({
        language: selected.language,
        tabs: [...(container.tabs ?? []), ...split.tabs],
        anchors: split.anchors,
        dropdowns: container.dropdowns ?? [],
        // The full version list survives the hoist — discoverVersions walks
        // it for roots, and the switcher needs every declared version.
        versions: selected.container.versions ?? [],
        products: container.products ?? [],
        menu: container.menu ?? [],
        global: container.global ?? null,
    })
}

export function compileNavigation(input: {
    navigation: Navigation | null
    pages: CompiledDocsPage[]
    openapiDocuments: CompiledOpenapiDocument[]
    existingMetas: CompiledDocsMeta[]
}): {
    metas: CompiledDocsMeta[]
    hiddenPaths: Set<string>
    searchablePaths: Set<string>
    diagnostics: Diagnostic[]
    navSource: "filesystem" | "config"
    /**
     * Persist exact compiled paths and resolved groups so serving can scope
     * tabs by membership. Directory prefixes fail when tabs span directories
     * or multiple groups collapse into one meta row. One map per scope
     * (navigation.tabs, navigation.global.tabs), keyed by the tab's POSITION
     * in that list — labels are not unique, so two tabs sharing one would
     * otherwise collapse onto a single membership.
     */
    tabPages: Record<
        "tabs" | "global",
        Map<
            number,
            {
                pages: string[]
                href: string | null
                groups: ResolvedTabGroup[]
                /** Hidden through the tab OR its selected-language node —
                 * stamped onto the resolved tab so chrome treats both alike. */
                hidden: boolean
                /** Per `menu` item, positionally: its compiled pages (first
                 * = the header dropdown's landing link, empty for href-only
                 * items) and its resolved sidebar structure. */
                menu: { pages: string[]; groups: ResolvedTabGroup[] }[]
            }
        >
    >
} {
    const frontmatterHiddenPaths = new Set(
        input.pages
            .filter((page) => page.frontmatter.hidden === true)
            .map((page) => page.path),
    )
    if (input.navigation === null) {
        return {
            metas: input.existingMetas,
            hiddenPaths: frontmatterHiddenPaths,
            searchablePaths: new Set(
                input.pages
                    .filter((page) => page.frontmatter.searchable === true)
                    .map((page) => page.path),
            ),
            diagnostics: [],
            navSource: "filesystem",
            tabPages: { tabs: new Map(), global: new Map() },
        }
    }

    const diagnostics: Diagnostic[] = []
    const metasByPath = new Map<string, CompiledDocsMeta>()
    // `let` so the root tab loop can swap in a scratch set to capture each
    // tab's page membership (helpers close over the binding).
    let referencedPaths = new Set<string>()
    const tabPages: ReturnType<typeof compileNavigation>["tabPages"] = {
        tabs: new Map(),
        global: new Map(),
    }
    // Per menu item (by node identity — selectLanguage hands back the same
    // objects): every compiled page under it, first one = landing.
    const menuItemPages = new WeakMap<
        MenuItemNode,
        { pages: string[]; groups: ResolvedTabGroup[] }
    >()
    const pagesByPath = new Map(input.pages.map((page) => [page.path, page]))
    const searchablePaths = new Set(
        input.pages
            .filter((page) => page.frontmatter.searchable === true)
            .map((page) => page.path),
    )
    const referencedDocuments = new Set<string>()
    const pagesByReference = new Map<string, CompiledDocsPage>()
    for (const page of input.pages) {
        const references = new Set([
            normalizeReference(page.path),
            normalizeReference(page.url),
            page.slugs.join("/"),
        ])
        if (page.slugs.length === 0) references.add("index")
        for (const reference of references) {
            if (reference) pagesByReference.set(reference, page)
        }
    }

    // Pure ref→entries resolver for tab structure capture (no diagnostics —
    // compileContainer already reports broken refs for the same subtree).
    const collectStructureEntries = (
        refs: PageRef[],
        openapiContext?: string,
    ): ResolvedTabEntry[] => {
        const entries: ResolvedTabEntry[] = []
        // Endpoint refs resolve inside the container's OpenAPI document when
        // one is in scope, so two specs sharing `GET /users` never cross.
        const contextDocId = documentForContext(openapiContext)?.docId
        const addReference = (reference: string): void => {
            const endpoint = endpointReferencePattern.exec(reference.trim())
            if (endpoint) {
                const method = endpoint[1]?.toLowerCase()
                const operationPath = endpoint[2]
                const page = input.pages.find(
                    (candidate) =>
                        candidate.kind === "openapi" &&
                        (contextDocId === undefined ||
                            candidate.openapiProps?.document ===
                                contextDocId) &&
                        candidate.openapiProps?.operations?.some(
                            (operation) =>
                                operation.method.toLowerCase() === method &&
                                operation.path === operationPath,
                        ),
                )
                if (page) entries.push({ page: page.path })
                return
            }
            const normalized = normalizeReference(reference)
            const document = input.openapiDocuments.find(
                (candidate) => candidate.basePath === normalized,
            )
            if (document) {
                for (const page of input.pages) {
                    if (page.openapiProps?.document === document.docId)
                        entries.push({ page: page.path })
                }
                return
            }
            const page = pagesByReference.get(normalized)
            if (!page) return
            // Frontmatter `url` makes a page an external pointer:
            // the sidebar links to its destination instead of the internal route.
            const externalUrl =
                typeof page.frontmatter.url === "string" &&
                /^https?:\/\//i.test(page.frontmatter.url)
                    ? page.frontmatter.url
                    : null
            if (externalUrl) {
                const sidebarTitle = page.frontmatter.sidebarTitle
                entries.push({
                    href: externalUrl,
                    label:
                        typeof sidebarTitle === "string"
                            ? sidebarTitle
                            : page.title,
                })
                return
            }
            entries.push({ page: page.path })
        }
        for (const ref of refs) {
            if (typeof ref === "string") {
                addReference(ref)
                continue
            }
            if ("group" in ref) {
                if (ref.hidden) continue
                const nested = collectStructureEntries(
                    ref.pages,
                    openapiContext,
                )
                const rootPage =
                    ref.root !== undefined
                        ? pagesByReference.get(normalizeReference(ref.root))
                        : undefined
                if (nested.length > 0 || rootPage) {
                    entries.push({
                        group: {
                            title: ref.group,
                            ...(ref.icon ? { icon: ref.icon } : {}),
                            ...(ref.expanded !== undefined
                                ? { expanded: ref.expanded }
                                : {}),
                            // The group's landing page (docs.json groups[].root)
                            // — the tab tree renders it as the folder index so
                            // clicking the folder title navigates.
                            ...(rootPage ? { root: rootPage.path } : {}),
                            entries: nested,
                        },
                    })
                }
                continue
            }
            if (/^https?:\/\//i.test(ref.href)) {
                entries.push({ href: ref.href, label: ref.href })
                continue
            }
            addReference(ref.href)
        }
        return entries
    }

    const mergeMeta = (
        directory: string,
        data: Record<string, unknown>,
        entries: string[] = [],
    ): void => {
        const path = directory ? `${directory}/meta.json` : "meta.json"
        const current = metasByPath.get(path)
        const currentPages = Array.isArray(current?.data.pages)
            ? current.data.pages.filter(
                  (page): page is string => typeof page === "string",
              )
            : []
        const nextPages = [...currentPages]
        for (const entry of entries) {
            if (!nextPages.includes(entry)) nextPages.push(entry)
        }
        metasByPath.set(path, {
            path,
            data: {
                ...(current?.data ?? {}),
                ...data,
                ...(nextPages.length > 0 ? { pages: nextPages } : {}),
            },
        })
    }

    // Apply title claims in walk order to preserve last-writer wins. Validate
    // derived-directory claims against all referenced pages beneath that parent
    // so a group spanning subdirectories cannot retitle unrelated content.
    // Authored-directory and tab/anchor claims keep their existing guards.
    const titleClaims: Array<{
        directory: string
        data: Record<string, unknown>
        validateTargets?: NavTarget[]
    }> = []

    const placeFoldersInParents = (targets: NavTarget[]): void => {
        for (const target of targets) {
            if (!target.folder) continue
            const directory = targetDirectory(target)
            const entry = entryAtDirectory(target, directory)
            if (entry) mergeMeta(directory, {}, [entry])
        }
    }

    const reportBrokenReference = (reference: string): void => {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `Navigation references a page that does not exist: ${reference}.`,
            path: "docs.json",
        })
    }

    const documentForContext = (
        openapiContext: string | undefined,
    ): CompiledOpenapiDocument | null => {
        if (!openapiContext) return null
        const document = input.openapiDocuments.find((candidate) =>
            matchesOpenapiDocument(openapiContext, candidate),
        )
        if (!document) {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Navigation references an OpenAPI document that does not exist: ${openapiContext}.`,
                path: "docs.json",
            })
            return null
        }
        referencedDocuments.add(document.docId)
        return document
    }

    const resolvePageReference = (
        reference: string,
        openapiContext: string | undefined,
        navigable: boolean,
        searchable: boolean,
    ): NavTarget[] => {
        const endpoint = endpointReferencePattern.exec(reference.trim())
        if (endpoint) {
            if (!openapiContext) {
                diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `Endpoint navigation reference requires an OpenAPI context: ${reference}.`,
                    path: "docs.json",
                })
                return []
            }
            const document = documentForContext(openapiContext)
            const method = endpoint[1]?.toLowerCase()
            const operationPath = endpoint[2]
            const page = input.pages.find(
                (candidate) =>
                    candidate.kind === "openapi" &&
                    candidate.openapiProps?.document === document?.docId &&
                    candidate.openapiProps?.operations?.some(
                        (operation) =>
                            operation.method.toLowerCase() === method &&
                            operation.path === operationPath,
                    ),
            )
            if (!page) {
                reportBrokenReference(reference)
                return []
            }
            if (navigable) referencedPaths.add(page.path)
            if (searchable) searchablePaths.add(page.path)
            if (document) referencedDocuments.add(document.docId)
            return [{ path: page.path, folder: false }]
        }

        const normalized = normalizeReference(reference)
        const document = input.openapiDocuments.find(
            (candidate) => candidate.basePath === normalized,
        )
        if (document) {
            referencedDocuments.add(document.docId)
            for (const page of input.pages) {
                if (page.openapiProps?.document !== document.docId) continue
                if (navigable) referencedPaths.add(page.path)
                if (searchable) searchablePaths.add(page.path)
            }
            return [{ path: document.basePath, folder: true }]
        }
        const page = pagesByReference.get(normalized)
        if (!page) {
            reportBrokenReference(reference)
            return []
        }
        if (navigable) referencedPaths.add(page.path)
        if (searchable) searchablePaths.add(page.path)
        if (page.kind === "openapi" && page.openapiProps?.document)
            referencedDocuments.add(page.openapiProps.document)
        return [{ path: page.path, folder: false }]
    }

    // Authored sidebar structure of one container (its loose pages + groups),
    // page refs resolved to source paths — the tab-scoped sidebar's input.
    // Shared by root/global tabs and their mega-menu items (each item is a
    // sidebar section of its own).
    const resolveStructureGroups = (
        selected: NavigationContainer,
        inheritedOpenapi?: string,
    ): ResolvedTabGroup[] => {
        const resolvedGroups: ResolvedTabGroup[] = []
        const openapiContext = selected.openapi ?? inheritedOpenapi
        const loose = collectStructureEntries(
            selected.pages ?? [],
            openapiContext,
        )
        if (loose.length > 0) resolvedGroups.push({ entries: loose })
        // A container that only names an OpenAPI document lists that
        // document's generated pages (mirrors compileContainer's fallback).
        const document = documentForContext(selected.openapi)
        if (document && loose.length === 0 && !selected.groups?.length) {
            const entries: ResolvedTabEntry[] = input.pages
                .filter(
                    (page) => page.openapiProps?.document === document.docId,
                )
                .map((page) => ({ page: page.path }))
            if (entries.length > 0) resolvedGroups.push({ entries })
        }
        for (const group of selected.groups ?? []) {
            if (group.hidden) continue
            // A group may name its own OpenAPI document (compileGroup does
            // the same when it compiles the group's pages).
            const groupEntries = collectStructureEntries(
                group.pages,
                group.openapi ?? openapiContext,
            )
            const groupRoot =
                group.root !== undefined
                    ? pagesByReference.get(normalizeReference(group.root))
                    : undefined
            if (groupEntries.length === 0 && !groupRoot) continue
            resolvedGroups.push({
                title: group.group,
                ...(group.icon ? { icon: group.icon } : {}),
                ...(group.expanded !== undefined
                    ? { expanded: group.expanded }
                    : {}),
                ...(groupRoot ? { root: groupRoot.path } : {}),
                entries: groupEntries,
            })
        }
        // Nested containers (a menu item holding tabs / dropdowns / products /
        // anchors / versions) contribute their sections too, titled by the
        // container's label when the section has none — so a page reached
        // through them still gets the menu item's sidebar and eyebrow.
        const nested: { label: string; container: NavigationContainer }[] = [
            ...(selected.tabs ?? []).map((node) => ({
                label: node.tab,
                container: node,
            })),
            ...(selected.dropdowns ?? []).map((node) => ({
                label: node.dropdown,
                container: node,
            })),
            ...(selected.products ?? []).map((node) => ({
                label: node.product,
                container: node,
            })),
            ...(selected.anchors ?? []).map((node) => ({
                label: node.anchor,
                container: node,
            })),
            ...(selected.versions ?? []).map((node) => ({
                label: node.version,
                container: node,
            })),
            // navigation.global rides along like compileContainer.
            ...(selected.global
                ? [{ label: "", container: selected.global }]
                : []),
        ]
        for (const { label, container } of nested) {
            if (container.hidden) continue
            for (const group of resolveStructureGroups(
                selectLanguage(container).container,
                openapiContext,
            ))
                resolvedGroups.push(
                    group.title || !label ? group : { ...group, title: label },
                )
        }
        return resolvedGroups
    }

    const compilePageRefs = (
        refs: PageRef[],
        openapiContext: string | undefined,
        navigable: boolean,
        searchable: boolean,
        label?: string,
    ): NavTarget[] => {
        const targets: NavTarget[] = []
        for (const ref of refs) {
            if (typeof ref === "string") {
                targets.push(
                    ...resolvePageReference(
                        ref,
                        openapiContext,
                        navigable,
                        searchable,
                    ),
                )
                continue
            }
            if ("group" in ref) {
                targets.push(
                    ...compileGroup(ref, openapiContext, navigable, searchable),
                )
                continue
            }
            if (/^https?:\/\//i.test(ref.href)) {
                const text = ref.href.replace(/[[\]()]/g, "")
                targets.push({ path: `[${text}](${ref.href})`, folder: false })
            } else {
                targets.push(
                    ...resolvePageReference(
                        ref.href,
                        openapiContext,
                        navigable,
                        searchable,
                    ),
                )
            }
        }
        const realTargets = targets.filter(
            (target) => !target.path.startsWith("["),
        )
        const directory = deepestCommonDirectory(realTargets)
        const entries = targets.flatMap((target) => {
            if (target.path.startsWith("[")) return [target.path]
            const entry = entryAtDirectory(target, directory)
            return entry ? [entry] : []
        })
        if (entries.length > 0) {
            mergeMeta(
                directory,
                {},
                label && directory === ""
                    ? [`---${label}---`, ...entries]
                    : entries,
            )
            // The label-as-title claim on a DERIVED directory goes through
            // the same post-walk ownership validation as compileGroup's —
            // A one-page group can derive docs/ (the shared
            // root of every page) and must not retitle it.
            if (label && directory !== "") {
                titleClaims.push({
                    directory,
                    data: { title: label },
                    validateTargets: realTargets,
                })
            }
        }
        return realTargets
    }

    const compileGroup = (
        group: GroupNode,
        inheritedOpenapi: string | undefined,
        inheritedNavigable: boolean,
        inheritedSearchable: boolean,
    ): NavTarget[] => {
        const navigable = inheritedNavigable && !group.hidden
        const searchable = group.searchable ?? inheritedSearchable
        const openapiContext = group.openapi ?? inheritedOpenapi
        // docs.json groups[].root is the page that opens when clicking the
        // group title — a landing page ref, compiled like any member page.
        const targets = compilePageRefs(
            group.root !== undefined
                ? [group.root, ...group.pages]
                : group.pages,
            openapiContext,
            navigable,
            searchable,
            group.group,
        )
        const document = documentForContext(group.openapi)
        if (document && targets.length === 0) {
            for (const page of input.pages) {
                if (page.openapiProps?.document !== document.docId) continue
                if (navigable) referencedPaths.add(page.path)
                if (searchable) searchablePaths.add(page.path)
            }
            targets.push({ path: document.basePath, folder: true })
        }
        if (!navigable) return []
        placeFoldersInParents(targets)
        const directory = group.directory
            ? normalizeReference(group.directory)
            : containerDirectory(targets)
        if (directory) {
            const data = {
                title: group.group,
                ...(group.icon ? { icon: group.icon } : {}),
                ...(group.expanded !== undefined
                    ? { defaultOpen: group.expanded }
                    : {}),
            }
            if (group.directory) titleClaims.push({ directory, data })
            else titleClaims.push({ directory, data, validateTargets: targets })
            return [{ path: directory, folder: true }]
        }
        return targets
    }

    // Set by the root tab loop for ONE compileContainer call: a hidden tab
    // (or its hidden selected-language container) compiles as navigable so
    // its membership is captured; nested hidden groups keep their meaning.
    let unhideNextContainer = false
    const compileContainer = (
        rawContainer: NavigationContainer,
        inheritedOpenapi?: string,
        inheritedNavigable = true,
        inheritedSearchable = false,
        // "tabs" while compiling the root container (its tabs record page
        // membership), "global" for the root's navigation.global, null below.
        tabScope: "tabs" | "global" | null = null,
    ): NavTarget[] => {
        const unhide = unhideNextContainer
        unhideNextContainer = false
        const container = selectLanguage(rawContainer).container
        const navigable =
            inheritedNavigable &&
            (unhide || (!rawContainer.hidden && !container.hidden))
        const searchable =
            container.searchable ??
            rawContainer.searchable ??
            inheritedSearchable
        const openapiContext = container.openapi ?? inheritedOpenapi
        const targets = compilePageRefs(
            container.pages ?? [],
            openapiContext,
            navigable,
            searchable,
        )
        for (const group of container.groups ?? [])
            targets.push(
                ...compileGroup(group, openapiContext, navigable, searchable),
            )

        const document = documentForContext(container.openapi)
        if (document && targets.length === 0) {
            for (const page of input.pages) {
                if (page.openapiProps?.document !== document.docId) continue
                if (navigable) referencedPaths.add(page.path)
                if (searchable) searchablePaths.add(page.path)
            }
            targets.push({ path: document.basePath, folder: true })
        }
        if (!navigable) return []
        placeFoldersInParents(targets)

        for (const [tabIndex, tab] of (container.tabs ?? []).entries()) {
            if (/^https?:\/\//i.test(tab.href ?? "") && !tab.directory) continue
            // Root and global tabs capture their exact page membership: swap
            // in a scratch set so every page the tab's subtree references
            // lands in it (compileGroup can collapse clean directories into
            // folder targets, hiding the page list from `children`).
            const outerReferenced = tabScope !== null ? referencedPaths : null
            if (outerReferenced) referencedPaths = new Set<string>()
            // A `hidden` tab: its pages stay routable and keep the
            // tab's own sidebar (the header shows the tab only while one of
            // its pages is open), but the subtree never lands in the merged
            // tree. Compile it un-hidden to capture membership, then drop
            // its children.
            const hiddenTab =
                tabScope !== null &&
                (tab.hidden === true ||
                    selectLanguage(tab).container.hidden === true)
            unhideNextContainer = hiddenTab
            const compiled = compileContainer(
                tab,
                openapiContext,
                navigable,
                searchable,
            )
            const children = hiddenTab ? [] : compiled
            if (outerReferenced && tabScope !== null) {
                const pages = [...referencedPaths]
                for (const path of pages) outerReferenced.add(path)
                referencedPaths = outerReferenced
                const first = pages[0]
                if (first !== undefined) {
                    const selectedTab = selectLanguage(tab).container
                    const resolvedGroups = resolveStructureGroups(
                        selectedTab,
                        openapiContext,
                    )
                    // Mega-menu items land on their first compiled page
                    // (the header dropdown) — positional, so items
                    // sharing a label still map to their own page. The tab
                    // itself is positional too: resolveNavigationModel
                    // builds the same [...tabs, ...anchorTabs] order.
                    tabPages[tabScope].set(tabIndex, {
                        pages,
                        href: pagesByPath.get(first)?.url ?? null,
                        groups: resolvedGroups,
                        hidden: hiddenTab,
                        menu: (selectedTab.menu ?? []).map(
                            (item) =>
                                menuItemPages.get(item) ?? {
                                    pages: [],
                                    groups: [],
                                },
                        ),
                    })
                }
            }
            const directory = tab.directory
                ? normalizeReference(tab.directory)
                : containerDirectory(children)
            if (!directory) continue
            // A bare page-list tab with a single page (for example, a changelog
            // anchor-tab: pages: ["docs/changelog"]) is a LINK, not a
            // section — deriving "the directory that page happens to live
            // in" would let it relabel a tree it references one page of.
            // Its tabPages membership above still scopes the sidebar.
            if (
                !tab.directory &&
                children.length < 2 &&
                children.every((child) => !child.folder)
            )
                continue
            titleClaims.push({
                directory,
                data: {
                    title: tab.tab,
                    root: true,
                    ...(tab.icon ? { icon: tab.icon } : {}),
                },
            })
            const target = { path: directory, folder: true }
            targets.push(target)
            placeFoldersInParents([target])
        }
        // Anchors own page sets, not directories. Resolve all directories first
        // and assign a titled root only when that anchor is the sole claimant;
        // different page sets can share one directory.
        const anchorFrames: {
            anchor: AnchorNode
            children: NavTarget[]
            directory: string
        }[] = []
        for (const anchor of container.anchors ?? []) {
            if (!anchor.groups && !anchor.pages) {
                // Pure-container anchors (an SDK reference can hold
                // dropdowns of versions, no direct pages) still contribute
                // their nested pages to navigation and search — as do
                // openapi-only anchors nested below the root (root-level
                // ones were already promoted to tabs by splitAnchorTabs).
                if (
                    anchor.dropdowns ||
                    anchor.versions ||
                    anchor.tabs ||
                    anchor.languages ||
                    anchor.openapi
                ) {
                    targets.push(
                        ...compileContainer(
                            anchor,
                            openapiContext,
                            navigable,
                            searchable,
                        ),
                    )
                }
                continue
            }
            const children = compileContainer(
                anchor,
                openapiContext,
                navigable,
                searchable,
            )
            const directory = anchor.directory
                ? normalizeReference(anchor.directory)
                : containerDirectory(children)
            if (!directory) continue
            // A bare page-list anchor with a single page (for example, a changelog:
            // pages: ["docs/changelog"]) is a LINK, not a section — deriving
            // "the directory that page happens to live in" would let it claim
            // a tree it references one page of. Explicit anchor.directory
            // still claims.
            if (
                !anchor.directory &&
                children.length < 2 &&
                children.every((child) => !child.folder)
            )
                continue
            anchorFrames.push({ anchor, children, directory })
        }
        if (process.env.DEBUG_ANCHORS)
            console.error(
                "[anchors]",
                JSON.stringify(
                    anchorFrames.map((f) => ({
                        anchor: f.anchor.anchor,
                        directory: f.directory,
                        children: f.children.length,
                    })),
                ),
            )
        const anchorDirectoryClaims = new Map<string, number>()
        for (const frame of anchorFrames)
            anchorDirectoryClaims.set(
                frame.directory,
                (anchorDirectoryClaims.get(frame.directory) ?? 0) + 1,
            )
        for (const { anchor, children, directory } of anchorFrames) {
            if ((anchorDirectoryClaims.get(directory) ?? 0) > 1) {
                // Shared directory: no anchor owns it. The pages stay
                // navigable through their natural group structure.
                targets.push(...children)
                continue
            }
            titleClaims.push({
                directory,
                data: {
                    title: anchor.anchor,
                    root: true,
                    ...(anchor.icon ? { icon: anchor.icon } : {}),
                },
            })
            const target = { path: directory, folder: true }
            targets.push(target)
            placeFoldersInParents([target])
        }
        for (const dropdown of container.dropdowns ?? [])
            targets.push(
                ...compileContainer(
                    dropdown,
                    openapiContext,
                    navigable,
                    searchable,
                ),
            )
        for (const version of container.versions ?? [])
            targets.push(
                ...compileContainer(
                    version,
                    openapiContext,
                    navigable,
                    searchable,
                ),
            )
        for (const product of container.products ?? [])
            targets.push(
                ...compileContainer(
                    product,
                    openapiContext,
                    navigable,
                    searchable,
                ),
            )
        for (const item of container.menu ?? []) {
            // Capture the item's own page membership (a scratch set, like
            // root tabs) so the header dropdown can land on its first page
            // whatever container shape holds it: pages, groups (incl. root),
            // nested tabs, dropdowns, openapi, global.
            const outer = referencedPaths
            referencedPaths = new Set<string>()
            targets.push(
                ...compileContainer(
                    item,
                    openapiContext,
                    navigable,
                    searchable,
                ),
            )
            menuItemPages.set(item, {
                pages: [...referencedPaths],
                groups: resolveStructureGroups(
                    selectLanguage(item).container,
                    openapiContext,
                ),
            })
            for (const path of referencedPaths) outer.add(path)
            referencedPaths = outer
        }
        // The root's `global` records its tabs' page membership too — the
        // band renders both lists and stampNav stamps both — under its own
        // scope, so a global tab never overwrites a root tab of the same
        // label.
        if (container.global)
            targets.push(
                ...compileContainer(
                    container.global,
                    openapiContext,
                    navigable,
                    searchable,
                    tabScope === "tabs" ? "global" : null,
                ),
            )
        return targets
    }

    const selectedRoot = selectLanguage(input.navigation)
    // Mirror resolveNavigationModel's default-version hoist and anchor→tab
    // split so tabPages membership is recorded under the same titles the
    // stored __resolvedNav.tabs carry. The hoisted default node is excluded
    // from the versions recursion — its subtree already compiled at the top
    // level; non-default versions still compile as children for
    // navigability/search.
    const rootHoist = hoistDefaultVersion(selectedRoot.container)
    const rootSplit = splitAnchorTabs(rootHoist.container)
    compileContainer(
        {
            ...rootHoist.container,
            tabs: [...(rootHoist.container.tabs ?? []), ...rootSplit.tabs],
            anchors: rootSplit.anchors,
            versions: (rootHoist.container.versions ?? []).filter(
                (node) => node !== rootHoist.hoisted,
            ),
        },
        undefined,
        true,
        false,
        "tabs",
    )

    for (const claim of titleClaims) {
        const validateTargets = claim.validateTargets
        if (validateTargets) {
            const covered = (path: string): boolean =>
                validateTargets.some((target) =>
                    target.folder
                        ? path === target.path ||
                          path.startsWith(`${target.path}/`)
                        : path === target.path,
                )
            let owned = true
            for (const path of referencedPaths) {
                if (path.startsWith(`${claim.directory}/`) && !covered(path)) {
                    owned = false
                    break
                }
            }
            if (!owned) continue
        }
        mergeMeta(claim.directory, claim.data)
    }

    for (const document of input.openapiDocuments) {
        if (!referencedDocuments.has(document.docId)) {
            diagnostics.push({
                code: "openapi_orphaned",
                severity: "warn",
                message: `OpenAPI document "${document.label}" is not referenced by the configured navigation and remains URL-reachable but hidden.`,
                path: document.sourcePath,
            })
            continue
        }
        for (const meta of input.existingMetas) {
            if (
                meta.path === `${document.basePath}/meta.json` ||
                meta.path.startsWith(`${document.basePath}/`)
            ) {
                const directory = meta.path.replace(/\/?meta\.json$/i, "")
                const pages = Array.isArray(meta.data.pages)
                    ? meta.data.pages.filter(
                          (page): page is string => typeof page === "string",
                      )
                    : []
                const data = metasByPath.has(meta.path)
                    ? Object.fromEntries(
                          Object.entries(meta.data).filter(
                              ([key]) =>
                                  key !== "title" &&
                                  key !== "icon" &&
                                  key !== "root" &&
                                  key !== "defaultOpen" &&
                                  key !== "pages",
                          ),
                      )
                    : meta.data
                mergeMeta(directory, data, pages)
            }
        }
    }

    const hiddenPaths = new Set<string>()
    for (const page of input.pages) {
        if (
            frontmatterHiddenPaths.has(page.path) ||
            !referencedPaths.has(page.path)
        )
            hiddenPaths.add(page.path)
    }
    return {
        metas: [...metasByPath.values()].sort((a, b) =>
            a.path.localeCompare(b.path),
        ),
        hiddenPaths,
        searchablePaths,
        diagnostics,
        navSource: "config",
        tabPages,
    }
}
