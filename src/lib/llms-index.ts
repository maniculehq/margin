import { agentConfig, isSurfaceEnabled } from "./agent.config"
import {
    buildLlmsFull,
    type DocPage,
    externalPointer,
    isChangelogPage,
    pageBreadcrumbs,
    pagesUnder,
    siteInstructionsBlock,
    slugsToMarkdownPath,
} from "./agent-content"
import { siteUrlFromRequest } from "./base-path"
import {
    alternateTrees,
    type DocsContext,
    openapiDocumentIndex,
    orderOpenapiDocuments,
    resolveDocsContext,
} from "./source"

/**
 * Past this size an index becomes a directory of sub-indexes under
 * `<scope>/_llms/`: an agent loading llms.txt into context should get a map
 * it can follow, not a truncated list. The cap is for the index only, never
 * for llms-full.txt.
 */
export const LLMS_INDEX_MAX_CHARS = 100_000

const textHeaders = (contentType: "text/plain" | "text/markdown") => ({
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": agentConfig.cache.header,
})

const notFound = () =>
    new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    })

interface IndexGroup {
    name: string
    slug: string
    pages: DocPage[]
}

/** Pages grouped by their breadcrumb at `depth`, in tree order, with stable
 * URL-safe slugs (a repeated slug gets a numeric suffix). Pages with no
 * breadcrumb that deep form one unnamed group the caller lists inline. */
