import { createFileRoute } from "@tanstack/react-router"
import { agentConfig } from "@/lib/agent.config"
import { withBase } from "@/lib/base-path"
import { resolveDocsContext } from "@/lib/source"

/**
 * Web app manifest from site branding (name, favicon, background token) —
 * what "Add to home screen" and Lighthouse's installability checks read.
 */
export const Route = createFileRoute("/manifest.webmanifest")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const ctx = await resolveDocsContext(request)
                const name = ctx.identity.name
                const favicon = ctx.config?.favicon
                const icon =
                    typeof favicon === "string" ? favicon : favicon?.light
                const background = ctx.themeTokens["--color-fd-background"]
                const backgroundColor =
                    typeof background === "string"
                        ? background
                        : background?.light
                const body = {
                    name,
                    short_name: name,
                    start_url: withBase("/"),
                    display: "browser",
                    ...(backgroundColor
                        ? {
                              background_color: backgroundColor,
                              theme_color: backgroundColor,
                          }
                        : {}),
                    icons: icon ? [{ src: withBase(icon), sizes: "any" }] : [],
                }
                return new Response(JSON.stringify(body), {
                    headers: {
                        "Content-Type":
                            "application/manifest+json; charset=utf-8",
                        "Cache-Control": agentConfig.cache.header,
                    },
                })
            },
        },
    },
})
