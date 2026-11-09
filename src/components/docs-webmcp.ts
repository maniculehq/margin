import type { AnyRouter } from "@tanstack/react-router"
import type { RefObject } from "react"
import {
    array,
    boolean,
    gte,
    int,
    lte,
    maxLength,
    minLength,
    nullable,
    object,
    optional,
    regex,
    string,
    toJSONSchema,
    trim,
    unknown,
    enum as zodEnum,
} from "zod/mini"
import { withBase } from "@/lib/base-path"
import { registerWebmcpTool } from "@/lib/webmcp-tools"
import type { BrowserEvent } from "@/routes/api/agent.event"

const SEARCH_LIMIT_DEFAULT = 10
const SEARCH_LIMIT_MAX = 20

const searchInput = object({
    query: string().check(trim(), minLength(1), maxLength(200)),
    limit: optional(int().check(gte(1), lte(SEARCH_LIMIT_MAX))),
})

/** fumadocs `SortedResult` — the only fields the tool forwards. */
const searchResults = array(
    object({
        url: string(),
        type: zodEnum(["page", "heading", "text"]),
        content: string(),
        breadcrumbs: optional(array(string())),
    }),
)

const emptyInput = object({})

const headings = array(object({ id: string(), content: string() }))

/** `/api/agent/context/$` success body (api.agent.context.$.ts); the route
 * caps the markdown and reports it in `truncated`. */
const contextBundle = object({
    url: string(),
    markdownUrl: string(),
    title: string(),
    description: nullable(string()),
    breadcrumbs: array(unknown()),
    headings,
    related: array(unknown()),
    codeExamples: array(unknown()),
    markdown: string(),
    truncated: boolean(),
})

/** The `?view=summary` fields open_documentation reads: the canonical page
 * URL to navigate to, whether the page redirects off-site, and its headings. */
const contextSummary = object({ url: string(), external: boolean(), headings })

/** Single leading slash, no scheme, no protocol-relative "//", no query or
 * fragment. Backslashes are URL separators too and can change the host. */
