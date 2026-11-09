import { createFileRoute } from "@tanstack/react-router"
import {
    agentConfig,
    contentSignalValue,
    siteAgentSettings,
} from "@/lib/agent.config"
import { buildRobots } from "@/lib/agent-surface"
import { siteUrlFromRequest } from "@/lib/base-path"
import { resolveSiteVersion } from "@/lib/source"

export const Route = createFileRoute("/robots.txt")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                // Head only: its canonical-host redirect and the site's
                // content signals are what robots.txt inherits.
                const head = await resolveSiteVersion(request)
                const signal = contentSignalValue(
                    siteAgentSettings(head.config).contentSignals,
                )
                return new Response(
                    buildRobots(siteUrlFromRequest(request), signal),
                    {
                        headers: {
                            "Content-Type": "text/plain; charset=utf-8",
                            "Cache-Control": agentConfig.cache.header,
                        },
                    },
                )
            },
        },
    },
})
