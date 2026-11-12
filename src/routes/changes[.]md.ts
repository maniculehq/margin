import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { orderedPages, slugsToMarkdownPath } from "@/lib/agent-content"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

// Since-timestamp changelog feed so agents fetch only what changed.
export const Route = createFileRoute("/changes.md")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("changes"))
                    return new Response("Not Found", { status: 404 })
                const headers = {
                    "Content-Type": "text/markdown; charset=utf-8",
                    "Cache-Control": agentConfig.cache.header,
                }
                const sinceParam = new URL(request.url).searchParams.get(
                    "since",
                )
                // Not z.coerce.date(): `new Date` reads "1.4.0" and "Release 7"
                // as dates, rolls 30 February into March, and reads a time
                // with no zone in the server's own zone.
                const sinceParse = sinceParam
                    ? z
                          .union([
                              z.iso.date(),
                              z.iso.datetime({ offset: true }),
                          ])
                          .transform((value) => new Date(value))
                          .safeParse(sinceParam)
                    : null
                if (sinceParse && !sinceParse.success)
                    return new Response(
                        "# Invalid since\n\nPass an ISO 8601 date, such as 2026-01-31, or a time with its zone, such as 2026-01-31T12:00:00Z or 2026-01-31T12:00:00+02:00.\n",
                        { status: 400, headers },
                    )
                const since = sinceParse?.data ?? null
                const siteUrl = siteUrlFromRequest(request)
                const ctx = await resolveDocsContext(request)

                const changed = orderedPages(ctx)
                    .map((page) => ({ page, at: page.data.lastModified }))
                    .filter((entry) => !since || entry.at > since)
                    .sort((a, b) => b.at.getTime() - a.at.getTime())

                const body = [
                    `# Changes`,
                    "",
                    changed.length > 0
                        ? since
                            ? `Pages changed since ${since.toISOString()}:`
                            : "Recently changed pages:"
                        : since
                          ? `No pages changed since ${since.toISOString()}.`
                          : "No pages yet.",
                    "",
                    ...changed.map(
                        ({ page, at }) =>
                            `- [${page.data.pageTitle}](${siteUrl + slugsToMarkdownPath(page.slugs).url}) — ${at.toISOString().slice(0, 10)}`,
                    ),
                    "",
                ].join("\n")

                return new Response(body, { headers })
            },
        },
    },
})
