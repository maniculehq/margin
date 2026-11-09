import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { buildSitemapMarkdown } from "@/lib/agent-surface"
import { siteUrlFromRequest } from "@/lib/base-path"
import { alternateTrees, resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/sitemap.md")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("sitemap"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                return new Response(
                    buildSitemapMarkdown(
                        siteUrlFromRequest(request),
                        ctx,
                        await alternateTrees(ctx),
                    ),
                    {
                        headers: {
                            "Content-Type": "text/markdown; charset=utf-8",
                            "Cache-Control": agentConfig.cache.header,
                        },
                    },
                )
            },
        },
    },
})