function groupAt(
    ctx: DocsContext,
    pages: DocPage[],
    depth: number,
): IndexGroup[] {
    const groups = new Map<string, IndexGroup>()
    const slugs = new Set<string>()
    for (const page of pages) {
        const name = pageBreadcrumbs(ctx, page)[depth]?.name ?? ""
        let group = groups.get(name)
        if (!group) {
            const base =
                name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "") || "pages"
            let slug = base
            for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`
            slugs.add(slug)
            group = { name, slug, pages: [] }
            groups.set(name, group)
        }
        group.pages.push(page)
    }
    return [...groups.values()]
}

/**
 * One llms.txt document: the root index, a path-scoped one, or a sub-index.
 * `groupPath` walks the breadcrumb groups a sub-index narrows to; the
 * document lists its pages under H2 sections of the next breadcrumb level,
 * or — when that list would pass the cap and a deeper level exists — links
 * one sub-index per section instead.
 */
async function renderIndex(
    ctx: DocsContext,
    siteUrl: string,
    prefix: string[],
    groupPath: string[],
): Promise<string | null> {
    // An external pointer (frontmatter `url`) links its destination, as the
    // sidebar does: its own URL only redirects off-site and its .md twin is a
    // stub naming that destination.
    const pageLine = (page: DocPage) =>
        `- [${page.data.pageTitle}](${externalPointer(page) ?? `${siteUrl}${slugsToMarkdownPath(page.slugs).url}`})${page.data.description ? `: ${page.data.description}` : ""}`
    // A level with no section names to split by (a flat tree, or one
    // oversized section) splits into numbered parts instead, packed by the
    // size of their page lines so each part fits under the cap.
    const partsOf = (list: DocPage[]) => {
        const parts: DocPage[][] = [[]]
        let size = 0
        for (const page of list) {
            const length = pageLine(page).length + 1
            const current = parts.at(-1) ?? []
            if (
                current.length > 0 &&
                size + length > LLMS_INDEX_MAX_CHARS * 0.9
            ) {
                parts.push([page])
                size = length
            } else {
                current.push(page)
                size += length
            }
        }
        return parts
    }

    let pages = pagesUnder(ctx, prefix)
    const trail: string[] = []
    let part = false
    for (const [depth, slug] of groupPath.entries()) {
        const group = groupAt(ctx, pages, depth).find((g) => g.slug === slug)
        const partNumber = /^part-(\d+)$/.exec(slug)?.[1]
        if (group && !part) {
            pages = group.pages
            trail.push(group.name)
        } else if (partNumber && !part && depth === groupPath.length - 1) {
            // The root lists release history apart, so its parts don't.
            const chunk = partsOf(
                depth === 0
                    ? pages.filter((p) => !isChangelogPage(ctx, p))
                    : pages,
            )[Number(partNumber) - 1]
            if (!chunk) return null
            pages = chunk
            trail.push(`Part ${partNumber}`)
            part = true
        } else return null
    }
    if (pages.length === 0) return null

    const depth = groupPath.length
    const root = groupPath.length === 0
    const site = ctx.identity.name
    const scope = prefix.length ? `/${prefix.join("/")}` : ""
    const summary = ctx.identity.description
    // markdown.schema (deployment standard §2.3): when schema:true and the
    // config declares a $schema URL, the root index carries it so agents can
    // fetch the machine-readable config contract alongside the page index.
    const schemaUrl =
        root && ctx.config?.markdown?.schema === true
            ? ctx.config.$schema
            : undefined
    const header = [
        `# ${[site, ...trail].join(" — ")}`,
        "",
        ...(schemaUrl ? [`$schema: ${schemaUrl}`, ""] : []),
        ...(summary ? [`> ${summary}`, ""] : []),
    ]

    // The root index lists release history under llmstxt.org's `Optional`
    // section — the links an agent may skip when context is short.
    const changelog = root ? pages.filter((p) => isChangelogPage(ctx, p)) : []
    const primary = root ? pages.filter((p) => !isChangelogPage(ctx, p)) : pages
    // A part is a leaf: its pages list flat, never grouped or split again.
    const groups: IndexGroup[] = part
        ? [{ name: "", slug: "pages", pages: primary }]
        : groupAt(ctx, primary, depth)

    // docs.json `markdown.schema` (default true) — the same switch ingest
    // reads to embed specs in operation markdown: false keeps the API
    // specifications out of the agent exports, this index included.
    // The configured primary (docs.json api.openapi) leads, as /api/spec
    // serves it by default.
    const specs =
        root && ctx.config?.markdown?.schema !== false
            ? orderOpenapiDocuments(await openapiDocumentIndex(ctx), ctx.config)
            : []
    // The site root names the other versions and languages, each by its own
    // path-scoped index: nothing else tells an agent they exist.
    const trees = root && prefix.length === 0 ? await alternateTrees(ctx) : []
    const footer = [
        ...(specs.length
            ? [
                  "## API specifications",
                  "",
                  ...specs.map(
                      (spec) =>
                          `- [${spec.docId}](${siteUrl}/api/spec?doc=${encodeURIComponent(spec.docId)}): OpenAPI document`,
                  ),
                  "",
              ]
            : []),
        ...[
            { heading: "Other versions", kind: "version" },
            { heading: "Other languages", kind: "locale" },
        ].flatMap(({ heading, kind }) => {
            const links = trees.flatMap((tree) =>
                tree.kind === kind
                    ? [
                          `- [${tree.label}${tree.tag ? ` (${tree.tag})` : ""}](${siteUrl}${tree.url === "/" ? "" : tree.url}/llms.txt): ${tree.pages.length} pages`,
                      ]
                    : [],
            )
            return links.length > 0 ? [`## ${heading}`, "", ...links, ""] : []
        }),
        ...(root
            ? [
                  "## Optional",
                  "",
                  ...changelog.map(pageLine),
                  ...(isSurfaceEnabled("llmsFull")
                      ? [
                            `- [Full documentation](${siteUrl}${scope}/llms-full.txt): every page in one file`,
                        ]
                      : []),
                  ...(isSurfaceEnabled("changes")
                      ? [`- [Recent changes](${siteUrl}/changes.md)`]
                      : []),
                  "",
              ]
            : []),
        ...(root ? [siteInstructionsBlock(ctx), ""] : []),
    ]

    const listing = groups.flatMap((group) => [
        ...(group.name ? [`## ${group.name}`, ""] : []),
        ...group.pages.map(pageLine),
        "",
    ])
    const full = [...header, ...listing, ...footer].join("\n")
    if (full.length <= LLMS_INDEX_MAX_CHARS || part) return full

    // Named sections become sub-indexes; with none to split by, the level
    // splits into parts.
    const named = groups.some((g) => g.name)
    const directory = named
        ? groups.flatMap((group) =>
              group.name
                  ? [
                        `- [${group.name} (${group.pages.length} pages)](${siteUrl}${scope}/_llms/${[...groupPath, group.slug].join("/")}.txt): ${[...trail, group.name].join(" › ")}`,
                    ]
                  : group.pages.map(pageLine),
          )
        : partsOf(primary).map(
              (chunk, index) =>
                  `- [Part ${index + 1} (${chunk.length} pages)](${siteUrl}${scope}/_llms/${[...groupPath, `part-${index + 1}`].join("/")}.txt): ${chunk[0]?.data.pageTitle ?? ""} – ${chunk.at(-1)?.data.pageTitle ?? ""}`,
          )
    return [
        ...header,
        "## Indexes",
        "",
        "This index is split by section. Fetch the sub-index for the section you need; sub-indexes may split further.",
        "",
        ...directory,
        "",
        ...footer,
    ].join("\n")
}

