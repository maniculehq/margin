/**
 * Server-side rendering of compiled site MDX (kind="js" bodies) inside a V8
 * isolate with no host access.
 *
 * The isolate (isolated-vm) receives exactly one thing: the self-contained
 * render bundle built from src/sandbox/render.tsx. Nothing is set on its
 * global — no `process`, `require`, `fetch`, timers, or DOM — so site
 * expressions can compute markup and nothing else. Each render gets a fresh
 * context (site globals never outlive one page), a 250 ms wall-clock
 * budget, the isolate's 128 MB heap cap, and a 2 MB ceiling on the HTML that
 * may leave the isolate; a blown limit surfaces as a typed failure so
 * routes/$.tsx keeps today's client-only path instead of failing the page.
 * Content versions are immutable, so the outcome is memoized per (version,
 * page): rendered HTML and the deterministic failures (timeout, throw,
 * oversized, memory) alike — a page that threw once throws again, and
 * re-running it would only burn another 250 ms per request. A memory kill is
 * memoized too, because it is the most expensive failure to repeat: it
 * disposes the shared isolate, so the offending page is quarantined after
 * ONE kill instead of tearing the isolate down on every request. Only the
 * transient failure (native addon unavailable) is never memoized.
 *
 * Renders are serialized through the shared isolate (one at a time; a
 * render costs ~17 ms) and coalesced per cache key, so a heap exhaustion
 * that disposes the isolate fails only the page that caused it — never an
 * unrelated render mid-flight — and concurrent cold misses for the same page
 * evaluate once. The trade-off is throughput: N concurrent distinct pages
 * queue behind each other instead of racing in the same 128 MB heap, where a
 * kill would take all of them down and a per-render isolate (the only true
 * isolation) costs far more than the render itself.
 */

import bundle from "virtual:sandbox-render-bundle"
import type { RootContent } from "hast"
import { fromHtml } from "hast-util-from-html"
import { toHtml } from "hast-util-to-html"
import type ivm from "isolated-vm"
import { LRUCache } from "lru-cache"
import type { RootContent as MdastContent, PhrasingContent, Root } from "mdast"
import {
    foreignContent,
    html as parse5Html,
    Tokenizer,
    TokenizerMode,
} from "parse5"
import { find, html as htmlSchema } from "property-information"
import rehypeSanitize from "rehype-sanitize"
import { remark } from "remark"
import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import remarkRehype from "remark-rehype"
import { visit } from "unist-util-visit"
import { z } from "zod"
import { DENIED_INTRINSICS, URL_BEARING_ATTRIBUTES } from "../ingest/validate"
import { isAllowedUrl } from "../types/docs"
import { evaluateStaticMdxExpression } from "../types/docs-hast"
import { withBase } from "./base-path"
import { emitEvent } from "./observability"

export type SandboxRenderResult =
    | { ok: true; html: string }
    | {
          ok: false
          reason: "timeout" | "memory" | "throw" | "unavailable" | "oversized"
          message: string
      }

export const SANDBOX_RENDER_TIMEOUT_MS = 250
export const SANDBOX_MEMORY_LIMIT_MB = 128
/** Longest HTML string (UTF-16 code units, ~bytes for markup) that may be
 * copied out of the isolate; longer output fails as `oversized` inside it. */
export const SANDBOX_MAX_HTML_BYTES = 2 * 1024 * 1024
/** Host-memory budget of the memo across all entries (HTML plus failures), in UTF-8 bytes. */
export const SANDBOX_CACHE_MAX_BYTES = 64 * 1024 * 1024
const CACHE_ENTRIES = 500
/** Deepest element nesting the host parses when sanitizing isolate output;
 * real articles nest a few dozen levels. */
export const SANDBOX_MAX_HTML_DEPTH = 512
/** HTML elements whose end tags the parser generates implicitly. */
type TokenizerState = (typeof TokenizerMode)[keyof typeof TokenizerMode]
/** Start tags the parser handles by its table insertion modes. */
const TABLE_PARTS: ReadonlySet<string> = new Set([
    "caption",
    "col",
    "colgroup",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
])
/** End tags whose table-mode handling pops through table structure. */
const TABLE_END_TAGS: ReadonlySet<string> = new Set([
    "caption",
    "colgroup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
])
const IMPLIED_END_TAGS: ReadonlySet<string> = new Set([
    "dd",
    "dt",
    "li",
    "optgroup",
    "option",
    "p",
    "rb",
    "rp",
    "rt",
    "rtc",
])
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
])
/** A memoized failure is a few object slots and a short message. */
const FAILURE_ENTRY_BYTES = 64

const sandboxOutputSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("html"), html: z.string() }),
    z.object({ kind: z.literal("oversized"), length: z.number() }),
])

let evaluations = 0
let runtime: Promise<{ isolate: ivm.Isolate; script: ivm.Script }> | undefined
/** Tail of the render queue: every isolate evaluation chains onto it so the
 * shared isolate runs one render at a time. */
let queue: Promise<unknown> = Promise.resolve()

interface SandboxRenderInput {
    compiledJs: string
    pageUrl: string
    /** The site's base path: links and asset URLs in the snapshot carry
     * it, as they do after hydration. Omitted: the domain root. */
    basePath?: string
    /** `${versionId}:${pageId}:${basePath}` — versions are immutable, so
     * everything else that shapes the output (compiled body, docs.json
     * variations) is fixed by the version half of the key. */
    cacheKey: string
    /** docs.json `variations.options` (per-version config, covered by
     * cacheKey): the isolate wraps the article in the same VariationsProvider
     * the route does, so a ViewGroup snapshot shows the configured default
     * view. JSON-serializable; copied into the isolate. */
    variations: readonly { id: string; label: string }[] | null
    /** Locale tag of the page (fixed by the page, so covered by cacheKey):
     * article components read chrome copy for it, as under the root route.
     * Omitted: English. */
    locale?: string
    /** Request the render serves — the ssr_sandbox_failed event rides it.
     * Coalesced callers share the first caller's event. */
    request: Request
}

/** LRU keyed `${versionId}:${pageId}`, bounded by both the entry count and
 * the byte budget. `fetchMethod` coalesces cold misses per key: a second
 * caller for the same key awaits the first render instead of evaluating
 * (and inserting) twice. */
