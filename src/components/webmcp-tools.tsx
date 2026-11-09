import { getRouteApi, useLocation, useRouter } from "@tanstack/react-router"
import type { Root } from "fumadocs-core/page-tree"
import { useEffect, useRef } from "react"
import { activeLocaleOf } from "@/lib/chrome-strings"
import { loadWebmcpTools } from "@/lib/webmcp"
import type { DocsWebmcpState } from "./docs-webmcp"

const rootRoute = getRouteApi("__root__")

export function DocsWebmcpTools({
    title,
    pageUrl,
}: {
    tree: Root
    title: string
    pageUrl: string
}) {
    const pathname = useLocation({ select: (location) => location.pathname })
    const router = useRouter()
    const rootData = rootRoute.useLoaderData()
    // Search keys on the locale + version prefix alone — the only part of
    // `path` /api/search reads — so every page of a tree shares CDN entries
    // (same derivation as search-dialog.tsx).
    const locale = activeLocaleOf(pathname, rootData)
    const localeBase = locale === rootData.defaultLanguage ? "" : `/${locale}`
    const versionSegment = pathname.split("/")[localeBase ? 2 : 1]
    const searchScope = rootData.pathVersions.some(
        (entry) => entry.locale === locale && entry.label === versionSegment,
    )
        ? `${localeBase}/${versionSegment}`
        : localeBase || "/"
    const latest = useRef<DocsWebmcpState>({ pathname, title, pageUrl })
    latest.current = { pathname, title, pageUrl }

    // Mounted only when the loader's site flag is on (routes/$.tsx), so the
    // gate here is already answered.
    useEffect(
        () =>
            loadWebmcpTools(true, (signal) =>
                import("./docs-webmcp").then((tools) =>
                    tools.registerDocsTools(
                        latest,
                        pathname,
                        searchScope,
                        router,
                        signal,
                    ),
                ),
            ),
        [pathname, router, searchScope],
    )

    return null
}