/** `<scope>/llms.txt` — the whole site at `/`, the pages beneath a path
 * (a locale, a version, a section) elsewhere. */
export async function llmsIndexResponse(
    request: Request,
    prefix: string[],
): Promise<Response> {
    if (!isSurfaceEnabled("llms")) return notFound()
    const ctx = await resolveDocsContext(request, prefix)
    const body = await renderIndex(ctx, siteUrlFromRequest(request), prefix, [])
    if (body === null) return notFound()
    return new Response(body, { headers: textHeaders("text/plain") })
}

/** `<scope>/_llms/<group>/….(txt|md)` — one sub-index of a split index. The
 * `.md` twin serves the same body as text/markdown. */
export async function llmsSubIndexResponse(
    request: Request,
    prefix: string[],
    groupPath: string[],
    format: "txt" | "md",
): Promise<Response> {
    if (!isSurfaceEnabled("llms") || groupPath.length === 0) return notFound()
    const ctx = await resolveDocsContext(request, prefix)
    const body = await renderIndex(
        ctx,
        siteUrlFromRequest(request),
        prefix,
        groupPath,
    )
    if (body === null) return notFound()
    return new Response(body, {
        headers: textHeaders(format === "md" ? "text/markdown" : "text/plain"),
    })
}

/** `<scope>/llms-full.txt` — the capped corpus for the pages beneath a path,
 * streamed as it assembles (see buildLlmsFull). */
export async function llmsFullResponse(
    request: Request,
    prefix: string[],
): Promise<Response> {
    if (!isSurfaceEnabled("llmsFull")) return notFound()
    const ctx = await resolveDocsContext(request, prefix)
    if (pagesUnder(ctx, prefix).length === 0 && prefix.length > 0)
        return notFound()
    // Stream pages as they assemble: the first bytes leave before the last
    // chunk of bodies loads. The assembly is a shared, memoized job that
    // never touches this response — a client that disconnects mid-stream
    // only ends its own iterator, so other requests keep the corpus.
    const job = buildLlmsFull(ctx, agentConfig.llmsFull.maxChars, prefix)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of job.chunks())
                    controller.enqueue(encoder.encode(chunk))
                controller.close()
            } catch (error) {
                // Either the assembly failed or this response was cancelled
                // (enqueue throws once the reader is gone); error() is a
                // no-op on a closed stream.
                controller.error(error)
            }
        },
    })
    return new Response(stream, { headers: textHeaders("text/plain") })
}

/**
 * Path-scoped agent files the file router can't express (a splat cannot
 * carry a trailing static segment): `/<scope>/llms.txt`,
 * `/<scope>/llms-full.txt` and `[/<scope>]/_llms/<group…>.(txt|md)`. Returns
 * null for any other path.
 */
export function scopedLlmsRequest(request: Request): Promise<Response> | null {
    const { pathname } = new URL(request.url)
    // Malformed percent-encoding is no agent file; the router 404s it.
    let segments: string[]
    try {
        segments = pathname
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment))
    } catch {
        return null
    }
    const subIndex = segments.indexOf("_llms")
    if (subIndex !== -1) {
        const last = segments.at(-1) ?? ""
        const format = /\.md$/.test(last)
            ? "md"
            : /\.txt$/.test(last)
              ? "txt"
              : null
        if (!format || subIndex === segments.length - 1) return null
        const groupPath = [
            ...segments.slice(subIndex + 1, -1),
            last.replace(/\.(?:md|txt)$/, ""),
        ]
        return llmsSubIndexResponse(
            request,
            segments.slice(0, subIndex),
            groupPath,
            format,
        )
    }
    if (segments.length < 2) return null
    const file = segments.at(-1)
    const prefix = segments.slice(0, -1)
    if (file === "llms.txt") return llmsIndexResponse(request, prefix)
    if (file === "llms-full.txt") return llmsFullResponse(request, prefix)
    return null
}
