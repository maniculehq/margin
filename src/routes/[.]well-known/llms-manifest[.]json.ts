import { createFileRoute } from "@tanstack/react-router"
import { agentConfig } from "@/lib/agent.config"
import { buildLlmsManifest } from "@/lib/agent-content"
import { siteUrlFromRequest } from "@/lib/base-path"
import { openapiDocumentIndex, resolveDocsContext } from "@/lib/source"

// Reachability-accurate agent discovery manifest. Deliberately NOT
// /.well-known/agent.json (which collides with the A2A agent-card schema).
export const Route = createFileRoute("/.well-known/llms-manifest.json")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const siteUrl = siteUrlFromRequest(request)
                const ctx = await resolveDocsContext(request)
                return new Response(
                    JSON.stringify(
                        buildLlmsManifest(
                            siteUrl,
                            ctx,
                            (await openapiDocumentIndex(ctx)).length > 0,
                        ),
                        null,
                        2,
                    ),
                    {
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            "Cache-Control": agentConfig.cache.header,
                        },
                    },
                )
            },
        },
    },
})
