import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { siteUrlFromRequest } from "@/lib/base-path"
import {
    discoveryJson,
    discoveryPreflight,
    mcpServerCard,
    SERVER_CARD_TYPE,
} from "@/lib/mcp-discovery"
import { resolveSiteVersion } from "@/lib/source"

/** The MCP Server Card at its recommended location,
 * `<streamable-http-url>/server-card` (SEP-2127). */
export const Route = createFileRoute("/api/mcp/server-card")({
    server: {
        handlers: {
            OPTIONS: () => discoveryPreflight(),
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("mcp"))
                    return new Response("Not Found", { status: 404 })
                const head = await resolveSiteVersion(request)
                return discoveryJson(
                    request,
                    mcpServerCard(head, siteUrlFromRequest(request)),
                    SERVER_CARD_TYPE,
                )
            },
        },
    },
})
