import {
    type CallToolResult,
    McpServer,
    ResourceTemplate,
} from "@modelcontextprotocol/server"
import { z } from "zod"
import { CONFIG_EXTENSION_KEY, docsCodeExampleSchema } from "@/types/docs"
import { codeExamplesFor } from "./agent/code-examples"
import { agentConfig, isSurfaceEnabled } from "./agent.config"
import {
    getLLMText,
    normalizeDocUrl,
    orderedPages,
    pageSection,
    searchServerFor,
    slugsToMarkdownPath,
    suggestClosestPages,
} from "./agent-content"
import { pageExists, recordFeedback } from "./agent-feedback"
import { skillCatalog } from "./agent-skills"
import { basePath, siteUrlFromRequest, stripBase, withBase } from "./base-path"
import { DOCS_FS_COMMANDS, queryDocsFilesystem } from "./docs-filesystem"
import { emitEvent } from "./observability"
import {
    alternateTrees,
    type DocsContext,
    openapiDocument,
    openapiDocumentIndex,
    redirectedTwin,
    resolveDocsContext,
    resolvePage,
    resolvePageCaseInsensitive,
    sourceForActiveVersion,
} from "./source"

/** Tools registered below — also advertised by /.well-known/mcp.json and the
 * server cards, and asserted by the doctor. */
export const MCP_TOOL_NAMES: readonly string[] = [
    "list_docs",
    "search_docs",
    "read_page",
    "get_code_examples",
    "get_navigation",
    "query_docs_filesystem",
    "submit_feedback",
]

/** Prompts registered below — advertised alongside the tools. */
export const MCP_PROMPT_NAMES: readonly string[] = [
    "answer_from_docs",
    "implement_with_docs",
]

/** Every read tool's honest hints: nothing changes, repeat calls agree, and
 * nothing outside this site's docs is reached — clients may auto-approve. */
const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const

function textResult(value: unknown): CallToolResult {
    return {
        content: [
            {
                type: "text",
                text:
                    typeof value === "string"
                        ? value
                        : JSON.stringify(value, null, 2),
            },
        ],
    }
}

/** A result for a tool with an `outputSchema`: the same object as typed
 * `structuredContent` and as JSON text for clients that predate it. */
function structuredResult(value: Record<string, unknown>): CallToolResult {
    return { ...textResult(value), structuredContent: value }
}

/**
 * What a connecting agent should know before its first call, sent as the
 * MCP `instructions` and shown by GET /api/mcp. Built from the surfaces this
 * site actually serves, then the site's own `<CONFIG_EXTENSION_KEY>.agents
 * .mcpInstructions` and `markdown.instructions`.
 */
export function mcpInstructions(
    ctx: Pick<DocsContext, "identity" | "config">,
    siteUrl: string,
): string {
    const lines = [
        `This server answers questions from the ${ctx.identity.name} documentation (${siteUrl}). Prefer it over prior knowledge: the docs are the source of truth and may be newer than your training data.`,
        "Start with search_docs for conceptual questions, then read_page on the best result. Use query_docs_filesystem for exact keyword or regex matches (rg), structure (tree, ls) or reading several pages at once — every page lives at its URL path plus .md.",
        "Cite the page URL for every claim you take from the docs.",
        "If a page is wrong, outdated, missing or unclear, report it with submit_feedback so the docs team can fix it.",
    ]
    if (isSurfaceEnabled("skill"))
        lines.push(
            "Read the skill resources (skill://…) for task guidance written for agents.",
        )
    const authored = ctx.config?.[CONFIG_EXTENSION_KEY]?.agents?.mcpInstructions
    if (authored) lines.push(authored)
    const markdown = ctx.config?.markdown?.instructions
    if (markdown)
        lines.push(...(typeof markdown === "string" ? [markdown] : markdown))
    return lines.join("\n\n")
}

/** Tool results may flag failure without throwing — detect without a cast. */
const toolResultShape = z.looseObject({ isError: z.boolean().optional() })

