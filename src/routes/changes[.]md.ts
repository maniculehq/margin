import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { orderedPages, slugsToMarkdownPath } from "@/lib/agent-content"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

// Since-timestamp changelog feed so agents fetch only what changed.
// Requires git history (page.data.lastModified); pages without a date are omitted.
export const Route = createFileRoute("/changes.md")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("changes"))
                    return new Response("Not Found", { status: 404 })
                const url = new URL(request.url)
                const siteUrl = siteUrlFromRequest(request)
                const ctx = await resolveDocsContext(request)
                const sinceParam = url.searchParams.get("since")
                const since = sinceParam ? new Date(sinceParam) : null

                const changed = orderedPages(ctx)
                    .map((page) => ({ page, at: page.data.lastModified }))
                    .filter((entry) => !since || entry.at > since)
                    .sort((a, b) => b.at.getTime() - a.at.getTime())

                const body = [
                    `# Changes`,
                    "",
                    since
                        ? `Pages changed since ${since.toISOString()}:`
                        : "Recently changed pages:",
                    "",
                    ...changed.map(
                        ({ page, at }) =>
                            `- [${page.data.pageTitle}](${siteUrl + slugsToMarkdownPath(page.slugs).url}) — ${at.toISOString().slice(0, 10)}`,
                    ),
                    changed.length === 0
                        ? "_No changes found (git history may be unavailable at build)._"
                        : "",
                    "",
                ].join("\n")

                return new Response(body, {
                    headers: {
                        "Content-Type": "text/markdown; charset=utf-8",
                        "Cache-Control": agentConfig.cache.header,
                    },
                })
            },
        },
    },
})