const internalPath = /^\/(?!\/)[^\\\s?#]*$/

/** Text an agent reads in one tool result; longer bodies are clipped and
 * flagged so the agent can fall back to narrower reads. */
const TEXT_LIMIT = 60_000

const readInput = object({
    path: string().check(
        maxLength(2_000),
        regex(internalPath, "internal docs path required"),
    ),
})

const skillInput = object({
    name: optional(string().check(trim(), minLength(1), maxLength(64))),
})

/** `/.well-known/agent-skills/index.json` (v0.2.0) — the fields read_skill uses. */
const skillsIndex = object({
    skills: array(
        object({ name: string(), description: string(), url: string() }),
    ),
})

const openInput = object({
    path: string().check(
        maxLength(2_000),
        regex(internalPath, "internal docs path required"),
    ),
    heading: optional(string().check(trim(), minLength(1), maxLength(120))),
})

export type DocsWebmcpState = {
    pathname: string
    title: string
    pageUrl: string
}

/** Register route-local search, read, and navigation tools for browsers that
 * support WebMCP. Same-origin routes resolve site/version/locale server-side;
 * aborting the registration signal unregisters them on cleanup. */
export function registerDocsTools(
    latest: RefObject<DocsWebmcpState>,
    capturedPathname: string,
    searchScope: string,
    router: AnyRouter,
    signal: AbortSignal,
) {
    const stale = () => latest.current.pathname !== capturedPathname
    const slugPath = capturedPathname.replace(/^\/+/, "")
    // Runs a tool body and reports its name and outcome to the docs
    // analytics channel. Reported from the browser, not the routes the
    // tools fetch: it sees outcomes those never do (invalid input, a stale
    // scope, an unparseable body), tells the two context-route tools
    // apart, and still counts calls the CDN answers from cache. Inputs and
    // results never leave the browser.
    const tracked = async <TResult extends { ok: boolean }>(
        tool: Extract<BrowserEvent, { type: "webmcp_tool_called" }>["tool"],
        run: () => Promise<TResult>,
    ): Promise<TResult> => {
        let ok = false
        try {
            const result = await run()
            ok = result.ok
            return result
        } finally {
            const beacon = JSON.stringify({
                type: "webmcp_tool_called",
                page_path: capturedPathname,
                tool,
                ok,
            } satisfies BrowserEvent)
            if (!navigator.sendBeacon(withBase("/api/agent/event"), beacon))
                void fetch(withBase("/api/agent/event"), {
                    method: "POST",
                    body: beacon,
                    keepalive: true,
                }).catch(() => {})
        }
    }

    registerWebmcpTool(
        {
            name: "search_docs",
            description:
                "Search this documentation site. Results are scoped to the version and locale of the page currently open. Returns bounded matches with url, type (page|heading|text), a content snippet, and breadcrumbs.",
            inputSchema: toJSONSchema(searchInput),
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (rawInput, { signal }) =>
                tracked("search_docs", async () => {
                    const parsed = searchInput.safeParse(rawInput)
                    if (!parsed.success)
                        return {
                            ok: false,
                            error: "invalid_input",
                            issues: parsed.error.issues,
                        }
                    const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT
                    const params = new URLSearchParams({
                        // Inbound paths are public ones (normalizeDocUrl).
                        path: withBase(searchScope),
                        query: parsed.data.query,
                        limit: String(limit),
                    })
                    const response = await fetch(
                        withBase(`/api/search?${params}`),
                        {
                            signal,
                            headers: { Accept: "application/json" },
                        },
                    )
                    if (!response.ok)
                        return {
                            ok: false,
                            error: "search_failed",
                            status: response.status,
                        }
                    const results = searchResults.safeParse(
                        await response.json(),
                    )
                    if (!results.success)
                        return { ok: false, error: "unexpected_response" }
                    if (stale()) return { ok: false, error: "stale_scope" }
                    const rows = results.data.slice(0, limit)
                    return {
                        ok: true,
                        scope: { path: capturedPathname },
                        query: parsed.data.query,
                        results: rows,
                        // A full page may hide more matches; only a short page is complete.
                        complete: results.data.length < limit,
                    }
                }),
        },
        { signal },
    )

    registerWebmcpTool(
        {
            name: "get_current_page_context",
            description:
                "Return the structured context bundle for the documentation page currently open: canonical url, title, description, breadcrumbs, headings, related pages, code examples, and the page markdown (capped). No arguments.",
            inputSchema: toJSONSchema(emptyInput),
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (_rawInput, { signal }) =>
                tracked("get_current_page_context", async () => {
                    const response = await fetch(
                        withBase(`/api/agent/context/${slugPath}`),
                        {
                            signal,
                            headers: { Accept: "application/json" },
                        },
                    )
                    if (!response.ok)
                        return {
                            ok: false,
                            error: "context_unavailable",
                            status: response.status,
                        }
                    const bundle = contextBundle.safeParse(
                        await response.json(),
                    )
                    if (!bundle.success)
                        return { ok: false, error: "unexpected_response" }
                    if (stale()) return { ok: false, error: "stale_scope" }
                    return {
                        ok: true,
                        scope: {
                            path: capturedPathname,
                            canonical: latest.current.pageUrl,
                        },
                        ...bundle.data,
                    }
                }),
        },
        { signal },
    )

    const clipped = (text: string) => ({
        text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text,
        truncated: text.length > TEXT_LIMIT,
    })

    registerWebmcpTool(
        {
            name: "read_page",
            description:
                "Read any page of this documentation site as clean markdown — not just the one open. `path` is an internal docs path (search_docs result urls, links from get_site_overview). Long pages are clipped and flagged `truncated`.",
            inputSchema: toJSONSchema(readInput),
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (rawInput, { signal }) =>
                tracked("read_page", async () => {
                    const parsed = readInput.safeParse(rawInput)
                    if (!parsed.success)
                        return {
                            ok: false,
                            error: "invalid_input",
                            issues: parsed.error.issues,
                        }
                    const path = parsed.data.path.replace(/\.md$/, "")
                    const response = await fetch(
                        withBase(`${path === "/" ? "/index" : path}.md`),
                        { signal, headers: { Accept: "text/markdown" } },
                    )
                    if (response.status !== 200)
                        return { ok: false, error: "unknown_path", path }
                    return {
                        ok: true,
                        path,
                        ...clipped(await response.text()),
                    }
                }),
        },
        { signal },
    )

    registerWebmcpTool(
        {
            name: "get_site_overview",
            description:
                "Return this documentation site's llms.txt: every page in the open version and locale, grouped by section, with one-line descriptions — the map to read before choosing pages. No arguments.",
            inputSchema: toJSONSchema(emptyInput),
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (_rawInput, { signal }) =>
                tracked("get_site_overview", async () => {
                    const response = await fetch(
                        withBase(
                            searchScope === "/"
                                ? "/llms.txt"
                                : `${searchScope}/llms.txt`,
                        ),
                        { signal },
                    )
                    if (!response.ok)
                        return {
                            ok: false,
                            error: "overview_unavailable",
                            status: response.status,
                        }
                    if (stale()) return { ok: false, error: "stale_scope" }
                    return { ok: true, ...clipped(await response.text()) }
                }),
        },
        { signal },
    )

    registerWebmcpTool(
        {
            name: "read_skill",
            description:
                "Read this site's Agent Skills — task guidance written for agents (https://agentskills.io). Without `name`, lists the skills with their descriptions; with `name`, returns that skill's SKILL.md.",
            inputSchema: toJSONSchema(skillInput),
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (rawInput, { signal }) =>
                tracked("read_skill", async () => {
                    const parsed = skillInput.safeParse(rawInput)
                    if (!parsed.success)
                        return {
                            ok: false,
                            error: "invalid_input",
                            issues: parsed.error.issues,
                        }
                    const response = await fetch(
                        withBase("/.well-known/agent-skills/index.json"),
                        { signal, headers: { Accept: "application/json" } },
                    )
                    if (!response.ok)
                        return {
                            ok: false,
                            error: "skills_unavailable",
                            status: response.status,
                        }
                    const index = skillsIndex.safeParse(await response.json())
                    if (!index.success)
                        return { ok: false, error: "unexpected_response" }
                    const { name } = parsed.data
                    if (!name)
                        return {
                            ok: true,
                            skills: index.data.skills.map((skill) => ({
                                name: skill.name,
                                description: skill.description,
                            })),
                        }
                    const skill = index.data.skills.find((s) => s.name === name)
                    // The index names each skill at the site's public
                    // address, which behind a verified proxy is another
                    // origin than a page open at the platform address. Read
                    // the skill's known path through this page's origin and
                    // base path instead, and never fetch another origin.
                    const url = skill
                        ? new URL(
                              withBase(
                                  `/.well-known/agent-skills/${encodeURIComponent(skill.name)}/SKILL.md`,
                              ),
                              location.origin,
                          )
                        : null
                    if (!skill || !url || url.origin !== location.origin)
                        return { ok: false, error: "unknown_skill", name }
                    const body = await fetch(url, { signal })
                    if (!body.ok)
                        return { ok: false, error: "skill_unavailable", name }
                    return { ok: true, name, ...clipped(await body.text()) }
                }),
        },
        { signal },
    )

    registerWebmcpTool(
        {
            name: "open_documentation",
            description:
                "Navigate the user's browser to another page of this documentation site. `path` must be an internal docs path that exists on this site (use search_docs result urls); external, protocol-relative, and unknown paths are rejected. Optional `heading` scrolls to a matching section when it exists.",
            inputSchema: toJSONSchema(openInput),
            execute: (rawInput, { signal }) =>
                tracked("open_documentation", async () => {
                    const parsed = openInput.safeParse(rawInput)
                    if (!parsed.success)
                        return {
                            ok: false,
                            error: "invalid_input",
                            issues: parsed.error.issues,
                        }
                    const { path, heading } = parsed.data
                    const response = await fetch(
                        withBase(
                            `/api/agent/context/${path.replace(/^\/+/, "")}?view=summary`,
                        ),
                        { signal, headers: { Accept: "application/json" } },
                    )
                    if (response.status !== 200)
                        return { ok: false, error: "unknown_path", path }
                    const summary = contextSummary.safeParse(
                        await response.json(),
                    )
                    if (!summary.success)
                        return { ok: false, error: "unexpected_response" }
                    // An external-pointer page redirects off-site from its
                    // internal route; this tool only opens docs pages.
                    if (summary.data.external)
                        return { ok: false, error: "external_page", path }
                    // Navigate to the canonical URL the server resolved, not
                    // the input: `/page.md` resolves to `/page`, and the raw
                    // form would open the markdown response instead.
                    const target = summary.data.url
                    if (!internalPath.test(target))
                        return { ok: false, error: "unknown_path", path }
                    if (stale()) return { ok: false, error: "stale_scope" }
                    let fragment = ""
                    let headingMatched: boolean | null = null
                    if (heading) {
                        const wanted = heading.toLowerCase()
                        const match = summary.data.headings.find(
                            (entry) =>
                                entry.id.toLowerCase() === wanted ||
                                entry.content.toLowerCase() === wanted,
                        )
                        headingMatched = match !== undefined
                        if (match) fragment = `#${match.id}`
                    }
                    if (signal.aborted) return { ok: false, error: "aborted" }
                    const href = `${target}${fragment}`
                    void router.navigate({ href })
                    return { ok: true, href, headingMatched }
                }),
        },
        { signal },
    )
}
