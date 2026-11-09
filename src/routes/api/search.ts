import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { agentConfig } from "@/lib/agent.config"
import { normalizeDocUrl, searchServerFor } from "@/lib/agent-content"
import { emitEvent } from "@/lib/observability"
import { resolveDocsContext } from "@/lib/source"

// The per-version Orama index lives in agent-content.ts so the HTTP route, the
// Ask-AI chat tool, and MCP search_docs all share one index per content version.
export const Route = createFileRoute("/api/search")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const path = new URL(request.url).searchParams.get("path") ?? ""
                const slugs = normalizeDocUrl(path)
                const ctx = await resolveDocsContext(request, slugs)
                const response = await (await searchServerFor(ctx, slugs)).GET(
                    request,
                )
                // Page groups only (each page row is followed by its heading
                // and text rows), so 0 marks a search that found nothing. The
                // body is a small in-memory JSON array; a non-array (an error
                // body) reports null rather than a false zero.
                const rows = z
                    .array(z.looseObject({ type: z.string() }))
                    .safeParse(
                        await response
                            .clone()
                            .json()
                            .catch(() => null),
                    )
                emitEvent(request, {
                    type: "docs_searched",
                    result_count: rows.success
                        ? rows.data.filter((row) => row.type === "page").length
                        : null,
                    ...(agentConfig.observability.includeInputs
                        ? {
                              query: new URL(request.url).searchParams.get(
                                  "query",
                              ),
                          }
                        : {}),
                })
                // Content versions are immutable, so identical queries are
                // CDN-cacheable — the same shared-policy header the agent
                // context bundle uses (repeated cold first
                // searches). start.ts's cacheMiddleware skips /api paths.
                response.headers.set("Cache-Control", agentConfig.cache.header)
                return response
            },
        },
    },
})
