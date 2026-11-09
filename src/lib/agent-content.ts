import { createHash } from "node:crypto"
import { isMarkdownPreferred } from "fumadocs-core/negotiation"
import {
    findNeighbour,
    findPath,
    getPageTreePeers,
} from "fumadocs-core/page-tree"
import {
    type AdvancedIndex,
    createSearchAPI,
} from "fumadocs-core/search/server"
import { LRUCache } from "lru-cache"
import { toString as mdastToString } from "mdast-util-to-string"
import { remark } from "remark"
import type { ResolvedTabGroup } from "@/types/docs"
import { isAllowedUrl } from "@/types/docs-shared"
import { env } from "../env"
import { agentConfig } from "./agent.config"
import { basePath, stripBase, withBase, withBaseInMarkdown } from "./base-path"
import { docsRoute, slugsToMarkdownPath } from "./shared"
import {
    type DocPage,
    type DocsContext,
    isPageIndexable,
    processedMarkdownForPages,
    type SiteSource,
    searchSourceForActiveVersion,
    structuredDataFor,
    type TreeCrumb,
    treeDerivations,
} from "./source"

export type { DocPage }

/** ISO 639-1 primary subtag → Orama language name (supported set only). */
const ORAMA_LANGUAGES: Record<string, string> = {
    en: "english",
    es: "spanish",
    fr: "french",
    de: "german",
    it: "italian",
    pt: "portuguese",
    nl: "dutch",
    sv: "swedish",
    da: "danish",
    fi: "finnish",
    no: "norwegian",
    ru: "russian",
    uk: "ukrainian",
    hu: "hungarian",
    ro: "romanian",
    el: "greek",
    tr: "turkish",
    bg: "bulgarian",
    ta: "tamil",
    hi: "hindi",
    ar: "arabic",
}

/** One search server per site/content version/locale/version label,
 * shared by the search API, Ask-AI, and MCP. `fetchMethod` coalesces cold
 * concurrent builds and drops a rejected one; page views warm it through
 * `waitUntil`. Recency-bounded: each entry holds a whole Orama index. */
const searchServers = new LRUCache<
    string,
    ReturnType<typeof createSearchAPI>,
    { ctx: DocsContext; slugs: string[] }
>({
    max: 16,
    ignoreFetchAbort: true,
    fetchMethod: (_key, _stale, { context }) =>
        buildSearchServer(context.ctx, context.slugs),
})

export function searchServerFor(ctx: DocsContext, slugs: string[] = []) {
    const label = ctx.activeVersion(slugs)
    return searchServers.forceFetch(
        `${ctx.site.id}:${ctx.versionId ?? "none"}:${ctx.activeLocale ?? ""}:${label ?? ""}`,
        { context: { ctx, slugs } },
    )
}

