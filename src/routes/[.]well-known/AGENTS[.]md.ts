import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { agentDocResponse, renderAgents } from "@/lib/agent-skill"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/.well-known/AGENTS.md")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("skill"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                return agentDocResponse(
                    renderAgents(siteUrlFromRequest(request), ctx),
                )
            },
        },
    },
})
