import { createFileRoute } from "@tanstack/react-router"
import { agentConfig, isSurfaceEnabled } from "@/lib/agent.config"
import { skillCatalog, skillFileResponse } from "@/lib/agent-skills"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/.well-known/agent-skills/$name/$file")({
    server: {
        handlers: {
            GET: async ({ request, params }) => {
                if (!isSurfaceEnabled("skill"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                return skillFileResponse(
                    await skillCatalog(ctx, siteUrlFromRequest(request)),
                    params.name,
                    params.file,
                    agentConfig.cache.header,
                )
            },
        },
    },
})
