import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { buildSitemapXml } from "@/lib/agent-surface"
import { siteUrlFromRequest } from "@/lib/base-path"
import { alternateTrees, resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/sitemap.xml")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("sitemap"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                return new Response(
                    buildSitemapXml(
                        siteUrlFromRequest(request),
                        ctx,
                        await alternateTrees(ctx),
                    ),
                    {
                        headers: {
                            "Content-Type": "application/xml; charset=utf-8",
                            "Cache-Control": agentConfig.cache.header,
                        },
                    },
                )
            },
        },
    },
})