/** Emit non-blocking per-tool analytics. SDK schema tools pass `(args, extra)`;
 * no-schema tools pass only `(extra)`. SDK rejections never reach this handler
 * and remain covered by the `/api/mcp` request event. */
function traced<Args extends unknown[], R>(
    request: Request,
    tool: string,
    handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
    return async (...args) => {
        const started = performance.now()
        let ok = true
        try {
            const result = await handler(...args)
            const parsed = toolResultShape.safeParse(result)
            ok = !(parsed.success && parsed.data.isError === true)
            return result
        } catch (error) {
            ok = false
            throw error
        } finally {
            emitEvent(request, {
                type: "mcp_tool_called",
                tool,
                ok,
                durationMs: Math.round(performance.now() - started),
                ...(agentConfig.observability.includeInputs && args.length > 1
                    ? { args: args[0] }
                    : {}),
            })
        }
    }
}

const pageRefSchema = z.object({
    title: z.string(),
    url: z.string(),
    markdownUrl: z.string(),
    description: z.string().nullable(),
})

/** Another version or language: `url` is the value that scopes a tool to
 * it (alternateTrees). */
const otherScopeSchema = z.object({
    kind: z.enum(["version", "locale"]),
    label: z.string(),
    tag: z.string().optional(),
    url: z.string(),
    pages: z.number().int(),
})

/** fumadocs `SortedResult` — the fields an agent acts on; extra keys pass. */
const searchResultSchema = z.looseObject({
    id: z.string(),
    url: z.string(),
    type: z.string(),
    content: z.string(),
})

/**
 * Locale and version scoping for a tool call: an explicit `url` wins (its
 * leading segments select the locale and version, like the page URL), then
 * the `locale` / `version` arguments in URL order. Empty → the site default.
 */
function scopeSlugs(input: {
    url?: string
    locale?: string
    version?: string
}): string[] {
    if (input.url) return normalizeDocUrl(input.url)
    return [input.locale, input.version].flatMap((segment) =>
        segment ? [segment] : [],
    )
}

/**
 * Build a fresh, read-only MCP server. Creating it per request is cheap — it only
 * attaches closures; the per-site search index and source loader are
 * module-scope memoized, so there is no per-request, per-page indexing (the
 * O(pages)-per-call flaw this avoids). All tools derive from the single
 * agent-content choke-point, scoped to the request's site.
 */
