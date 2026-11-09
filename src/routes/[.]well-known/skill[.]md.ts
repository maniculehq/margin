import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { agentDocResponse } from "@/lib/agent-skill"
import { skillDocument } from "@/lib/agent-skills"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

export const Route = createFileRoute("/.well-known/skill.md")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("skill"))
                    return new Response("Not Found", { status: 404 })
                const ctx = await resolveDocsContext(request)
                return agentDocResponse(
                    await skillDocument(ctx, siteUrlFromRequest(request)),
                )
            },
        },
    },
})