const memo = new LRUCache<string, SandboxRenderResult, SandboxRenderInput>({
    max: CACHE_ENTRIES,
    maxSize: SANDBOX_CACHE_MAX_BYTES,
    // LRUCache sizes must be positive, and an empty render is still an entry.
    sizeCalculation: (result) =>
        result.ok
            ? Math.max(1, Buffer.byteLength(result.html, "utf8"))
            : FAILURE_ENTRY_BYTES + Buffer.byteLength(result.message, "utf8"),
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: input }) => {
        let result: SandboxRenderResult
        // Serialize through the shared isolate (see the module comment): the
        // turn settles either way, so a failed render never blocks the queue.
        let siteStage = false
        const turn = queue.then(async (): Promise<SandboxRenderResult> => {
            // Lazy: the native addon loads on first use, so a host without the
            // prebuilt binary degrades to the client-only path rather than
            // failing module init for every route.
            const { default: isolatedVm } = await import("isolated-vm")
            // One isolate per function instance; a memory-limit kill disposes
            // it, so rebuild (and recompile the bundle) when that happened. A
            // failed construction/compile clears the memo so the next request
            // retries instead of inheriting the rejection for the instance's life.
            if (runtime === undefined || (await runtime).isolate.isDisposed) {
                const building = (async () => {
                    const isolate = new isolatedVm.Isolate({
                        memoryLimit: SANDBOX_MEMORY_LIMIT_MB,
                    })
                    const script = await isolate.compileScript(bundle, {
                        filename: "sandbox-render.js",
                    })
                    return { isolate, script }
                })()
                runtime = building
                building.catch(() => {
                    if (runtime === building) runtime = undefined
                })
            }
            const { isolate, script } = await runtime
            const context = await isolate.createContext()
            try {
                evaluations += 1
                await script.run(context, {
                    timeout: SANDBOX_RENDER_TIMEOUT_MS,
                })
                // Everything above is our toolchain (addon, isolate, bundle).
                // From here the isolate runs site code, so a thrown Error
                // is the site's — classified by this stage marker, never by
                // attacker-controlled message text.
                siteStage = true
                const output = sandboxOutputSchema.parse(
                    await context.evalClosure(
                        "return __renderMdx($0, $1, $2, $3, $4, $5)",
                        [
                            input.compiledJs,
                            input.pageUrl,
                            SANDBOX_MAX_HTML_BYTES,
                            input.variations,
                            input.locale ?? null,
                            input.basePath ?? "",
                        ],
                        {
                            timeout: SANDBOX_RENDER_TIMEOUT_MS,
                            arguments: { copy: true },
                            result: { copy: true },
                        },
                    ),
                )
                return output.kind === "html"
                    ? { ok: true, html: output.html }
                    : {
                          ok: false,
                          reason: "oversized",
                          message: `rendered ${output.length} chars; limit ${SANDBOX_MAX_HTML_BYTES}`,
                      }
            } finally {
                context.release()
            }
        })
        queue = turn.then(
            () => undefined,
            () => undefined,
        )
        try {
            result = await turn
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            const disposed =
                runtime !== undefined &&
                (await runtime.then(
                    (active) => active.isolate.isDisposed,
                    () => false,
                ))
            result = {
                ok: false,
                reason: !siteStage
                    ? "unavailable"
                    : disposed
                      ? "memory"
                      : /^Script execution timed out\.?$/i.test(message)
                        ? "timeout"
                        : "throw",
                message: message.slice(0, 500),
            }
        }
        if (result.ok) {
            // INV-2 / §4.6 at the server boundary. The ingest AST pass only
            // sees page MDX: snippet modules, page-local exports, computed
            // attributes and dangerouslySetInnerHTML produce markup it never
            // checks. So the isolate's HTML is parsed (as the browser would
            // parse the snapshot slot) and held to the same rules, from the
            // same constants: denied elements dropped with their content,
            // on* and srcdoc attributes removed, URL-bearing attributes kept
            // only when isAllowedUrl admits every value, iframes kept only
            // with an https src. One addition: React's own
            // <link rel="preload" as="image"> hint for the eager article
            // image (ArticleImages) survives, since an image preload neither
            // executes nor styles anything; every other <link> is dropped.
            // Sanitized once per (version, page): the memo holds the result.
            // Parsing is superlinear in nesting depth and the parser, walk
            // and serializer all recurse, so depth is bounded first, in
            // linear time and without building a tree: parse5's own HTML5
            // tokenizer, so comments, CDATA, raw text (script, style...)
            // and RCDATA (title, textarea) are tokenized as the parser will
            // and never yield tags. On top of the tokens, an upper bound on
            // the parser's stack of open elements:
            // - a start tag opens an element, except void elements and
            //   self-closed foreign (SVG/MathML) ones; HTML start tags that
            //   the parser ignores or that implicitly close something only
            //   overcount;
            // - a start tag p/li/dd/dt/option closes the same element when
            //   it is the current one, exactly as the parser does;
            // - an end tag closes up to its matching element only through
            //   elements the parser also pops on the way: foreign elements
            //   while in foreign content, then only implied-end-tag HTML
            //   elements (p, li, dd...). Anything else, or no match, closes
            //   nothing, though the parser might pop more: overcounting;
            // - foreign content is entered and left as the parser does it
            //   (svg/math roots, integration points, parse5's causesExit
            //   breakout tags, a stray </p> or </br>).
            // Every pop here is a pop the parser makes too, so the bound can
            // only overcount, which fails closed. Too deep, or any other
            // sanitizer failure, is the page's: memoized like a throw, and
            // served the declined fallback.
            try {
                const html = result.html
                const open: {
                    name: string
                    ns: parse5Html.NS
                    point: boolean
                }[] = []
                const inForeign = () => {
                    const top = open.at(-1)
                    return (
                        top !== undefined &&
                        top.ns !== parse5Html.NS.HTML &&
                        !top.point
                    )
                }
                const leaveForeign = () => {
                    while (inForeign()) open.pop()
                }
                const HTML = parse5Html.NS.HTML
                // Nearest open HTML element named in `names`, scanning down
                // from the current node; -1 at an HTML element in `stops`
                // first (scope boundaries) or at the bottom.
                const nearest = (
                    names: readonly string[],
                    stops: readonly string[],
                ) => {
                    for (let i = open.length - 1; i >= 0; i--) {
                        const node = open[i]
                        if (node?.ns !== HTML) continue
                        if (names.includes(node.name)) return i
                        if (stops.includes(node.name)) return -1
                    }
                    return -1
                }
                const TABLE_SCOPE = ["table", "template", "html"]
                const push = (name: string) => {
                    open.push({ name, ns: HTML, point: false })
                    if (open.length > SANDBOX_MAX_HTML_DEPTH)
                        throw new Error(
                            `markup nests deeper than ${SANDBOX_MAX_HTML_DEPTH} elements`,
                        )
                }
                const textModes: Record<string, TokenizerState> = {
                    title: TokenizerMode.RCDATA,
                    textarea: TokenizerMode.RCDATA,
                    style: TokenizerMode.RAWTEXT,
                    xmp: TokenizerMode.RAWTEXT,
                    iframe: TokenizerMode.RAWTEXT,
                    noembed: TokenizerMode.RAWTEXT,
                    noframes: TokenizerMode.RAWTEXT,
                    // Scripting is on in the parser fromHtml runs.
                    noscript: TokenizerMode.RAWTEXT,
                    script: TokenizerMode.SCRIPT_DATA,
                    plaintext: TokenizerMode.PLAINTEXT,
                }
                const ignore = () => undefined
                const tokenizer: Tokenizer = new Tokenizer(
                    {},
                    {
                        onStartTag(token) {
                            const name = token.tagName
                            if (inForeign() && foreignContent.causesExit(token))
                                leaveForeign()
                            const parent = open.at(-1)
                            const ns =
                                inForeign() && parent
                                    ? parent.ns
                                    : name === "svg"
                                      ? parse5Html.NS.SVG
                                      : name === "math"
                                        ? parse5Html.NS.MATHML
                                        : parse5Html.NS.HTML
                            if (ns === HTML && TABLE_PARTS.has(name)) {
                                // Table insertion modes (parse5's in table /
                                // body / row / cell / caption rules). With no
                                // table or template open the parser ignores
                                // these tags. In a template they insert as
                                // is. In a table they first close the open
                                // cell, row, section or caption as the parser
                                // does, then open the element with any
                                // implied tbody/tr/colgroup above it.
                                const context = nearest(
                                    ["table", "template"],
                                    ["html"],
                                )
                                if (context === -1) return
                                if (open[context]?.name === "template") {
                                    if (name !== "col") push(name)
                                    return
                                }
                                const cell = nearest(["td", "th"], TABLE_SCOPE)
                                if (
                                    (name === "td" ||
                                        name === "th" ||
                                        name === "tr") &&
                                    cell !== -1
                                )
                                    open.length = cell
                                const row = nearest(["tr"], TABLE_SCOPE)
                                if (name === "tr" && row !== -1)
                                    open.length = row
                                const section = nearest(
                                    ["tbody", "thead", "tfoot"],
                                    TABLE_SCOPE,
                                )
                                if (name === "td" || name === "th") {
                                    if (row !== -1) open.length = row + 1
                                    else if (section !== -1) {
                                        open.length = section + 1
                                        push("tr")
                                    } else {
                                        open.length = context + 1
                                        push("tbody")
                                        push("tr")
                                    }
                                } else if (name === "tr") {
                                    if (section !== -1)
                                        open.length = section + 1
                                    else {
                                        open.length = context + 1
                                        push("tbody")
                                    }
                                } else open.length = context + 1
                                if (name === "col") push("colgroup")
                                else push(name)
                                tokenizer.inForeignNode = inForeign()
                                return
                            }
                            if (ns === parse5Html.NS.HTML) {
                                if (VOID_ELEMENTS.has(name)) return
                                if (
                                    parent?.ns === parse5Html.NS.HTML &&
                                    (parent.name === name
                                        ? [
                                              "p",
                                              "li",
                                              "option",
                                              "dd",
                                              "dt",
                                          ].includes(name)
                                        : (name === "dd" || name === "dt") &&
                                          (parent.name === "dd" ||
                                              parent.name === "dt"))
                                )
                                    open.pop()
                                open.push({ name, ns, point: false })
                                const mode = textModes[name]
                                if (mode !== undefined) tokenizer.state = mode
                            } else {
                                if (token.selfClosing) return
                                open.push({
                                    name,
                                    ns,
                                    point: foreignContent.isIntegrationPoint(
                                        token.tagID,
                                        ns,
                                        token.attrs,
                                    ),
                                })
                            }
                            if (open.length > SANDBOX_MAX_HTML_DEPTH)
                                throw new Error(
                                    `markup nests deeper than ${SANDBOX_MAX_HTML_DEPTH} elements`,
                                )
                            tokenizer.inForeignNode = inForeign()
                        },
                        onEndTag(token) {
                            const name = token.tagName
                            if (inForeign() && (name === "p" || name === "br"))
                                leaveForeign()
                            let foreignPhase = inForeign()
                            for (let i = open.length - 1; i >= 0; i--) {
                                const node = open[i]
                                if (!node) break
                                if (
                                    foreignPhase &&
                                    node.ns !== parse5Html.NS.HTML
                                ) {
                                    if (node.name.toLowerCase() === name) {
                                        open.length = i
                                        break
                                    }
                                    continue
                                }
                                foreignPhase = false
                                // Table end tags close through whatever the
                                // parser's table modes pop: </table> back to
                                // its table (inside template-free scope), a
                                // row, section, cell or caption back to
                                // itself within its table, a colgroup only
                                // when current.
                                if (TABLE_END_TAGS.has(name)) {
                                    const index =
                                        name === "colgroup"
                                            ? open.at(-1)?.name ===
                                                  "colgroup" &&
                                              open.at(-1)?.ns === HTML
                                                ? open.length - 1
                                                : -1
                                            : nearest(
                                                  [name],
                                                  name === "table"
                                                      ? ["template", "html"]
                                                      : TABLE_SCOPE,
                                              )
                                    if (index !== -1) open.length = index
                                    break
                                }
                                if (node.name === name) {
                                    open.length = i
                                    break
                                }
                                if (
                                    node.ns !== parse5Html.NS.HTML ||
                                    !IMPLIED_END_TAGS.has(node.name)
                                )
                                    break
                            }
                            tokenizer.inForeignNode = inForeign()
                        },
                        onComment: ignore,
                        onDoctype: ignore,
                        onEof: ignore,
                        onCharacter: ignore,
                        onNullCharacter: ignore,
                        onWhitespaceCharacter: ignore,
                    },
                )
                tokenizer.write(html, true)
                // verbose: attribute source spans, for srcset (below).
                const tree = fromHtml(html, {
                    fragment: true,
                    verbose: true,
                })
                const clean = <T extends RootContent>(nodes: T[]): T[] =>
                    nodes.filter((node) => {
                        if (node.type !== "element") return true
                        const tag = node.tagName.toLowerCase()
                        const { rel, as, src } = node.properties
                        if (
                            tag === "link"
                                ? !(
                                      Array.isArray(rel) &&
                                      rel.length === 1 &&
                                      rel[0] === "preload" &&
                                      as === "image"
                                  )
                                : DENIED_INTRINSICS.has(tag) ||
                                  (tag === "iframe" &&
                                      !(
                                          typeof src === "string" &&
                                          /^https:\/\//i.test(src.trim())
                                      ))
                        )
                            return false
                        for (const [key, value] of Object.entries(
                            node.properties,
                        )) {
                            const attribute = find(
                                htmlSchema,
                                key,
                            ).attribute.toLowerCase()
                            if (
                                /^on/.test(attribute) ||
                                attribute === "srcdoc"
                            ) {
                                delete node.properties[key]
                                continue
                            }
                            if (
                                !URL_BEARING_ATTRIBUTES.has(attribute) &&
                                attribute !== "imagesrcset"
                            )
                                continue
                            if (!attribute.endsWith("srcset")) {
                                if (
                                    (Array.isArray(value)
                                        ? value
                                        : [value]
                                    ).some(
                                        (entry) => !isAllowedUrl(String(entry)),
                                    )
                                )
                                    delete node.properties[key]
                                continue
                            }
                            // srcset: the parser split the decoded list at
                            // every comma, but a candidate URL may contain
                            // commas, and the split loses which commas
                            // separated candidates. Re-read the attribute's
                            // own source (its value re-decoded as a plain
                            // attribute) by HTML's rules: a URL is a run of
                            // non-whitespace whose trailing commas end it,
                            // else descriptors run to the next comma. Every
                            // candidate's URL must pass; the list is kept
                            // exactly as authored.
                            const span = node.data?.position?.properties?.[key]
                            const source =
                                span?.start.offset !== undefined &&
                                span.end.offset !== undefined
                                    ? html.slice(
                                          span.start.offset,
                                          span.end.offset,
                                      )
                                    : null
                            const reread =
                                source === null
                                    ? null
                                    : fromHtml(
                                          `<i data-srcset=${source.includes("=") ? source.slice(source.indexOf("=") + 1) : '""'}>`,
                                          { fragment: true },
                                      ).children[0]
                            const list =
                                reread?.type === "element" &&
                                typeof reread.properties.dataSrcset === "string"
                                    ? reread.properties.dataSrcset
                                    : null
                            const urls: string[] = []
                            let rest = list ?? ""
                            for (;;) {
                                rest = rest.replace(/^[\s,]+/, "")
                                const url = /^\S+/.exec(rest)?.[0]
                                if (!url) break
                                rest = rest.slice(url.length)
                                urls.push(url.replace(/,+$/, ""))
                                if (!url.endsWith(","))
                                    rest = rest.slice(
                                        rest.includes(",")
                                            ? rest.indexOf(",") + 1
                                            : rest.length,
                                    )
                            }
                            if (
                                list === null ||
                                urls.some((url) => !isAllowedUrl(url))
                            )
                                delete node.properties[key]
                            else node.properties[key] = list
                        }
                        node.children = clean(node.children)
                        if (node.content)
                            node.content.children = clean(node.content.children)
                        return true
                    })
                tree.children = clean(tree.children)
                result = { ok: true, html: toHtml(tree) }
            } catch (error) {
                result = {
                    ok: false,
                    reason: "throw",
                    message:
                        `server-output sanitization failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                            0,
                            500,
                        ),
                }
            }
        }
        if (!result.ok) {
            emitEvent(input.request, {
                type: "ssr_sandbox_failed",
                reason: result.reason,
                message: result.message,
                route: input.pageUrl,
            })
        }
        return result
    },
})

/** Test seam: how often the isolate actually evaluated a page, and the memo's
 * current footprint. */
export function sandboxRenderStats(): {
    evaluations: number
    cacheEntries: number
    cacheBytes: number
} {
    return {
        evaluations,
        cacheEntries: memo.size,
        cacheBytes: memo.calculatedSize,
    }
}

export async function renderMdxInSandbox(
    input: SandboxRenderInput,
): Promise<SandboxRenderResult> {
    const result = await memo.forceFetch(input.cacheKey, { context: input })
    // The transient failure (native addon unavailable) is never memoized:
    // the next request retries.
    if (
        !result.ok &&
        result.reason === "unavailable" &&
        memo.peek(input.cacheKey) === result
    )
        memo.delete(input.cacheKey)
    return result
}

/** Host-memory budget of the declined-page fallback memo, in UTF-8 bytes. */
const FALLBACK_CACHE_MAX_BYTES = 16 * 1024 * 1024

interface DeclinedFallbackInput {
    /** `${versionId}:${pageId}:${basePath}`, as for renderMdxInSandbox. */
    cacheKey: string
    /** The site's base path, as for renderMdxInSandbox: root-relative link
     * and image URLs get it. */
    basePath: string
    /** Frontmatter description: ingest quotes it in the stored rendition,
     * and the page header already shows it. */
    description: string | null
    /** The page's stored agent rendition (docs_page.processed_markdown). */
    markdown: () => Promise<string>
}

/**
 * The article for a page the isolate declined (INV-2: a failure degrades to
 * readable server HTML, never to tenant code running on the host). The
 * stored rendition is rendered as DATA: parsed as MDX so component bodies
 * stay Markdown, then every component is unwrapped to its children (its
 * title/label or field name as a bold lead line), ESM and non-literal
 * expressions dropped, raw HTML dropped by remark-rehype, and the result
 * sanitized with GitHub's element/attribute/URL-scheme allow-list. A
 * rendition that is not valid MDX parses as plain Markdown, where component
 * tags are raw HTML: their text survives, the tags do not. Memoized per
 * immutable (version, page) like the isolate outcome itself, so a declined
 * page costs one DB read and one render per instance.
 */
const fallbackMemo = new LRUCache<string, string, DeclinedFallbackInput>({
    max: CACHE_ENTRIES,
    maxSize: FALLBACK_CACHE_MAX_BYTES,
    sizeCalculation: (html) => Math.max(1, Buffer.byteLength(html, "utf8")),
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: input }) => {
        let markdown = await input.markdown()
        if (input.description) {
            // Ingest's quote leads the body, or follows an authored H1.
            const quote = `> ${input.description.trim().replace(/\s*\n\s*/g, " ")}\n`
            const h1 = /^# [^\n]*\n/.exec(markdown)?.[0] ?? ""
            if (markdown.startsWith(`${h1}${h1 ? "\n" : ""}${quote}`))
                markdown =
                    h1 +
                    markdown
                        .slice(h1.length + (h1 ? 1 : 0) + quote.length)
                        .replace(/^\n/, "")
        }
        let root: Root
        try {
            root = remark().use(remarkMdx).use(remarkGfm).parse(markdown)
        } catch {
            root = remark().use(remarkGfm).parse(markdown)
            visit(root, "html", (node, index, parent) => {
                if (!parent || index === undefined) return
                const text = node.value.replace(/<[^>]*>/g, " ").trim()
                parent.children.splice(index, 1, {
                    type: "text",
                    value: text,
                })
            })
        }
        visit(root, ["link", "image", "definition"], (node) => {
            if ("url" in node) node.url = withBase(node.url, input.basePath)
        })
        visit(root, (node, index, parent) => {
            if (!parent || index === undefined) return
            if (
                node.type === "mdxjsEsm" ||
                node.type === "mdxFlowExpression" ||
                node.type === "mdxTextExpression"
            ) {
                const [statement, ...rest] =
                    node.type === "mdxjsEsm"
                        ? []
                        : (node.data?.estree?.body ?? [])
                const literal =
                    statement?.type === "ExpressionStatement" &&
                    rest.length === 0
                        ? evaluateStaticMdxExpression(statement.expression)
                        : null
                const value =
                    literal?.ok &&
                    (typeof literal.value === "string" ||
                        typeof literal.value === "number")
                        ? String(literal.value)
                        : null
                if (value === null) parent.children.splice(index, 1)
                else
                    parent.children.splice(
                        index,
                        1,
                        node.type === "mdxFlowExpression"
                            ? {
                                  type: "paragraph",
                                  children: [{ type: "text", value }],
                              }
                            : { type: "text", value },
                    )
                return index
            }
            if (
                node.type !== "mdxJsxFlowElement" &&
                node.type !== "mdxJsxTextElement"
            )
                return
            const attribute = (name: string) => {
                const value = node.attributes.find(
                    (entry) =>
                        entry.type === "mdxJsxAttribute" && entry.name === name,
                )?.value
                return typeof value === "string" ? value : null
            }
            // ParamField's own name precedence (components/mdx.tsx).
            const field =
                attribute("path") ??
                attribute("query") ??
                attribute("body") ??
                attribute("header") ??
                attribute("name")
            const type = attribute("type")
            const label: PhrasingContent[] = field
                ? [
                      { type: "inlineCode", value: field },
                      ...(type
                          ? [
                                {
                                    type: "text",
                                    value: ` (${type})`,
                                } satisfies PhrasingContent,
                            ]
                          : []),
                  ]
                : [
                      {
                          type: "text",
                          value: attribute("title") ?? attribute("label") ?? "",
                      },
                  ]
            const lead: PhrasingContent[] =
                field || attribute("title") || attribute("label")
                    ? [{ type: "strong", children: label }]
                    : []
            const replacement: MdastContent[] =
                node.type === "mdxJsxFlowElement"
                    ? [
                          ...(lead.length > 0
                              ? [
                                    {
                                        type: "paragraph",
                                        children: lead,
                                    } satisfies MdastContent,
                                ]
                              : []),
                          ...node.children,
                      ]
                    : [
                          ...lead,
                          ...(lead.length > 0 && node.children.length > 0
                              ? [
                                    {
                                        type: "text",
                                        value: " ",
                                    } satisfies PhrasingContent,
                                ]
                              : []),
                          ...node.children,
                      ]
            parent.children.splice(index, 1, ...replacement)
            return index
        })
        const processor = remark()
            .use(remarkGfm)
            .use(remarkRehype)
            .use(rehypeSanitize)
        return `<div data-ssr-fallback="">${toHtml(await processor.run(root))}</div>`
    },
})

export function renderDeclinedFallback(
    input: DeclinedFallbackInput,
): Promise<string> {
    return fallbackMemo.forceFetch(input.cacheKey, { context: input })
}