export async function buildMcpServer(request: Request): Promise<McpServer> {
    const ctx = await resolveDocsContext(request)
    const siteUrl = siteUrlFromRequest(request)
    const server = new McpServer(
        {
            name: `${ctx.identity.name} docs`,
            title: `${ctx.identity.name} documentation`,
            version: agentConfig.discovery.version,
            websiteUrl: siteUrl,
        },
        { instructions: mcpInstructions(ctx, siteUrl) },
    )
    const toolContext = async (slugs: string[]) =>
        slugs.length ? resolveDocsContext(request, slugs) : ctx

    // One page lookup for read_page and get_code_examples, following the
    // rules the HTML route and the .md twin follow (spec §5.3): the visible
    // tree, the served_url fallback, a configured redirect, then the
    // case-insensitive retry.
    // Redirect chains (/old → /moved → /new) are followed hop by hop, as a
    // browser follows the HTML route's 30x answers, up to a hop limit.
    const lookupPage = async (url: string) => {
        const slugs = normalizeDocUrl(url)
        let current = slugs
        for (let hop = 0; hop <= 10; hop++) {
            const toolCtx = await resolveDocsContext(request, current)
            // A configured redirect wins over a page still at its source,
            // as on the HTML route ($.tsx matches redirects first).
            const moved = redirectedTwin(toolCtx, current, "")
            if (moved && /^https?:\/\//i.test(moved.href))
                return { ctx: toolCtx, slugs, page: null, external: moved.href }
            const page = moved
                ? null
                : await resolvePage(
                      toolCtx,
                      await sourceForActiveVersion(toolCtx, current),
                      current,
                  )
            if (page) return { ctx: toolCtx, slugs, page, external: null }
            const target =
                moved?.href ??
                (await resolvePageCaseInsensitive(toolCtx, current))
            if (!target)
                return { ctx: toolCtx, slugs, page: null, external: null }
            // A stored destination or served URL is internal: only the
            // caller's URL carries the base path to strip.
            current = normalizeDocUrl(target, "")
        }
        return {
            ctx: await resolveDocsContext(request, slugs),
            slugs,
            page: null,
            external: null,
        }
    }

    server.registerTool(
        "list_docs",
        {
            title: "List documentation pages",
            description:
                'List documentation pages in navigation order (title, URL, markdown URL, description, section), optionally under a URL prefix. Pass url (e.g. "/v1" or "/es") to list another version or language; otherScopes names them. Paginated: pass the returned nextCursor as cursor to read the next page; nextCursor is null on the last page.',
            inputSchema: z.object({
                url: z.string().optional(),
                prefix: z.string().optional(),
                limit: z.number().int().min(1).max(500).optional(),
                cursor: z.number().int().min(0).optional(),
            }),
            outputSchema: z.object({
                pages: z.array(pageRefSchema.extend({ section: z.string() })),
                total: z.number().int(),
                nextCursor: z.number().int().nullable(),
                otherScopes: z.array(otherScopeSchema).optional(),
            }),
            annotations: READ_ONLY,
        },
        traced(request, "list_docs", async ({ url, prefix, limit, cursor }) => {
            const scope = url ?? prefix
            const slugs = normalizeDocUrl(scope ?? "")
            const scoped = await toolContext(scope ? slugs : [])
            const pages = orderedPages(scoped)
            // The caller's prefix is a public path; page URLs are internal.
            const internalPrefix =
                prefix?.startsWith("/") === true
                    ? (stripBase(prefix, basePath()) ?? prefix)
                    : prefix
            const matching = internalPrefix
                ? pages.filter((page) => page.url.startsWith(internalPrefix))
                : pages
            const start = cursor ?? 0
            const end = start + (limit ?? 200)
            return structuredResult({
                pages: matching.slice(start, end).map((page) => ({
                    title: page.data.pageTitle,
                    url: withBase(page.url),
                    markdownUrl: withBase(slugsToMarkdownPath(page.slugs).url),
                    description: page.data.description ?? null,
                    section: pageSection(scoped, page),
                })),
                total: matching.length,
                nextCursor: end < matching.length ? end : null,
                ...(scope
                    ? {}
                    : {
                          otherScopes: (await alternateTrees(scoped)).map(
                              (tree) => ({
                                  kind: tree.kind,
                                  label: tree.label,
                                  ...(tree.tag ? { tag: tree.tag } : {}),
                                  // The `url` value that scopes a tool to the tree.
                                  url: withBase(tree.url),
                                  pages: tree.pages.length,
                              }),
                          ),
                      }),
            })
        }),
    )

    server.registerTool(
        "search_docs",
        {
            title: "Search documentation",
            description:
                "Full-text search across the docs. Returns page/heading/text results with deep-link URLs and breadcrumbs. Scope to a locale and/or version with `locale` and `version` (the URL segments, e.g. `fr`, `v2`), or pass any page `url` in the scope you want.",
            inputSchema: z.object({
                query: z.string().trim().min(1),
                limit: z.number().int().min(1).max(50).optional(),
                url: z.string().optional(),
                locale: z.string().optional(),
                version: z.string().optional(),
            }),
            outputSchema: z.object({ results: z.array(searchResultSchema) }),
            annotations: READ_ONLY,
        },
        traced(request, "search_docs", async (input) => {
            const slugs = scopeSlugs(input)
            const scoped = await toolContext(slugs)
            const results = await (await searchServerFor(scoped, slugs)).search(
                input.query,
                { limit: input.limit ?? 10 },
            )
            // The index's highlighter wraps hits in <mark> for the search
            // dialog; agents get the plain text.
            return structuredResult({
                results: results.map((result) => ({
                    ...result,
                    // The site's public path, under its base path.
                    url: withBase(result.url),
                    content: result.content.replaceAll(/<\/?mark>/g, ""),
                })),
            })
        }),
    )

    server.registerTool(
        "read_page",
        {
            title: "Read a documentation page as markdown",
            description:
                "Return the clean agent markdown for a page. Accepts a slug, a site-root path, or a trailing-.md URL (e.g. from llms.txt); follows the site's redirects.",
            inputSchema: z.object({ url: z.string() }),
            annotations: READ_ONLY,
        },
        traced(request, "read_page", async ({ url }) => {
            const found = await lookupPage(url)
            if (!found.page) {
                return {
                    ...textResult({
                        error: "not_found",
                        requested: url,
                        ...(found.external
                            ? { redirectsTo: found.external }
                            : {
                                  candidates: suggestClosestPages(
                                      found.ctx,
                                      found.slugs,
                                  ).map((candidate) => ({
                                      ...candidate,
                                      url: withBase(candidate.url),
                                      markdownUrl: withBase(
                                          candidate.markdownUrl,
                                      ),
                                  })),
                              }),
                    }),
                    isError: true,
                }
            }
            return textResult(await getLLMText(found.ctx, found.page))
        }),
    )

    server.registerTool(
        "get_code_examples",
        {
            title: "Get code examples from a page",
            description:
                "Return structured code blocks (language, title, code, alternatives group) for a page. Accepts a slug or .md URL; optionally filter by language.",
            inputSchema: z.object({
                url: z.string(),
                language: z.string().optional(),
            }),
            outputSchema: z.object({
                examples: z.array(docsCodeExampleSchema),
            }),
            annotations: READ_ONLY,
        },
        traced(request, "get_code_examples", async ({ url, language }) => {
            const found = await lookupPage(url)
            if (!found.page) {
                return {
                    ...textResult({ error: "not_found", requested: url }),
                    isError: true,
                }
            }
            const examples = await codeExamplesFor(found.ctx, found.page)
            return structuredResult({
                examples: language
                    ? examples.filter((e) => e.language === language)
                    : examples,
            })
        }),
    )

    server.registerTool(
        "get_navigation",
        {
            title: "Get the documentation navigation tree",
            description:
                'Return the documentation navigation as sections of pages (title, URL, markdown URL), in docs.json order. Pass url (e.g. "/v1" or "/es") for another version or language; otherScopes names them.',
            inputSchema: z.object({ url: z.string().optional() }),
            outputSchema: z.object({
                site: z.string(),
                sections: z.array(
                    z.object({
                        section: z.string(),
                        pages: z.array(
                            pageRefSchema.omit({ description: true }),
                        ),
                    }),
                ),
                otherScopes: z.array(otherScopeSchema).optional(),
            }),
            annotations: READ_ONLY,
        },
        traced(request, "get_navigation", async ({ url }) => {
            const slugs = normalizeDocUrl(url ?? "")
            const scoped = await toolContext(url ? slugs : [])
            const sections = new Map<
                string,
                { title: string; url: string; markdownUrl: string }[]
            >()
            for (const page of orderedPages(scoped)) {
                const section = pageSection(scoped, page)
                sections.set(section, [
                    ...(sections.get(section) ?? []),
                    {
                        title: page.data.pageTitle,
                        url: withBase(page.url),
                        markdownUrl: withBase(
                            slugsToMarkdownPath(page.slugs).url,
                        ),
                    },
                ])
            }
            return structuredResult({
                site: scoped.identity.name,
                sections: [...sections].map(([section, pages]) => ({
                    section,
                    pages,
                })),
                ...(url
                    ? {}
                    : {
                          otherScopes: (await alternateTrees(scoped)).map(
                              (tree) => ({
                                  kind: tree.kind,
                                  label: tree.label,
                                  ...(tree.tag ? { tag: tree.tag } : {}),
                                  // The `url` value that scopes a tool to the tree.
                                  url: withBase(tree.url),
                                  pages: tree.pages.length,
                              }),
                          ),
                      }),
            })
        }),
    )

    server.registerTool(
        "query_docs_filesystem",
        {
            title: "Query the docs as a read-only filesystem",
            description: [
                "Run one read-only shell command over a virtual filesystem of this documentation. This is NOT a shell on any real machine: nothing runs outside an in-memory sandbox, and there is no network.",
                `Every page lives at its URL path plus .md (${withBase("/guides/setup")} → ${withBase("/guides/setup.md")}; the home page is ${withBase("/index.md")}), so paths from llms.txt, search results and links map directly. OpenAPI documents are under /_openapi/<docId>.json and agent skills under /_skills/<name>/SKILL.md.`,
                `Commands: ${DOCS_FS_COMMANDS.join(", ")}, with pipes. Each call is stateless and starts at /.`,
                `Use it for exact keyword/regex search (rg -n 'term' /, rg -il 'term' /), structure (tree / -L 2, ls ${withBase("/guides")}) and reading several pages or sections at once (cat, head, sed -n '/^## Setup/,/^## /p'). Paths are site-specific — discover them with tree or rg instead of guessing.`,
            ].join("\n\n"),
            inputSchema: z.object({
                command: z.string().min(1).max(2_000),
                url: z.string().optional(),
                locale: z.string().optional(),
                version: z.string().optional(),
            }),
            outputSchema: z.object({
                stdout: z.string(),
                stderr: z.string(),
                exitCode: z.number().int(),
                truncated: z.boolean(),
            }),
            annotations: READ_ONLY,
        },
        traced(request, "query_docs_filesystem", async (input) => {
            const slugs = scopeSlugs(input)
            const scoped = await toolContext(slugs)
            const skills = isSurfaceEnabled("skill")
                ? await skillCatalog(scoped, siteUrl)
                : []
            const result = await queryDocsFilesystem(
                scoped,
                slugs,
                input.command,
                Object.fromEntries(
                    skills.map((skill) => [
                        `/_skills/${skill.name}/SKILL.md`,
                        skill.body,
                    ]),
                ),
            )
            return {
                ...structuredResult(result),
                ...(result.exitCode !== 0 && !result.stdout
                    ? { isError: true }
                    : {}),
            }
        }),
    )

    if (isSurfaceEnabled("feedback"))
        server.registerTool(
            "submit_feedback",
            {
                title: "Report a documentation problem",
                description:
                    "Tell the docs team a page is incorrect, outdated, missing something, or unclear, so they can fix it. Name the page URL, describe the problem specifically (what you expected, what the page says), and suggest a fix when you can. Feedback is reviewed by people; it does not change the docs immediately.",
                inputSchema: z.object({
                    url: z.string().min(1).max(2_048),
                    kind: z.enum([
                        "incorrect",
                        "missing",
                        "outdated",
                        "unclear",
                        "other",
                    ]),
                    message: z.string().trim().min(1).max(2_000),
                    suggestedFix: z.string().max(2_000).optional(),
                }),
                outputSchema: z.object({
                    received: z.boolean(),
                    pageExists: z.boolean(),
                }),
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: true,
                },
            },
            traced(request, "submit_feedback", async (input) => {
                const slugs = normalizeDocUrl(input.url)
                const scoped = await toolContext(slugs)
                const exists = pageExists(scoped, input.url)
                recordFeedback(scoped, request, { ...input, source: "mcp" })
                emitEvent(request, {
                    type: "agent_feedback_submitted",
                    kind: input.kind,
                    source: "mcp",
                    page_url: input.url,
                    page_exists: exists,
                })
                return structuredResult({ received: true, pageExists: exists })
            }),
        )

    // Every page as a readable resource: the same markdown read_page returns,
    // addressable by URI so clients can attach a page as context directly.
    server.registerResource(
        "page",
        new ResourceTemplate("docs://page/{+path}", {
            list: () => ({
                resources: orderedPages(ctx).map((page) => ({
                    uri: `docs://page${page.url === "/" ? "/index" : page.url}`,
                    name: page.data.pageTitle,
                    ...(page.data.description
                        ? { description: page.data.description }
                        : {}),
                    mimeType: "text/markdown",
                })),
            }),
            complete: {
                path: (value) =>
                    orderedPages(ctx)
                        .map((page) =>
                            page.url === "/" ? "index" : page.url.slice(1),
                        )
                        .filter((path) => path.startsWith(value))
                        .slice(0, 100),
            },
        }),
        {
            title: "Documentation page",
            description: "One documentation page as agent markdown.",
            mimeType: "text/markdown",
        },
        async (uri, variables) => {
            const raw = variables.path
            const path = Array.isArray(raw) ? raw.join("/") : (raw ?? "")
            const slugs = normalizeDocUrl(path === "index" ? "" : path)
            const scoped = await resolveDocsContext(request, slugs)
            const source = await sourceForActiveVersion(scoped, slugs)
            const page = await resolvePage(scoped, source, slugs)
            if (!page) throw new Error(`No documentation page at ${uri.href}`)
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "text/markdown",
                        text: await getLLMText(scoped, page),
                    },
                ],
            }
        },
    )

    const specs = await openapiDocumentIndex(ctx)
    if (specs.length > 0)
        server.registerResource(
            "openapi",
            new ResourceTemplate("openapi://{docId}", {
                list: () => ({
                    resources: specs.map((spec) => ({
                        uri: `openapi://${spec.docId}`,
                        name: spec.docId,
                        description: "OpenAPI document",
                        mimeType: "application/json",
                    })),
                }),
            }),
            {
                title: "OpenAPI document",
                description:
                    "A bundled OpenAPI document behind the API reference.",
                mimeType: "application/json",
            },
            async (uri, variables) => {
                const raw = variables.docId
                const docId = Array.isArray(raw) ? raw.join("/") : (raw ?? "")
                const document = await openapiDocument(ctx, docId)
                if (!document)
                    throw new Error(`No OpenAPI document at ${uri.href}`)
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: JSON.stringify(document, null, 2),
                        },
                    ],
                }
            },
        )

    if (isSurfaceEnabled("skill"))
        for (const skill of await skillCatalog(ctx, siteUrl))
            server.registerResource(
                `skill-${skill.name}`,
                `skill://${skill.name}`,
                {
                    title: skill.name,
                    description: skill.description,
                    mimeType: "text/markdown",
                },
                (uri) => ({
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/markdown",
                            text: skill.body,
                        },
                    ],
                }),
            )

    server.registerPrompt(
        "answer_from_docs",
        {
            title: "Answer a question from the docs",
            description:
                "Research a question in this documentation and answer it with citations.",
            argsSchema: z.object({ question: z.string() }),
        },
        ({ question }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Answer this question using the ${ctx.identity.name} documentation: ${question}\n\nSearch with search_docs, read the most relevant pages with read_page, and use query_docs_filesystem (rg) for exact terms. Answer only from what the pages say, cite each page URL you rely on, and say plainly when the docs don't cover something.`,
                    },
                },
            ],
        }),
    )

    server.registerPrompt(
        "implement_with_docs",
        {
            title: "Implement a task with the docs",
            description:
                "Plan and write code for a task, grounded in this documentation's guides and code examples.",
            argsSchema: z.object({ task: z.string() }),
        },
        ({ task }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Implement this with ${ctx.identity.name}: ${task}\n\nFind the relevant guides with search_docs, read them with read_page, and pull exact snippets with get_code_examples — prefer the documented APIs and parameters over memory. List the pages you followed. If a step isn't documented, say so instead of guessing, and report the gap with submit_feedback.`,
                    },
                },
            ],
        }),
    )

    return server
}
