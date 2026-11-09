import { useLocation } from "@tanstack/react-router"
import { HomeLayout } from "fumadocs-ui/layouts/home"
import { array, nullable, object, string } from "zod/mini"
import { AISearchPanelSlot } from "@/components/ai/search-context"
import { ChromeLink } from "@/components/chrome-link"
import { bandTabs, DocsHeader } from "@/components/docs-header"
import { HastBody } from "@/components/hast-body"
import { chromeStringsFor, useActiveLocale } from "@/lib/chrome-strings"
import { baseOptions, chromeMode, searchModeOf } from "@/lib/layout.shared"
import { Route as rootRoute } from "@/routes/__root"

/** notFound({ data }) payload thrown by routes/$.tsx serverLoader. */
export const notFoundDataSchema = object({
    suggestions: array(
        object({
            title: string(),
            url: string(),
            description: nullable(string()),
        }),
    ),
})

/**
 * Router `defaultNotFoundComponent` — receives TanStack's NotFoundRouteProps;
 * only `data` (the loader's notFound payload) is read, via schema.
 */
export function NotFound(props: { data?: unknown }) {
    // The root loader provides site branding, so 404s keep the normal
    // chrome. With no sidebar, HomeLayout also hosts sidenav navigation;
    // band sites keep their desktop band and mobile nav.
    const {
        siteName,
        layoutConfig,
        errors404,
        layoutPreset,
        defaultLanguage,
        locales,
        versionHomes,
        assistantAvailable,
    } = rootRoute.useLoaderData()
    // Pathname-derived: /fr/missing is a French 404 whose home is French —
    // the root loader's resolved locale home (authored /fr index, else the
    // locale nav's first landing page); hidden locales are not in `locales`
    // and keep the bare prefix. A version prefix (/v1/missing, /es/v1/missing)
    // keeps the visitor in that version's tree when its home serves.
    const locale = useActiveLocale()
    const pathname = useLocation({ select: (location) => location.pathname })
    const strings = chromeStringsFor(locale)
    const versionSegment = pathname.split("/").filter(Boolean)[
        locale === defaultLanguage ? 0 : 1
    ]
    const homeHref =
        versionHomes.find(
            (entry) =>
                entry.locale === locale && entry.label === versionSegment,
        )?.homeUrl ??
        locales.find((entry) => entry.locale === locale)?.homeUrl ??
        (locale === defaultLanguage ? "/" : `/${locale}`)
    // The AISearch provider (root route) already answers Ctrl/Cmd+I and the
    // search dialog's "Ask Assistant" here; without a panel slot those set
    // `open` with nothing to show. Docs pages mount their own slot (with
    // TOC suggestions) inside DocsLayout, so this one only exists on 404s.
    const searchMode = searchModeOf(layoutConfig, assistantAvailable)
    const suggestions = notFoundDataSchema.safeParse(props.data)
    const sidenav = chromeMode(layoutConfig) === "sidenav"
    const options = baseOptions({
        config: layoutConfig,
        siteName,
        versionsManifest: [],
    })
    const links = sidenav
        ? [
              ...bandTabs(layoutConfig)
                  .filter((tab) => tab.urls !== null)
                  .map((tab) => ({ text: tab.title, url: tab.href })),
              ...(options.links ?? []),
          ]
        : options.links
    const navTitle = options.nav?.title
    const logo = typeof navTitle === "function" ? siteName : navTitle
    return (
        <>
            {sidenav ? null : (
                <DocsHeader
                    logo={logo}
                    config={layoutConfig}
                    activeTabKey={null}
                    themeSwitchEnabled={
                        layoutConfig?.appearance?.strict !== true
                    }
                    layoutPreset={layoutPreset}
                    // A 404 has no counterpart page, so every locale links
                    // to its home; the switcher stays available here like on
                    // every normal page (review finding).
                    locales={
                        locales.length > 1
                            ? locales.map((entry) => ({
                                  locale: entry.locale,
                                  label: entry.name,
                                  href: entry.homeUrl,
                                  active: entry.locale === locale,
                              }))
                            : undefined
                    }
                />
            )}
            <HomeLayout {...options} links={links}>
                {/* Flex row so the assistant panel (lg: sticky, ms-auto)
                    docks beside the centred body like the docs grid's toc
                    column, instead of stacking under it. */}
                <div className="flex flex-1 lg:flex-row">
                    {/* id="nd-page": the global skip link's target — fumadocs
                    stamps it on docs articles; this route provides its own.
                    docs.json errors.404: the authored title + ingest-compiled
                    description replace the stock copy; closest-page
                    suggestions (loader data) follow either way. */}
                    <main
                        id="nd-page"
                        className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center"
                    >
                        <h1 className="font-semibold text-3xl">
                            {errors404?.title ?? strings.pageNotFound}
                        </h1>
                        {errors404?.descriptionHastJson ? (
                            <div className="prose text-fd-muted-foreground text-sm">
                                <HastBody
                                    hastJson={errors404.descriptionHastJson}
                                />
                            </div>
                        ) : (
                            // Plain-text fallback for descriptions whose
                            // markdown compilation failed at ingest.
                            <p className="text-fd-muted-foreground text-sm">
                                {errors404?.description ??
                                    strings.pageNotFoundBody}
                            </p>
                        )}
                        {suggestions.success &&
                        suggestions.data.suggestions.length > 0 ? (
                            <nav
                                aria-label={strings.suggestions}
                                className="mt-4 flex w-full flex-col gap-2 text-start"
                            >
                                {suggestions.data.suggestions.map((page) => (
                                    <ChromeLink
                                        key={page.url}
                                        href={page.url}
                                        data-suggestion=""
                                        className="flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm transition-colors hover:bg-fd-accent/50"
                                    >
                                        <span className="font-medium">
                                            {page.title}
                                        </span>
                                        {page.description ? (
                                            <span className="line-clamp-2 text-fd-muted-foreground">
                                                {page.description}
                                            </span>
                                        ) : null}
                                    </ChromeLink>
                                ))}
                            </nav>
                        ) : null}
                        <ChromeLink
                            href={homeHref}
                            className="mt-2 text-fd-primary text-sm underline underline-offset-4"
                        >
                            {strings.backToHome}
                        </ChromeLink>
                    </main>
                    {searchMode === "ai" ? <AISearchPanelSlot /> : null}
                </div>
            </HomeLayout>
        </>
    )
}
