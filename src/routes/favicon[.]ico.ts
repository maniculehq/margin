import { createFileRoute } from "@tanstack/react-router"
import { agentConfig } from "@/lib/agent.config"
import { withBase } from "@/lib/base-path"
import { resolveSiteVersion } from "@/lib/source"

/**
 * Browsers and link previewers probe /favicon.ico regardless of <link
 * rel=icon>; a 404 here shows a blank tab icon in those clients. Point the
 * probe at the site's ingest-hashed favicon. The site's version decides the
 * target, so both answers keep the shared policy and the cache tag, and the
 * publish purge clears them when the favicon changes.
 */
export const Route = createFileRoute("/favicon.ico")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const ctx = await resolveSiteVersion(request)
                const favicon = ctx.config?.favicon
                const href =
                    typeof favicon === "string" ? favicon : favicon?.light
                if (!href)
                    return new Response("Not Found", {
                        status: 404,
                        headers: { "Cache-Control": agentConfig.cache.header },
                    })
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: withBase(href),
                        "Cache-Control": agentConfig.cache.header,
                    },
                })
            },
        },
    },
})
