import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { siteUrlFromRequest } from "@/lib/base-path"
import {
    compatServerCard,
    discoveryJson,
    discoveryPreflight,
} from "@/lib/mcp-discovery"
import { resolveSiteVersion } from "@/lib/source"

/** Mintlify-compatible server cards (one per endpoint), with live tool
 * definitions. The standard card lives at /api/mcp/server-card. */
export const Route = createFileRoute("/.well-known/mcp/server-cards.json")({
    server: {
        handlers: {
            OPTIONS: () => discoveryPreflight(),
            GET: async ({ request }) => {
                if (!isSurfaceEnabled("mcp"))
                    return new Response("Not Found", { status: 404 })
                const head = await resolveSiteVersion(request)
                const card = await compatServerCard(
                    request,
                    head,
                    siteUrlFromRequest(request),
                )
                return discoveryJson(request, [card])
            },
        },
    },
})
