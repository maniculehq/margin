import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { siteUrlFromRequest } from "@/lib/base-path"
import {
    discoveryJson,
    discoveryPreflight,
    mcpWellKnown,
} from "@/lib/mcp-discovery"
import { resolveSiteVersion } from "@/lib/source"

export const Route = createFileRoute("/.well-known/mcp")({
    server: {
        handlers: {
            OPTIONS: () => discoveryPreflight(),
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("mcp"))
                    return new Response("Not Found", { status: 404 })
                const head = await resolveSiteVersion(request)
                return discoveryJson(
                    request,
                    mcpWellKnown(head, siteUrlFromRequest(request)),
                )
            },
        },
    },
})
