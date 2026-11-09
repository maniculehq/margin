import { useRouter } from "@tanstack/react-router"
import type { ComponentProps } from "react"
import { withBase } from "@/lib/base-path"

/** SPA navigation without TanStack Link's prefix-active `aria-current="page"`,
 * which marks ancestor chrome as the current page. Chrome links manage their
 * own current state; external URLs use native navigation. `href` is the
 * internal path: the anchor carries it under the site's base path, while
 * router.navigate takes it as is (the router's rewrite adds the base). */
export function ChromeLink(props: ComponentProps<"a">) {
    const router = useRouter()
    const { onClick, ...rest } = props
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: href is always present in props — this is a real link, not a static element
        // biome-ignore lint/a11y/useKeyWithClickEvents: native anchor keyboard activation fires onClick; no extra key handler needed
        <a
            {...rest}
            href={rest.href === undefined ? undefined : withBase(rest.href)}
            // biome-ignore lint/a11y/useValidAnchor: onClick only intercepts left-clicks for SPA nav; the href still drives navigation
            onClick={(event) => {
                onClick?.(event)
                if (event.defaultPrevented || event.button !== 0) return
                if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                )
                    return
                // Single-slash paths only: protocol-relative URLs
                // ("//example.com") are external navigations.
                if (!rest.href?.startsWith("/") || rest.href.startsWith("//"))
                    return
                event.preventDefault()
                void router.navigate({ href: rest.href })
            }}
        />
    )
}