async function buildSearchServer(ctx: DocsContext, slugs: string[]) {
    // Built per index build, not at module load: start.ts imports this
    // module for its URL helpers on every cold start. (The remark module
    // itself is already loaded there by fumadocs-core/search/server.)
    const markdownParser = remark()
    const source = await searchSourceForActiveVersion(ctx, slugs)
    // structuredData left the eager version source (cold-start diet) —
    // bulk-load it here, the one consumer that needs the whole corpus.
    const structuredDataByPath = ctx.versionId
        ? await structuredDataFor(ctx.versionId)
        : new Map<string, never>()
    // sourcePath → "Tab › Group" from the resolved nav. Without this
    // fumadocs derives crumbs from the merged page tree, whose lossy
    // meta merge labels EVERY result with the first root folder
    // ("Get Started"). The tag doubles as the tab filter.
    const navCrumbs = new Map<string, { tag: string; breadcrumbs: string[] }>()
    for (const tab of [
        ...(ctx.config?.__resolvedNav?.tabs ?? []),
        ...(ctx.config?.__resolvedNav?.global?.tabs ?? []),
    ]) {
        const claim = (path: string, group: string | undefined) => {
            if (navCrumbs.has(path)) return
            navCrumbs.set(path, {
                tag: tab.tab,
                breadcrumbs: group ? [tab.tab, group] : [tab.tab],
            })
        }
        const walkGroup = (
            group: ResolvedTabGroup,
            inherited: string | undefined,
        ) => {
            const title = group.title ?? inherited
            for (const entry of group.entries) {
                if ("page" in entry) claim(entry.page, title)
                else if ("group" in entry) walkGroup(entry.group, title)
            }
        }
        for (const group of tab.resolvedGroups ?? [])
            walkGroup(group, undefined)
        for (const path of tab.resolvedPages ?? []) claim(path, undefined)
    }
    // Indexes built eagerly and handed over as data, not through fumadocs'
    // createFromSource and its lazy buildIndex closure: that closure kept
    // the whole corpus Map alive for the server's life. A page missing from
    // the nav gets fumadocs' default crumbs — its ancestors in the search
    // tree.
    const tree = source.getPageTree()
    const indexes = source.getPages().map((page): AdvancedIndex => {
        const structuredData = structuredDataByPath.get(page.data.sourcePath)
        // Ingest guarantees a row per page — a miss is a bug, not a
        // degradable state.
        if (!structuredData)
            throw new Error(`no structuredData for ${page.data.sourcePath}`)
        const crumbs = navCrumbs.get(page.data.sourcePath)
        const path = crumbs
            ? null
            : findPath(
                  tree.children,
                  (node) => node.type === "page" && node.url === page.url,
              )
        return {
            title: page.data.pageTitle,
            description: page.data.description,
            url: page.url,
            // fumadocs' default index id is the bare page URL and section ids
            // are `${id}-${n}`, so a page at /foo-6 collides with section 6
            // of /foo (Orama DOCUMENT_ALREADY_EXISTS; bun docs hit this with
            // typescript.mdx + typescript-6.mdx). "#" cannot appear in a page
            // URL, so suffixing it keeps page and section ids disjoint.
            id: `${page.url}#page`,
            // Ingest's structure pass keeps paragraph text as markdown
            // (`**Team → Webhooks**`, backticks, link syntax), and result
            // rows show it verbatim — index the plain text instead.
            structuredData: {
                ...structuredData,
                contents: structuredData.contents.map((content) =>
                    /[*_`[\]<>\\~]/.test(content.content)
                        ? {
                              ...content,
                              content: mdastToString(
                                  markdownParser.parse(content.content),
                              ),
                          }
                        : content,
                ),
            },
            locale: page.locale,
            ...(crumbs ?? {
                breadcrumbs: path
                    ? [
                          tree.name,
                          ...path.slice(0, -1).map((node) => node.name),
                      ].filter(
                          (name): name is string =>
                              typeof name === "string" && name.length > 0,
                      )
                    : undefined,
            }),
        }
    })
    const server = createSearchAPI("advanced", {
        // Locale-aware tokenization/stemming: an es index built with
        // English stemming misses inflected Spanish queries (review
        // finding). Tags outside Orama's supported set keep the English
        // tokenizer — still substring-capable, never a crash.
        // https://docs.orama.com/docs/orama-js/supported-languages
        language:
            ORAMA_LANGUAGES[(ctx.activeLocale ?? "en").split("-")[0] ?? "en"] ??
            "english",
        indexes,
    })
    // Resolve once the index exists, and surface a failed build as this
    // build's rejection (dropped from the memo, retried next request)
    // instead of an unhandled one.
    await server.search("", { limit: 1 })
    return server
}

/**
 * THE single URL normalizer. Accepts a full URL, a root-served docs path, a `.md`
 * path, a raw splat string, or a slug array, and returns canonical slugs.
 * Strips the docs base, query/fragment, a trailing `.md`, and a trailing
 * `index`. Every agent surface (.md route, MCP read_page, sitemap, feedback)
 * resolves URLs through here, so they all accept the same forms — this fixes
 * the "read_page rejects .md URLs" bug documented in AGENT-SURFACE-ANALYSIS.md.
 *
 * A full URL or a root-relative path is a public one: under a base path
 * (`base`, default the request's) it loses the prefix, as the request path
 * does in server.ts. A route splat ("guides/x", no leading slash) is already
 * internal and is never stripped.
 */
export function normalizeDocUrl(
    input: string | string[],
    base: string = basePath(),
): string[] {
    let path = Array.isArray(input) ? input.join("/") : input
    if (/^https?:\/\//i.test(path)) {
        try {
            path = new URL(path).pathname
        } catch {
            // not a parseable URL — fall through and treat as a path
        }
    }
    path = path.split("#")[0].split("?")[0]
    if (path.startsWith("/")) path = stripBase(path, base) ?? path
    const segs = path.split("/").filter((s) => s.length > 0)
    if (segs.length === 0) return []
    segs[segs.length - 1] = segs[segs.length - 1].replace(/\.md$/, "")
    if (segs[segs.length - 1] === "index") segs.pop()
    return segs
}

/**
 * Single content-resolution choke-point: returns the fumadocs-processed
 * markdown. Every surface reads through here.
 */
export function resolveAgentText(page: DocPage): Promise<string> {
    return page.data.getText("processed")
}

function readingTimeMinutes(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, Math.round(words / 200))
}

/**
 * Compact, machine-readable per-page signals injected at the top of the agent
 * markdown (gated by agentConfig.signals). Goes through getLLMText so the .md
 * route, llms-full, MCP read_page, and the context bundle all carry the same
 * signals; the human HTML render never sees them.
 */
function signalsBlock(ctx: DocsContext, page: DocPage, body: string): string {
    const cfg = agentConfig.signals
    const meta: string[] = []
    if (cfg.readingTime)
        meta.push(`reading_time_min: ${readingTimeMinutes(body)}`)
    if (cfg.tokens) meta.push(`est_tokens: ${Math.ceil(body.length / 4)}`)
    if (cfg.freshness) {
        meta.push(
            `updated: ${page.data.lastModified.toISOString().slice(0, 10)}`,
        )
    }

    const lines: string[] = []
    if (meta.length) lines.push(`<!-- agent-signals: ${meta.join(" · ")} -->`)
    if (cfg.related) {
        const related = relatedPages(ctx, page, 6)
        if (related.length) {
            lines.push(
                `Related: ${related.map((r) => `[${r.title}](${r.markdownUrl})`).join(", ")}`,
            )
        }
    }
    return lines.length ? `${lines.join("\n")}\n\n` : ""
}

/**
 * Canonical agent markdown for one page: title + URL header + signals +
 * resolved body. `preloadedBody` lets bulk assemblers (llms-full) hand in a
 * chunk-fetched processed body instead of paying one query per page; the
 * formatting stays identical either way.
 */
export async function getLLMText(
    ctx: DocsContext,
    page: DocPage,
    preloadedBody?: string,
): Promise<string> {
    const body = preloadedBody ?? (await resolveAgentText(page))
    const pointer = externalPointer(page)
    // The HTML route redirects an external pointer off-site; the agent
    // rendition names the destination instead of leaving a dead stub.
    const pointerLine = pointer
        ? `This page points to an external site: <${pointer}>\n\n`
        : ""
    // Stored links are root-relative; under a base path they get it here.
    const base = basePath()
    return `# ${page.data.pageTitle} (${withBase(page.url, base)})\n\n${withBaseInMarkdown(
        `${pointerLine}${signalsBlock(ctx, page, body)}${body}${siteInstructionsBlock(ctx)}`,
        base,
    )}`
}

/**
 * Frontmatter `url`: the page is an external pointer — its HTML
 * route answers 307 to this URL ($.tsx). Null for ordinary pages. Its
 * agent rendition names the destination, and the XML sitemap drops the
 * page (a sitemap lists only URLs that answer 200).
 */
export function externalPointer(page: DocPage): string | null {
    const pointer = page.data.frontmatter.url
    if (
        typeof pointer !== "string" ||
        !/^https?:\/\//i.test(pointer) ||
        !isAllowedUrl(pointer)
    )
        return null
    // Normalized, with the characters that end a Markdown link destination
    // or autolink percent-encoded: the agent surfaces write it raw into
    // `[text](url)` and `<url>`, where `a)b` would cut the link at `a`.
    return new URL(pointer).href.replace(
        /[()<>]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
}

export function siteInstructionsBlock(ctx: DocsContext): string {
    const instructions = ctx.config?.markdown?.instructions
    if (!instructions) return ""
    const lines =
        typeof instructions === "string" ? [instructions] : instructions
    return `\n\n## Site instructions\n\n${lines.join("\n\n")}`
}

interface NavDerivations {
    /** Indexable pages in docs.json navigation order, then the indexable
     * pages the navigation does not list, in page-tree order. */
    ordered: DocPage[]
    /** Ancestor trail per page URL: tab, then the authored group titles. */
    crumbs: Map<string, TreeCrumb[]>
    /** Authored section per page URL: "Tab › Group" when the site has
     * several tabs, else the top-level group (or the tab). Missing labels
     * use the current request's identity, never a memoized registry name. */
    sections: Map<string, string | undefined>
}

/** Keyed by the request's loader, like treeDerivations: the loader is
 * memoized per (version, locale, version label), and the navigation it is
 * walked against comes from the same immutable version + locale. */
const navDerivationsMemo = new WeakMap<SiteSource, NavDerivations>()

/**
 * The agent indexes' view of docs.json navigation (spec §9.2: navigation is
 * authoritative). The merged fumadocs tree is built from file paths plus a
 * lossy meta merge — alphabetical groups, folder names like "Cli", every
 * root page lumped under the site — so, like the search index's
 * breadcrumbs, the order and labels come from the ingest-resolved tabs
 * (`__resolvedNav`). Sites without tabs, and pages the navigation does not
 * list, keep the page tree's order and folder crumbs.
 */
function navDerivations(ctx: DocsContext): NavDerivations {
    const cached = navDerivationsMemo.get(ctx.source)
    if (cached) return cached
    const tree = treeDerivations(ctx.source)
    const nav = ctx.config?.__resolvedNav
    const tabs = [...(nav?.tabs ?? []), ...(nav?.global?.tabs ?? [])]
    const byPath = new Map(
        ctx.allPages.map((page) => [page.data.sourcePath, page]),
    )
    // Ingest resolves an external-pointer page (frontmatter `url`) to an
    // href entry, so the sidebar links out; it keeps that place here.
    // Keyed by the RAW frontmatter URL, the spelling ingest stores as the
    // entry's href; externalPointer's escaped form is for writing links.
    const byPointer = new Map<string, string>()
    for (const page of ctx.allPages) {
        const raw = page.data.frontmatter.url
        if (
            typeof raw === "string" &&
            externalPointer(page) !== null &&
            !byPointer.has(raw)
        )
            byPointer.set(raw, page.data.sourcePath)
    }
    const ordered: DocPage[] = []
    const crumbs = new Map<string, TreeCrumb[]>()
    const sections = new Map<string, string | undefined>()
    const claim = (path: string, trail: TreeCrumb[]) => {
        const page = byPath.get(path)
        if (!page || crumbs.has(page.url)) return
        crumbs.set(page.url, trail)
        sections.set(
            page.url,
            (tabs.length > 1 ? trail.slice(0, 2) : trail.slice(1, 2))
                .map((crumb) => crumb.name)
                .join(" › ") || trail[0]?.name,
        )
        if (isPageIndexable(ctx, page)) ordered.push(page)
    }
    const walk = (group: ResolvedTabGroup, trail: TreeCrumb[]) => {
        // A group's landing page sits in the group's place, without the
        // group as its own ancestor (the folder-index rule of the tree).
        if (group.root) claim(group.root, trail)
        const inner = group.title
            ? [
                  ...trail,
                  {
                      name: group.title,
                      url: group.root ? byPath.get(group.root)?.url : undefined,
                  },
              ]
            : trail
        for (const entry of group.entries) {
            if ("page" in entry) claim(entry.page, inner)
            else if ("group" in entry) walk(entry.group, inner)
            else {
                const path = byPointer.get(entry.href)
                if (path) claim(path, inner)
            }
        }
    }
    for (const tab of tabs) {
        const trail: TreeCrumb[] = [{ name: tab.tab, url: tab.resolvedHref }]
        for (const group of tab.resolvedGroups ?? []) walk(group, trail)
        // Mega-menu items carry their own sections; an untitled one takes
        // the item's label.
        for (const item of tab.menu ?? [])
            for (const group of item.resolvedGroups ?? [])
                walk({ ...group, title: group.title ?? item.item }, trail)
        // Membership the structure does not spell out (an OpenAPI-only
        // group resolves no entries) still belongs to the tab.
        for (const path of tab.resolvedPages ?? []) claim(path, trail)
    }
    for (const page of tree.ordered(ctx)) {
        if (crumbs.has(page.url)) continue
        const trail = tree.crumbs.get(page.url) ?? []
        crumbs.set(page.url, trail)
        sections.set(page.url, trail[0]?.name)
        ordered.push(page)
    }
    const derivations = { ordered, crumbs, sections }
    navDerivationsMemo.set(ctx.source, derivations)
    return derivations
}

/** Indexable pages in navigation order (docs.json when it has tabs, else
 * the sidebar tree), never filesystem-alphabetical. */
export function orderedPages(ctx: DocsContext): DocPage[] {
    return navDerivations(ctx).ordered
}

/** The section an agent index files a page under (llms.txt, sitemap.md,
 * MCP list_docs / get_navigation). */
export function pageSection(ctx: DocsContext, page: DocPage): string {
    return navDerivations(ctx).sections.get(page.url) ?? ctx.identity.name
}

/**
 * The ordered pages a path-scoped agent file covers: llmstxt.org scopes a
 * file at `/<path>/llms.txt` to the URLs beneath `/<path>`, so the prefix is
 * matched against URL segments (a locale or version segment included).
 */
export function pagesUnder(ctx: DocsContext, prefix: string[]): DocPage[] {
    const pages = orderedPages(ctx)
    if (prefix.length === 0) return pages
    return pages.filter((page) => {
        const segments = page.url.split("/").filter(Boolean)
        return prefix.every((segment, index) => segments[index] === segment)
    })
}

/** Release history: the least instructive pages, demoted last in the corpus
 * and listed under llms.txt's `## Optional` section. */
export function isChangelogPage(ctx: DocsContext, page: DocPage): boolean {
    return (
        /changelog|release[-_ ]?notes/i.test(page.url) ||
        pageBreadcrumbs(ctx, page).some((crumb) =>
            /^(?:changelog|release ?notes|updates|what'?s new)$/i.test(
                crumb.name.trim(),
            ),
        )
    )
}

export interface LlmsFullResult {
    truncated: boolean
    includedCount: number
    pageCount: number
}

/**
 * One shared assembly of the corpus. The job is pure: it pulls chunks into
 * `parts` and settles `result` without ever touching a response, so a
 * requester that disconnects cannot reject the memoized promise or poison
 * the requests that share it. Each consumer streams via its own `chunks()`
 * iterator — what already exists, then each new chunk as it lands.
 */
export interface LlmsFullJob {
    result: Promise<LlmsFullResult>
    chunks: () => AsyncGenerator<string, void>
}

/**
 * Assembled llms-full per (site, version, label, budget) — versions are
 * immutable and every embedded URL is path-relative, so the result is
 * host-independent and safe to share across custom domains. Bounded tighter
 * than the other per-version memos: each entry can hold the full budget.
 * The job is stored synchronously, not through `fetchMethod`: the route
 * streams its chunks while the assembly is still running.
 */
const llmsFullCache = new LRUCache<string, LlmsFullJob>({ max: 8 })

/**
 * Budget + join for the corpus, independent of where page texts come from:
 * yields each page's chunk (with its "\n\n" join separator) until the budget
 * trips, then the truncation marker. The route streams these; buildLlmsFull
 * memoizes the chunks.
 */
export async function* llmsFullChunks(
    texts: AsyncIterable<string> | Iterable<string>,
    maxChars: number = agentConfig.llmsFull.maxChars,
): AsyncGenerator<string, { truncated: boolean; includedCount: number }> {
    // The marker is part of a TRUNCATED response, so its length must fit
    // inside maxChars too — but a complete corpus that merely lands within
    // the marker's width of the ceiling must not be cut for it. One page of
    // lookahead decides: a page is emitted when it fits outright and the
    // corpus either ends after it or still has room for the marker.
    const marker = agentConfig.llmsFull.truncationMarker
    let length = 0
    let includedCount = 0
    let pending: string | null = null
    const iterator: AsyncIterator<string> | Iterator<string> =
        Symbol.asyncIterator in texts
            ? texts[Symbol.asyncIterator]()
            : texts[Symbol.iterator]()
    for (;;) {
        const step = await iterator.next()
        const upcoming = step.done ? null : step.value
        if (pending !== null) {
            const separator = includedCount === 0 ? "" : "\n\n"
            const addition = separator.length + pending.length
            const reserve = upcoming === null ? 0 : marker.length
            if (length + addition + reserve > maxChars) {
                yield marker
                return { truncated: true, includedCount }
            }
            yield separator + pending
            length += addition
            includedCount++
        }
        if (upcoming === null) break
        pending = upcoming
    }
    return { truncated: false, includedCount }
}

/**
 * Drive `llmsFullChunks` once for any number of concurrent consumers. The
 * pump runs to completion regardless of who is listening (the result is
 * memoized), collecting settled chunks and waking waiting iterators after
 * each one; a consumer that stops early just abandons its iterator.
 */
export function shareLlmsFull(
    texts: AsyncIterable<string> | Iterable<string>,
    pageCount: number,
    maxChars: number = agentConfig.llmsFull.maxChars,
): LlmsFullJob {
    const parts: string[] = []
    let settled = false
    let wake: () => void = () => {}
    let next = new Promise<void>((resolve) => {
        wake = resolve
    })
    const notify = () => {
        wake()
        next = new Promise<void>((resolve) => {
            wake = resolve
        })
    }
    const result = (async () => {
        try {
            const generator = llmsFullChunks(texts, maxChars)
            let step = await generator.next()
            while (!step.done) {
                parts.push(step.value)
                notify()
                step = await generator.next()
            }
            // The generator stops pulling once the budget trips, so the
            // remaining chunk loads never run.
            // No joined copy: `parts` already holds the corpus, and every
            // consumer streams it through `chunks()`.
            return {
                truncated: step.value.truncated,
                includedCount: step.value.includedCount,
                pageCount,
            }
        } finally {
            settled = true
            notify()
        }
    })()
    return {
        result,
        chunks: async function* () {
            let index = 0
            for (;;) {
                while (index < parts.length) {
                    const part = parts[index++]
                    if (part !== undefined) yield part
                }
                if (settled) {
                    // Surface an assembly failure to this consumer too.
                    await result
                    return
                }
                await next
            }
        },
    }
}

/**
 * Budget-capped, sidebar-ordered full corpus. Replaces the unbounded
 * `getPages().map(getLLMText).join()` so a large site can never emit a
 * context-blowing multi-MB file (AGENT-SURFACE-ANALYSIS.md's #1 flaw).
 * Bodies load in tree-ordered CHUNKS only until the budget trips — a
 * 5,000-page site never pulls megabytes of markdown to emit a capped file.
 * Returns the shared job: the streaming route iterates `chunks()`; a
 * concurrent or later request joins the same assembly.
 */
export function buildLlmsFull(
    ctx: DocsContext,
    maxChars: number = agentConfig.llmsFull.maxChars,
    prefix: string[] = [],
): LlmsFullJob {
    const key = `${ctx.site.id}:${ctx.versionId ?? "none"}:${ctx.activeLocale ?? ""}:${ctx.activeVersion(prefix) ?? ""}:${prefix.join("/")}:${maxChars}:${basePath()}`
    let cached = llmsFullCache.get(key)
    if (!cached) {
        // Changelog / Update pages LAST: they are the longest, least
        // instructive part of a corpus, and a budget that trips should drop
        // release history before it drops guides and reference.
        const ordered = pagesUnder(ctx, prefix)
        const pages = [
            ...ordered.filter((page) => !isChangelogPage(ctx, page)),
            ...ordered.filter((page) => isChangelogPage(ctx, page)),
        ]
        const CHUNK = 200
        const texts = (async function* () {
            for (let start = 0; start < pages.length; start += CHUNK) {
                const chunk = pages.slice(start, start + CHUNK)
                const bodies = ctx.versionId
                    ? await processedMarkdownForPages(
                          ctx.versionId,
                          chunk.map((page) => page.data.sourcePath),
                      )
                    : new Map<string, string>()
                for (const page of chunk) {
                    const body = bodies.get(page.data.sourcePath)
                    if (body === undefined)
                        throw new Error(
                            `no processed markdown for ${page.data.sourcePath}`,
                        )
                    yield await getLLMText(ctx, page, body)
                }
            }
        })()
        const job = shareLlmsFull(texts, pages.length, maxChars)
        // Never memoize a transient failure — evict so the next request
        // rebuilds (and keep the rejection handled when no consumer awaits),
        // unless a newer job already took the slot.
        job.result.catch(() => {
            if (llmsFullCache.peek(key) === job) llmsFullCache.delete(key)
        })
        llmsFullCache.set(key, job)
        cached = job
    }
    return cached
}

/**
 * Identity validator for the agent surfaces (.md, context bundle): content is
 * immutable per (version, source path), and the rest of the agent text
 * (signals, related pages, site instructions) is a function of the same
 * version plus the build and the site's URL (`siteUrl`: public origin and
 * base path, which name every link the body carries and change without a
 * new version when a domain is attached), so a 304 needs no body read.
 * Weak like the HTML ETag, so CDN re-encoding cannot invalidate it;
 * percent-encoded because header values must stay Latin-1 and a quote
 * would end the tag.
 */
export function pageEtag(
    ctx: DocsContext,
    page: DocPage,
    siteUrl: string,
): string {
    return `W/"${encodeURI(
        [
            env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
            siteUrl,
            ctx.versionId ?? "none",
            createHash("sha256")
                .update(JSON.stringify(ctx.identity))
                .digest("hex")
                .slice(0, 32),
            ctx.activeLocale ?? "",
            ctx.activeVersion(page.slugs) ?? "",
            page.data.sourcePath,
        ].join("."),
    )}"`
}

/**
 * The HTML document's validator: everything that shapes it — build, content
 * version, locale, URL and the rendered star count (the one value that
 * changes independently of the content version). The page loader stamps it
 * and the `/$` GET handler answers a matching If-None-Match before any
 * loader work, so both must build it here.
 */
export function htmlPageEtag(
    ctx: DocsContext,
    page: DocPage,
    githubStars: number | null,
    /** The site's URL (public origin and base path): the document's
     * canonical and alternate links and its page data name it. */
    siteUrl: string,
): string {
    return `W/"${encodeURI(
        [
            env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
            siteUrl,
            ctx.versionId ?? "none",
            createHash("sha256")
                .update(JSON.stringify(ctx.identity))
                .digest("hex")
                .slice(0, 32),
            ctx.activeLocale ?? "",
            githubStars ?? "-",
            page.url,
        ].join("."),
    )}"`
}

/**
 * Negotiation choke-point: Accept-based preference (no User-Agent sniffing) plus
 * an explicit `?format=markdown` override. Used by the request middleware and
 * the .md route so negotiation logic lives in exactly one place.
 */
export function wantsMarkdown(request: Request): boolean {
    const format = new URL(request.url).searchParams.get("format")
    if (format === "markdown" || format === "md") return true
    return isMarkdownPreferred(request)
}

export interface PageRef {
    title: string
    url: string
    markdownUrl: string
}

function pageRef(page: DocPage): PageRef {
    return {
        title: page.data.pageTitle,
        url: page.url,
        // An external pointer's twin is a stub: link where it points.
        markdownUrl:
            externalPointer(page) ?? slugsToMarkdownPath(page.slugs).url,
    }
}

/** Breadcrumb trail with REAL ancestor titles (never title-cased slugs), excluding the page itself. */
export function pageBreadcrumbs(ctx: DocsContext, page: DocPage): TreeCrumb[] {
    return (
        navDerivations(ctx).crumbs.get(page.url) ??
        treeDerivations(ctx.source).crumbs.get(page.url) ??
        []
    )
}

/** Sibling + previous/next pages — an explicit traversal graph for multi-hop retrieval. */
export function relatedPages(
    ctx: DocsContext,
    page: DocPage,
    limit = 8,
): PageRef[] {
    const source = ctx.source
    const tree = source.getPageTree()
    const refs = new Map<string, PageRef>()
    const add = (
        item: Parameters<typeof source.getNodePage>[0] | undefined,
    ) => {
        if (!item) return
        const related = source.getNodePage(item)
        if (related && related.url !== page.url)
            refs.set(related.url, pageRef(related))
    }
    for (const peer of getPageTreePeers(tree, page.url)) add(peer)
    const neighbour = findNeighbour(tree, page.url)
    add(neighbour.previous)
    add(neighbour.next)
    return Array.from(refs.values()).slice(0, limit)
}

function levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp = Array.from({ length: m + 1 }, (_, i) => i)
    for (let j = 1; j <= n; j++) {
        let prev = dp[0]
        dp[0] = j
        for (let i = 1; i <= m; i++) {
            const tmp = dp[i]
            dp[i] =
                a[i - 1] === b[j - 1]
                    ? prev
                    : 1 + Math.min(prev, dp[i], dp[i - 1])
            prev = tmp
        }
    }
    return dp[m]
}

function similarity(a: string, b: string): number {
    if (!a || !b) return 0
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

/**
 * Closest matching pages for an unresolved slug path — powers recovery-oriented
 * 404s. Scores the whole path, the title, and length-weighted per-segment
 * matches, so a typo'd section (`/deploymnts`, `/api/deploymnts`) surfaces the
 * pages under `/deployments/…` that a whole-path comparison ranks below short
 * unrelated slugs; whole-path similarity breaks ties.
 */
export function suggestClosestPages(
    ctx: DocsContext,
    slugs: string[],
    limit = 5,
): (PageRef & { description: string | undefined })[] {
    const target = slugs.join("/").toLowerCase()
    const targetSegments = slugs.map((slug) => slug.toLowerCase())
    const scored = target
        ? ctx.source
              .getPages()
              .map((page) => {
                  const path = page.slugs.join("/").toLowerCase()
                  const pathScore = similarity(target, path)
                  // Each requested segment's best match, weighted by its
                  // length: a shared short prefix (`/api/…`) can't outscore
                  // the long typo'd segment that names what was wanted.
                  let weighted = 0
                  let totalLength = 0
                  for (const want of targetSegments) {
                      let best = 0
                      for (const have of page.slugs)
                          best = Math.max(
                              best,
                              similarity(want, have.toLowerCase()),
                          )
                      weighted += best * want.length
                      totalLength += want.length
                  }
                  const segmentScore = weighted / totalLength
                  return {
                      page,
                      pathScore,
                      score: Math.max(
                          pathScore,
                          segmentScore,
                          similarity(target, page.data.pageTitle.toLowerCase()),
                      ),
                  }
              })
              .sort((a, b) => b.score - a.score || b.pathScore - a.pathScore)
              .map((entry) => entry.page)
        : orderedPages(ctx)
    return scored.slice(0, limit).map((page) => ({
        ...pageRef(page),
        description: page.data.description || undefined,
    }))
}

/**
 * Reachability-accurate discovery manifest: lists only surfaces whose flag is on
 * AND that have content to serve. Origin is taken from the live request so the
 * manifest is correct on any host. Never emits disabled endpoints.
 */
export function buildLlmsManifest(
    siteUrl: string,
    ctx: DocsContext,
    hasSpecs: boolean,
) {
    const hasContent = ctx.source.getPages().length > 0
    const s = agentConfig.surfaces
    const sample = orderedPages(ctx)[0]
    // The bundle's example needs a real slug: the root page's empty one
    // reads as a malformed `/api/agent/context/` URL.
    const bundleSample = orderedPages(ctx).find((page) => page.slugs.length > 0)
    const surfaces: Record<string, unknown> = {}

    if (s.markdown && hasContent)
        surfaces.markdownRoutes = {
            pattern: `${siteUrl}${docsRoute}/{slug}.md`,
            example: sample
                ? siteUrl + slugsToMarkdownPath(sample.slugs).url
                : undefined,
            contentType: "text/markdown",
            negotiation:
                "Append .md to any docs URL, send Accept: text/markdown, or add ?format=markdown.",
        }
    if (s.llms && hasContent)
        surfaces.llms = {
            url: `${siteUrl}/llms.txt`,
            wellKnown: `${siteUrl}/.well-known/llms.txt`,
            // llmstxt.org path scoping: the index of the pages beneath any
            // path — a locale, a version, a section. Large indexes split
            // into sub-indexes under `/_llms/`.
            scoped: `${siteUrl}/{path}/llms.txt`,
        }
    if (s.llmsFull && hasContent)
        surfaces.llmsFull = {
            url: `${siteUrl}/llms-full.txt`,
            // The corpus budget the route enforces; the doctor verifies the
            // served body against this advertised ceiling.
            maxChars: agentConfig.llmsFull.maxChars,
        }
    if (s.search)
        surfaces.search = {
            url: `${siteUrl}/api/search?query={query}`,
            resultShape: "SortedResult[]",
        }
    if (s.contextBundle && hasContent)
        surfaces.contextBundle = {
            pattern: `${siteUrl}/api/agent/context/{slug}`,
            example: bundleSample
                ? `${siteUrl}/api/agent/context/${bundleSample.slugs.join("/")}`
                : undefined,
            description:
                "One JSON fetch: markdown + headings + related pages + breadcrumbs + etag.",
        }
    if (s.mcp)
        surfaces.mcp = {
            url: `${siteUrl}/api/mcp`,
            transport: "streamable-http",
            serverCard: `${siteUrl}/api/mcp/server-card`,
            aiCatalog: `${siteUrl}/.well-known/ai-catalog.json`,
        }
    if (hasSpecs)
        surfaces.apiCatalog = {
            url: `${siteUrl}/.well-known/api-catalog`,
            contentType: "application/linkset+json",
        }
    if (s.sitemap && hasContent)
        surfaces.sitemap = {
            xml: `${siteUrl}/sitemap.xml`,
            markdown: `${siteUrl}/sitemap.md`,
        }
    if (s.changes) surfaces.changes = { url: `${siteUrl}/changes.md` }
    if (s.feedback)
        surfaces.feedback = {
            url: `${siteUrl}/api/agent/feedback`,
            schemaUrl: `${siteUrl}/api/agent/feedback?schema`,
        }
    if (s.skill)
        surfaces.skill = {
            url: `${siteUrl}/skill.md`,
            agents: `${siteUrl}/AGENTS.md`,
            index: `${siteUrl}/.well-known/agent-skills/index.json`,
            legacyIndex: `${siteUrl}/.well-known/skills/index.json`,
            install: `npx skills add ${siteUrl}`,
        }

    return {
        name: ctx.identity.name,
        specVersion: agentConfig.discovery.version,
        generator: "fumadocs-tanstack-agent-surface",
        docs: "https://llmstxt.org",
        instructions: {
            preferMarkdownRoutes: true,
            markdownSuffix: ".md",
            useMcpWhenAvailable: s.mcp,
        },
        surfaces,
    }
}

export { slugsToMarkdownPath }
