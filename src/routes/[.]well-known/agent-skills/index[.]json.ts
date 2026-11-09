import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { skillCatalog, skillsIndexBody } from "@/lib/agent-skills"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/.well-known/agent-skills/index.json")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("skill"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                const siteUrl = siteUrlFromRequest(request)
                return Response.json(
                    skillsIndexBody(
                        await skillCatalog(ctx, siteUrl),
                        siteUrl,
                        "v0.2.0",
                    ),
                    {
                        headers: {
                            "Cache-Control": agentConfig.cache.header,
                            "Access-Control-Allow-Origin": "*",
                        },
                    },
                )
            },
        },
    },
})
