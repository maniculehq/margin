import { getRouteApi, useLocation, useRouter } from "@tanstack/react-router"
import type { ReactSortedResult } from "fumadocs-core/search"
import { useDocsSearch, useHighlightQuery } from "fumadocs-core/search/client"
import { fetchClient } from "fumadocs-core/search/client/fetch"
import {
    SearchDialog,
    SearchDialogClose,
    SearchDialogContent,
    SearchDialogHeader,
    SearchDialogIcon,
    SearchDialogList,
    SearchDialogListItem,
    SearchDialogOverlay,
    type SearchItemType,
    type SharedProps,
    useSearch,
} from "fumadocs-ui/components/dialog/search"
import {
    type ReactNode,
    use,
    useEffect,
    useEffectEvent,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react"
import { createPortal } from "react-dom"
import { AISearchActionsContext } from "@/components/ai/search-context"
import {
    FileTextIcon,
    MessageCircleIcon,
    XIcon,
} from "@/components/chrome-icons"
import { withBase } from "@/lib/base-path"
import { activeLocaleOf, useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import type { BrowserEvent } from "@/routes/api/agent.event"

/**
 * Page-hit titles arrive as markdown strings with `<mark>` highlight tags
 * (fumadocs' highlighter output). Render the marks as real elements.
 */
function markedText(content: ReactNode): ReactNode {
    if (typeof content !== "string" || !content.includes("<mark>"))
        return content
    return content.split(/<mark>(.*?)<\/mark>/g).map((part, index) =>
        index % 2 === 1 ? (
            <mark
                // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string, never reorders
                key={index}
                className="rounded-sm bg-fd-primary/15 text-fd-primary"
            >
                {part}
            </mark>
        ) : (
            part
        ),
    )
}

/** Real anchor rows preserve native modified clicks and link previews while
 * plain clicks still close the dialog and navigate through `onSelect`. */
function ResultLink({
    item,
    onClick,
    children,
}: {
    item: SearchItemType
    onClick: () => void
    children: ReactNode
}) {
    const { query, getActive, setActive, subscribeActive } = useSearch()
    const highlight = useHighlightQuery(query)
    const isActive = () => item.id === getActive()
    const active = useSyncExternalStore(subscribeActive, isActive, isActive)
    if (item.type === "action") {
        // Actions carry no URL — keep the stock button row.
        return (
            <SearchDialogListItem
                item={item}
                onClick={onClick}
                className="flex-row items-center gap-3 py-2.5"
            />
        )
    }
    return (
        <a
            // Results carry the router's paths; onSelect navigates through
            // the router, which adds the base path itself.
            href={withBase(item.url)}
            data-active={active}
            ref={(element) => {
                if (active && element)
                    element.scrollIntoView({ block: "nearest" })
                return highlight(element)
            }}
            className={cn(
                "relative flex shrink-0 select-none flex-row items-center gap-3 overflow-hidden rounded-lg px-2.5 py-2.5 text-start text-sm",
                active && "bg-fd-accent text-fd-accent-foreground",
            )}
            onPointerMove={() => setActive(item.id)}
            onClick={(event) => {
                if (event.defaultPrevented) return
                if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                )
                    return
                event.preventDefault()
                onClick()
            }}
        >
            {children}
        </a>
    )
}

/** fumadocs' SearchDialogInput hardcodes its i18n placeholder AFTER the
 * props spread — a bare input against the same context restores control. */
function DialogInput(props: { placeholder?: string }) {
    const { search, onSearchChange } = useSearch()
    const strings = useChromeStrings()
    return (
        <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={props.placeholder ?? strings.search}
            className="w-0 flex-1 bg-transparent text-lg placeholder:text-fd-muted-foreground focus-visible:outline-none"
        />
    )
}

const rootRoute = getRouteApi("__root__")

/** Fumadocs dialog customized for page-level results, indexed breadcrumbs,
 * keyboard hints, and the current locale/version scope. Sending that scope
 * keeps versioned tenants searching the version currently served. */
export function DocsSearchDialog({
    prompt,
    ...props
}: SharedProps & {
    /** docs.json search.prompt — tenant placeholder copy. */
    prompt?: string
}) {
    const pathname = useLocation({ select: (location) => location.pathname })
    const rootData = rootRoute.useLoaderData()
    const strings = useChromeStrings()
    // Null when x-margin.search.mode !== "ai" — no "Ask Assistant" row.
    const assistant = use(AISearchActionsContext)
    // Portal target: fumadocs' SearchDialog renders Radix overlay/content
    // in place (no DialogPortal), which leaves the modal subject to any
    // ancestor stacking context/containing block — the audited "dialog in
    // the accessibility tree but invisible on screen" trap. Portaling to
    // document.body makes it immune; Radix context flows through React
    // portals. The dialog only ever opens client-side, so the null SSR
    // branch never hides an open dialog.
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
    useEffect(() => {
        setPortalTarget(document.body)
    }, [])
    // Belt-and-suspenders dismissal: the audit found Escape and the close
    // button unable to restore the page. Radix's DismissableLayer normally
    // handles Escape; this window-level capture listener guarantees a
    // second, independent path out of the modal state.
    const { open, onOpenChange } = props
    // Focus return (WCAG 2.4.3): the dialog opens from context state, not a
    // Radix Dialog.Trigger, so Radix's close handler has no trigger to
    // refocus and drops focus to <body>. onOpenAutoFocus fires before focus
    // moves into the dialog, so activeElement is still the opener (the
    // header button, or whatever held focus when Cmd+K fired).
    const opener = useRef<HTMLElement | null>(null)
    useEffect(() => {
        if (!open) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            // Mark the event consumed: layered surfaces below (the mobile
            // drawer's Escape close) must not ALSO dismiss on the same
            // keypress — React can flush this dialog's unmount before
            // bubble-phase listeners run, so a DOM open-dialog check alone
            // is racy.
            event.preventDefault()
            onOpenChange(false)
        }
        window.addEventListener("keydown", onKeyDown, true)
        return () => window.removeEventListener("keydown", onKeyDown, true)
    }, [open, onOpenChange])
    // The server reads only the locale and version prefix from `path`
    // (source.ts resolveActiveLocale/resolveActiveVersion), so send exactly
    // that: one query typed on any page of a tree hits one CDN entry
    // instead of one per page URL.
    const locale = activeLocaleOf(pathname, rootData)
    const localeBase = locale === rootData.defaultLanguage ? "" : `/${locale}`
    const versionSegment = pathname.split("/")[localeBase ? 2 : 1]
    const scopePath = rootData.pathVersions.some(
        (entry) => entry.locale === locale && entry.label === versionSegment,
    )
        ? `${localeBase}/${versionSegment}`
        : localeBase || "/"
    const client = useMemo(
        () =>
            fetchClient({
                // `path` is a public path, as every inbound one is
                // (normalizeDocUrl strips the base path).
                api: withBase(
                    `/api/search?path=${encodeURIComponent(withBase(scopePath))}`,
                ),
            }),
        [scopePath],
    )
    const { search, setSearch, query } = useDocsSearch({ client })
    // ?search= URL state: official sites keep the query in the
    // URL, making search shareable and history-restorable. The root route
    // validates the param; SearchDeepLink opens this lazy dialog when it is
    // present, and the URL effect below seeds the query from it.
    const urlSearch = rootRoute.useSearch({ select: (params) => params.search })
    const router = useRouter()
    // Mirror writes still committing. A URL value that lands while one is in
    // flight is this dialog's own echo (possibly an older keystroke), never
    // an external change to adopt.
    const writing = useRef(0)
    // Nothing is mirrored until the URL has seeded the query on mount;
    // otherwise the empty initial query would strip a deep link's param.
    const seeded = useRef(false)
    const mirrorToUrl = useEffectEvent((next: string | undefined) => {
        if (!seeded.current) return
        // latestLocation, not the committed urlSearch: it already holds
        // in-flight writes and a result click's pending push, whose target
        // page carries no ?search= to strip.
        if (next === router.latestLocation.search.search) return
        writing.current += 1
        void router
            .navigate({
                // The exact current path: the splat route re-interpolated from
                // its params could re-spell a trailing slash or an encoding.
                to: ".",
                unsafeRelative: "path",
                search: (previous) => ({ ...previous, search: next }),
                hash: true,
                replace: true,
                // Typing must not move the page: no scroll reset and no jump to
                // the URL's #fragment on every keystroke.
                resetScroll: false,
                hashScrollIntoView: false,
            })
            .finally(() => {
                writing.current -= 1
            })
    })
    // While open, the query mirrors into the URL; closing strips it. Runs
    // before the URL effect so a keystroke batched with an older echo counts
    // as in flight.
    useEffect(() => {
        mirrorToUrl(open && search ? search : undefined)
    }, [open, search])
    // The URL changed under the dialog: the mount-time deep link, or
    // Back/Forward to an entry with a different (or no) query.
    const adoptUrl = useEffectEvent((value: string | undefined) => {
        seeded.current = true
        if (writing.current > 0) return
        if (value === (open && search ? search : undefined)) return
        if (value === undefined) {
            onOpenChange(false)
            return
        }
        setSearch(value)
        onOpenChange(true)
    })
    useEffect(() => {
        adoptUrl(urlSearch)
    }, [urlSearch])
    const results = useMemo(() => {
        if (!Array.isArray(query.data)) return null
        const term = search.trim().toLowerCase()
        // Orama ranks groups by their best CONTENT hit, which puts pages
        // that merely mention the term often above the page NAMED for it
        // ("install" ranked reference stubs over bun install). Boost title
        // matches to the top; Orama order breaks ties.
        const score = (content: ReactNode) => {
            if (typeof content !== "string" || term.length === 0) return 0
            const title = content.replaceAll(/<\/?mark>/g, "").toLowerCase()
            if (title === term || title.startsWith(term)) return 2
            return title.includes(term) ? 1 : 0
        }
        // Fumadocs 16.17 returns unhighlighted Markdown; the result row's
        // useHighlightQuery paints matches. Retain the fuzzy-hit filter by
        // checking the same whitespace-separated literal query terms.
        const terms = term.split(/\s+/).filter(Boolean)
        const matched = (content: ReactNode) =>
            typeof content === "string" &&
            terms.some((word) => content.toLowerCase().includes(word))
        // Advanced search returns groups: one page row followed by that
        // page's heading/text rows, in Orama order.
        const groups: {
            page: ReactSortedResult
            sections: ReactSortedResult[]
            index: number
        }[] = []
        for (const item of query.data) {
            if (item.type === "page")
                groups.push({ page: item, sections: [], index: groups.length })
            else groups.at(-1)?.sections.push(item)
        }
        const items = groups
            .map((group) => ({
                page: group.page,
                index: group.index,
                score: score(group.page.content),
                sections: group.sections
                    .filter((section) => matched(section.content))
                    .slice(0, 3),
            }))
            // A group with no literal query match is a fuzzy false positive
            // ("typo qwzrt" surfacing "Bundler").
            .filter(
                (group) =>
                    matched(group.page.content) || group.sections.length > 0,
            )
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .flatMap((group) => [group.page, ...group.sections])
        return {
            items,
            pageCount: items.filter((item) => item.type === "page").length,
        }
    }, [query.data, search])
    const items = useMemo<SearchItemType[] | null>(() => {
        if (!results) return null
        const ask = search.trim()
        // The first row hands the query to the Assistant.
        // Selecting closes search and opens the panel prefilled — the
        // visitor still presses Enter there.
        const action: SearchItemType[] =
            assistant && ask.length > 0
                ? [
                      {
                          id: "ask-assistant",
                          type: "action",
                          node: (
                              <>
                                  <MessageCircleIcon className="me-2 size-4 shrink-0 text-fd-primary" />
                                  <span className="min-w-0 truncate font-medium">
                                      {strings.askAssistant}
                                      <span className="ms-1.5 font-normal text-fd-muted-foreground">
                                          “{ask}”
                                      </span>
                                  </span>
                              </>
                          ),
                          onSelect: () => {
                              onOpenChange(false)
                              assistant.ask(ask)
                          },
                      },
                  ]
                : []
        return [...action, ...results.items]
    }, [results, search, assistant, strings.askAssistant, onOpenChange])
    return (
        <SearchDialog
            search={search}
            onSearchChange={setSearch}
            isLoading={query.isLoading}
            // fumadocs routes both clicks and Enter through onSelect, after
            // its own navigation; a modifier-click opens natively and
            // bypasses it. The query itself never leaves the browser.
            onSelect={(item) => {
                if (item.type === "action" || !results) return
                const position = results.items.findIndex(
                    (result) => result.id === item.id,
                )
                if (position === -1) return
                const beacon = JSON.stringify({
                    type: "docs_search_result_clicked",
                    page_path: pathname,
                    result_position: position + 1,
                    result_count: results.items.length,
                    result_type: item.type,
                    target_path: item.url.split(/[?#]/)[0] ?? "/",
                } satisfies BrowserEvent)
                if (!navigator.sendBeacon(withBase("/api/agent/event"), beacon))
                    void fetch(withBase("/api/agent/event"), {
                        method: "POST",
                        body: beacon,
                        keepalive: true,
                    }).catch(() => {})
            }}
            {...props}
        >
            {portalTarget === null
                ? null
                : createPortal(
                      <>
                          <SearchDialogOverlay className="backdrop-blur-none" />
                          <SearchDialogContent
                              onOpenAutoFocus={() => {
                                  opener.current =
                                      document.activeElement instanceof
                                          HTMLElement &&
                                      document.activeElement !== document.body
                                          ? document.activeElement
                                          : null
                              }}
                              onCloseAutoFocus={(event) => {
                                  const target = opener.current
                                  opener.current = null
                                  if (!target?.isConnected) return
                                  event.preventDefault()
                                  target.focus()
                              }}
                          >
                              <SearchDialogHeader>
                                  <SearchDialogIcon />
                                  <DialogInput placeholder={prompt} />
                                  {/* "ESC" means nothing on touch; touch
                                      layouts get an X instead. */}
                                  <SearchDialogClose className="[@media(hover:none)]:hidden" />
                                  <SearchDialogClose className="hidden px-2 [@media(hover:none)]:inline-flex">
                                      <XIcon className="size-4" />
                                  </SearchDialogClose>
                              </SearchDialogHeader>
                              <SearchDialogList
                                  // h-auto replaces fumadocs' JS-measured
                                  // h-(--fd-animated-height): a stuck/zero measurement
                                  // collapsed the list visually while results stayed in
                                  // the accessibility tree. The
                                  // height animation is cosmetic; correctness wins.
                                  className="h-auto"
                                  items={items}
                                  // The empty notice renders below the list
                                  // (not via fumadocs' Empty slot) so it also
                                  // shows when the "Ask Assistant" action row
                                  // keeps the array non-empty.
                                  Empty={() => null}
                                  Item={({ item, onClick }) =>
                                      item.type === "heading" ||
                                      item.type === "text" ? (
                                          // Section hit: indented under its
                                          // page; url carries the #anchor.
                                          <ResultLink
                                              item={item}
                                              onClick={onClick}
                                          >
                                              <span
                                                  aria-hidden
                                                  className="ms-2 h-5 w-px shrink-0 bg-fd-border"
                                              />
                                              <span className="line-clamp-2 min-w-0 text-fd-muted-foreground text-sm">
                                                  {markedText(item.content)}
                                              </span>
                                          </ResultLink>
                                      ) : (
                                          <ResultLink
                                              item={item}
                                              onClick={onClick}
                                          >
                                              <FileTextIcon className="size-4 shrink-0 text-fd-muted-foreground" />
                                              {item.type === "action" ? null : (
                                                  <span className="min-w-0">
                                                      <span className="block truncate font-medium text-sm">
                                                          {markedText(
                                                              item.content,
                                                          )}
                                                      </span>
                                                      {item.breadcrumbs &&
                                                      item.breadcrumbs.length >
                                                          0 ? (
                                                          <span className="block truncate text-fd-muted-foreground text-xs">
                                                              {item.breadcrumbs.join(
                                                                  " › ",
                                                              )}
                                                          </span>
                                                      ) : null}
                                                  </span>
                                              )}
                                          </ResultLink>
                                      )
                                  }
                              />
                              {results &&
                              results.items.length === 0 &&
                              search.trim().length > 0 ? (
                                  // A non-empty query whose groups all
                                  // filtered out (fuzzy false positives).
                                  <div className="px-2.5 py-12 text-center text-fd-muted-foreground text-sm">
                                      {strings.nothingFor} “{search.trim()}”
                                  </div>
                              ) : null}
                              <div
                                  className={cn(
                                      "flex items-center gap-4 border-t px-4 py-2 text-fd-muted-foreground text-xs",
                                      // Touch layouts hide the keyboard hints;
                                      // drop the row when nothing else is in it.
                                      !(results && results.pageCount > 0) &&
                                          "[@media(hover:none)]:hidden",
                                  )}
                              >
                                  <span className="inline-flex items-center gap-1 [@media(hover:none)]:hidden">
                                      <kbd className="rounded border px-1">
                                          ↑
                                      </kbd>
                                      <kbd className="rounded border px-1">
                                          ↓
                                      </kbd>
                                      {strings.select}
                                  </span>
                                  <span className="inline-flex items-center gap-1 [@media(hover:none)]:hidden">
                                      <kbd className="rounded border px-1">
                                          ⏎
                                      </kbd>
                                      {strings.open}
                                  </span>
                                  <span className="inline-flex items-center gap-1 [@media(hover:none)]:hidden">
                                      <kbd className="rounded border px-1">
                                          esc
                                      </kbd>
                                      {strings.close}
                                  </span>
                                  {results && results.pageCount > 0 ? (
                                      <span className="ms-auto">
                                          {strings.results}: {results.pageCount}
                                      </span>
                                  ) : null}
                              </div>
                          </SearchDialogContent>
                      </>,
                      portalTarget,
                  )}
        </SearchDialog>
    )
}
