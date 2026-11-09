import { createFileRoute } from "@tanstack/react-router"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { siteUrlFromRequest } from "@/lib/base-path"
import {
    discoveryJson,
    discoveryPreflight,
    SERVER_CARD_TYPE,
} from "@/lib/mcp-discovery"

/**
 * Domain-level AI Catalog: how an MCP client finds this host's server card
 * without guessing its URL (the SEP-2127 discovery path). One entry, the
 * docs MCP server, identified by the serving host.
 */
export const Route = createFileRoute("/.well-known/ai-catalog.json")({
    server: {
        handlers: {
            OPTIONS: () => discoveryPreflight(),
            GET: ({ request }) => {
                if (!isSurfaceEnabled("mcp"))
                    return new Response("Not Found", { status: 404 })
                const siteUrl = siteUrlFromRequest(request)
                return discoveryJson(
                    request,
                    {
                        specVersion: "1.0",
                        entries: [
                            {
                                identifier: `urn:air:${new URL(siteUrl).hostname}:mcp:docs`,
                                type: SERVER_CARD_TYPE,
                                url: `${siteUrl}/api/mcp/server-card`,
                            },
                        ],
                    },
                    "application/ai-catalog+json",
                )
            },
        },
    },
})
