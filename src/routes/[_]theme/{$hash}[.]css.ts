import { createFileRoute } from "@tanstack/react-router"
import { agentConfig } from "@/lib/agent.config"
import { basePath } from "@/lib/base-path"
import { resolveSiteVersion } from "@/lib/source"

/**
 * The site stylesheet (inlined font CSS + sanitized theme CSS), linked
 * from every document after the inline token block (__root.tsx). The URL is
 * content-addressed, so the current hash is immutable. Any other hash (a
 * document cached before a publish) gets the CURRENT CSS under the shared
 * policy: cacheTagMiddleware tags it for the publish purge, and a stale page
 * still renders with the site's styles instead of a 404. Under a base path
 * its root-relative `url(/_assets/…)` references get the prefix; the stored
 * CSS stays unprefixed.
 */
export async function getSiteCss(input: {
    request: Request
    params: { hash: string }
}): Promise<Response> {
    const head = await resolveSiteVersion(input.request)
    const base = basePath()
    const css = base
        ? head.siteCss.replace(
              /(url\(\s*["']?)(\/(?![/\\]))/gi,
              (_, lead: string, slash: string) => `${lead}${base}${slash}`,
          )
        : head.siteCss
    return new Response(css, {
        headers: {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control":
                input.params.hash === head.siteCssHash
                    ? "public, max-age=31536000, immutable"
                    : agentConfig.cache.header,
        },
    })
}

export const Route = createFileRoute("/_theme/{$hash}.css")({
    server: {
        handlers: {
            GET: getSiteCss,
        },
    },
})
