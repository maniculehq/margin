import type { CommandName } from "just-bash"
import { LRUCache } from "lru-cache"
import { pageBreadcrumbs } from "./agent-content"
import { basePath, withBase, withBaseInMarkdown } from "./base-path"
import {
    type DocPage,
    type DocsContext,
    openapiDocument,
    openapiDocumentIndex,
    processedMarkdownForPages,
    sourceForActiveVersion,
} from "./source"

/**
 * Read-only text tools only: the filesystem is rebuilt for every call, so a
 * write could never persist, but nothing outside reading belongs in a tool
 * that advertises `readOnlyHint`. No network, no interpreters.
 */
export const DOCS_FS_COMMANDS = [
    "ls",
    "tree",
    "find",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "sed",
    "awk",
    "sort",
    "uniq",
    "cut",
    "tr",
    "nl",
    "column",
    "jq",
    "xargs",
    "basename",
    "dirname",
    "echo",
    "printf",
    "true",
    "false",
    "help",
] as const satisfies readonly CommandName[]

/** Output an agent can still read in one tool result; the rest is cut with a note. */
export const DOCS_FS_MAX_OUTPUT = 40_000

/**
 * Character budget for one tree's page bodies. A shell over the docs needs
 * every body in memory (rg reads them all), but that memory sits outside
 * just-bash's own limits — so a corpus is loaded only up to this budget
 * (later pages read as a pointer to read_page), and the cross-call cache is
 * bounded by the same measure rather than by entry count.
 */
const CORPUS_MAX_CHARS = 32_000_000

/**
 * Loaded corpora, shared by later calls for the same (site, version,
 * locale, version label). Sized in characters: one oversized entry is never
 * retained, and four large trees can't pile up past the budget.
 */
const corpora = new LRUCache<string, Map<string, string>>({
    maxSize: CORPUS_MAX_CHARS,
    sizeCalculation: (bodies) => {
        let size = 1
        for (const body of bodies.values()) size += body.length
        return size
    },
})

/** Loads still running, so concurrent cold calls for one tree share a
 * single read (and a single in-memory copy) instead of each building one. */
const loading = new Map<string, Promise<Map<string, string>>>()

function corpusFor(
    ctx: DocsContext,
    label: string | null,
    pages: DocPage[],
): Promise<Map<string, string>> {
    const key = `${ctx.site.id}:${ctx.versionId ?? "none"}:${ctx.activeLocale ?? ""}:${label ?? ""}`
    const cached = corpora.get(key)
    if (cached) return Promise.resolve(cached)
    const inFlight = loading.get(key)
    if (inFlight) return inFlight
    const versionId = ctx.versionId
    const load = (async () => {
        const bodies = new Map<string, string>()
        if (!versionId) return bodies
        let size = 0
        for (
            let start = 0;
            start < pages.length && size < CORPUS_MAX_CHARS;
            start += 200
        ) {
            const chunk = await processedMarkdownForPages(
                versionId,
                pages
                    .slice(start, start + 200)
                    .map((page) => page.data.sourcePath),
            )
            for (const [path, body] of chunk) {
                if (size + body.length > CORPUS_MAX_CHARS) break
                bodies.set(path, body)
                size += body.length
            }
        }
        corpora.set(key, bodies)
        return bodies
    })().finally(() => loading.delete(key))
    loading.set(key, load)
    return load
}

/**
 * Run one read-only shell command over a virtual filesystem of the docs:
 * every page at its `.md` URL path (title + breadcrumb + processed markdown),
 * every OpenAPI document under `/_openapi/<docId>.json`, and any extra files
 * (skills) the caller supplies. just-bash is an in-process interpreter — no
 * VM, no host filesystem — and loads lazily so it never weighs on a cold
 * start that doesn't call the tool.
 */
export async function queryDocsFilesystem(
    ctx: DocsContext,
    slugs: string[],
    command: string,
    extraFiles: Record<string, string>,
): Promise<{
    stdout: string
    stderr: string
    exitCode: number
    truncated: boolean
}> {
    // The tree the scope names — a non-default version is its own source,
    // not the default tree's pages.
    const label = ctx.activeVersion(slugs)
    const pages = (await sourceForActiveVersion(ctx, slugs)).getPages()
    let corpus: Promise<Map<string, string>> | undefined
    const files: Record<string, () => Promise<string>> = {}
    // Files sit at the pages' public paths (under the base path, like the
    // URLs search_docs and list_docs return), so a result's URL plus .md is
    // the file. Their links get the same prefix when read, so a link maps
    // to a file; the shared corpus stays unprefixed.
    const base = basePath()
    for (const page of pages) {
        files[withBase(page.url === "/" ? "/index.md" : `${page.url}.md`)] =
            async () => {
                corpus ??= corpusFor(ctx, label, pages)
                const body = (await corpus).get(page.data.sourcePath)
                const trail = pageBreadcrumbs(ctx, page)
                    .map((crumb) => crumb.name)
                    .join(" › ")
                return `# ${page.data.pageTitle}\n\n${trail ? `Section: ${trail}\n\n` : ""}${body === undefined ? `(This page is past the filesystem's size budget — read it with read_page: ${withBase(page.url)})\n` : withBaseInMarkdown(body, base)}`
            }
    }
    for (const { docId } of await openapiDocumentIndex(ctx)) {
        files[`/_openapi/${docId}.json`] = async () =>
            JSON.stringify(await openapiDocument(ctx, docId), null, 2)
    }
    for (const [path, body] of Object.entries(extraFiles))
        files[path] = async () => body

    const { Bash } = await import("just-bash")
    const bash = new Bash({
        files,
        cwd: "/",
        commands: [...DOCS_FS_COMMANDS],
        executionLimitProfile: "hardened",
        executionLimits: { maxExecutionTimeMs: 5_000 },
    })
    const result = await bash.exec(command)
    const truncated = result.stdout.length > DOCS_FS_MAX_OUTPUT
    return {
        stdout: truncated
            ? `${result.stdout.slice(0, DOCS_FS_MAX_OUTPUT)}\n… output truncated at ${DOCS_FS_MAX_OUTPUT} characters — narrow the command (head, rg -l, a tighter path).`
            : result.stdout,
        stderr: result.stderr.slice(0, 4_000),
        exitCode: result.exitCode,
        truncated,
    }
}
