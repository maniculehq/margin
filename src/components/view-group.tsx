import {
    Popover,
    PopoverClose,
    PopoverContent,
    PopoverTrigger,
} from "fumadocs-ui/components/ui/popover"
import type { ReactNode } from "react"
import {
    Children,
    createContext,
    isValidElement,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react"
import { object, optional, string } from "zod/mini"
import { docsIconNode } from "@/lib/docs-icon"

/** Ingest groups consecutive sibling Views so SSR and compiled-JS rendering
 * share the same dropdown structure. SSR always shows the default view; a
 * saved localStorage choice applies after mount to avoid hydration mismatch. */

export interface VariationOption {
    id: string
    label: string
}

interface VariationsContextValue {
    options: readonly VariationOption[]
    selectedId: string
    setSelectedId: (id: string) => void
}

const VariationsContext = createContext<VariationsContextValue | null>(null)

/**
 * Defense-in-depth for the inline-SVG sink: ingest rejects site-authored
 * inline markup (icons.ts treats "<"-leading values as unauthorable), so
 * a stored "<svg" string can only come from the committed icon map — but a
 * sink this direct still refuses anything carrying active content.
 */
function trustedInlineSvg(value: string | undefined): string | null {
    return value?.startsWith("<svg") &&
        !/on\w+\s*=|<script|<foreignobject|javascript:|href\s*=/i.test(value)
        ? value
        : null
}

/** One site-wide key — every participating group switches together. */
const VARIATION_STORAGE_KEY = "docs:v1:docs-variation"

/**
 * Crosses docs.json `variations.options` from the route loader into both
 * render paths. With no configured options the provider is inert and every
 * ViewGroup falls back to per-group local state.
 */
export function VariationsProvider(props: {
    options: readonly VariationOption[] | null | undefined
    children?: ReactNode
}) {
    // null = nothing stored/selected yet — the first option is the default.
    const [storedId, setStoredId] = useState<string | null>(null)
    const options = props.options
    useEffect(() => {
        if (!options || options.length === 0) return
        try {
            const stored = window.localStorage.getItem(VARIATION_STORAGE_KEY)
            // Setting null clears a selection that predates an options
            // change (content-version update while mounted) — a stale id
            // must not shadow the configured default.
            setStoredId(
                stored && options.some((option) => option.id === stored)
                    ? stored
                    : null,
            )
        } catch {
            // Storage unavailable (private mode) — session-local state only.
        }
    }, [options])
    const first = options?.[0]
    if (!options || !first) return props.children
    return (
        <VariationsContext.Provider
            value={{
                options,
                selectedId: storedId ?? first.id,
                setSelectedId: (id) => {
                    setStoredId(id)
                    try {
                        window.localStorage.setItem(VARIATION_STORAGE_KEY, id)
                    } catch {
                        // Storage unavailable — the in-memory state still
                        // switches every participating group on this page.
                    }
                },
            }}
        >
            {props.children}
        </VariationsContext.Provider>
    )
}

/**
 * One content variation. Ingest always wraps Views in a synthetic ViewGroup,
 * which decides visibility by wrapping each View — so the component itself
 * is a plain container (and a defensive passthrough if one ever renders
 * standalone).
 */
export function View(props: {
    title?: string
    icon?: string
    children?: ReactNode
}) {
    return <div data-view>{props.children}</div>
}

// ViewGroup children props arrive untyped through both render paths
// (hast evaluater / compiled JS) — recover the selector strings by shape.
const viewSelectorPropsSchema = object({
    title: optional(string()),
    icon: optional(string()),
})

/** Ingest-generated wrapper; authored <ViewGroup> tags are disallowed.
 * Matching view titles share a site-wide variation choice; unmatched groups
 * keep a local selection. Injected title labels are omitted from rendering. */
export function ViewGroup(props: { children?: ReactNode }) {
    const variations = useContext(VariationsContext)
    // Group-local override: this state is
    // only valid for the page that rendered it — a client navigation that
    // reconciled a ViewGroup at the same tree position would carry a stale
    // index onto the new page (possibly past its entries, blanking the
    // group). Both body paths therefore remount per page: routes/$.tsx keys
    // HastBody AND the compiled-JS boundary by pageUrl.
    const [localIndex, setLocalIndex] = useState<number | null>(null)
    // Hash navigation into a HIDDEN view (search deep-links index every
    // view's headings): activate the containing view, then scroll — an
    // anchor inside a hidden wrapper would otherwise land nowhere. Hooks
    // live above the early returns (rules of hooks); selectRef is stamped
    // after `select` exists below.
    const containerRef = useRef<HTMLDivElement>(null)
    const selectRef = useRef<(index: number) => void>(() => {})
    useEffect(() => {
        const activate = () => {
            let hash = ""
            try {
                hash = decodeURIComponent(window.location.hash.slice(1))
            } catch {
                return
            }
            if (!hash) return
            const root = containerRef.current
            const target = document.getElementById(hash)
            if (!root || !target || !root.contains(target)) return
            const wrappers = Array.from(
                root.querySelectorAll(":scope > [data-view-wrapper]"),
            )
            const index = wrappers.findIndex((wrapper) =>
                wrapper.contains(target),
            )
            if (index < 0) return
            selectRef.current(index)
            requestAnimationFrame(() => target.scrollIntoView())
        }
        activate()
        window.addEventListener("hashchange", activate)
        return () => window.removeEventListener("hashchange", activate)
    }, [])

    const entries: { element: ReactNode; title: string; icon?: string }[] = []
    for (const child of Children.toArray(props.children)) {
        if (!isValidElement(child) || child.type !== View) continue
        const parsed = viewSelectorPropsSchema.safeParse(child.props)
        entries.push({
            element: child,
            title:
                (parsed.success ? parsed.data.title : undefined) ??
                `View ${entries.length + 1}`,
            ...(parsed.success && parsed.data.icon
                ? { icon: parsed.data.icon }
                : {}),
        })
    }
    if (entries.length === 0) return props.children

    // Only the FIRST entry with a normalized title participates: duplicate
    // titles would both resolve to one option id and findIndex would make
    // the later entry unreachable — it stays selectable via local state.
    const seenTitles = new Set<string>()
    const matches = entries.map((entry) => {
        const normalized = entry.title.toLowerCase()
        if (seenTitles.has(normalized)) return null
        seenTitles.add(normalized)
        return (
            variations?.options.find(
                (option) => option.label.toLowerCase() === normalized,
            ) ?? null
        )
    })
    const participating = matches.some((option) => option !== null)
    const siteIndex = participating
        ? matches.findIndex((option) => option?.id === variations?.selectedId)
        : -1
    const selected = localIndex ?? (siteIndex >= 0 ? siteIndex : 0)
    const active = entries[selected] ?? entries[0]
    if (!active) return null

    const select = (index: number) => {
        const option = matches[index]
        if (variations && option) {
            setLocalIndex(null)
            variations.setSelectedId(option.id)
        } else {
            setLocalIndex(index)
        }
    }

    // The variations contract renders participating choices in CONFIGURED
    // option order; non-participating entries follow in source order.
    const menuOrder = entries
        .map((_, index) => index)
        .sort((a, b) => {
            const optionIndex = (index: number) => {
                const match = matches[index]
                if (!match || !variations) return -1
                return variations.options.findIndex(
                    (option) => option.id === match.id,
                )
            }
            const orderA = optionIndex(a)
            const orderB = optionIndex(b)
            if (orderA !== -1 && orderB !== -1) return orderA - orderB
            if (orderA !== -1) return -1
            if (orderB !== -1) return 1
            return a - b
        })

    selectRef.current = select

    return (
        <div data-view-group ref={containerRef} className="my-6">
            <div className="not-prose mb-3 flex">
                <Popover>
                    <PopoverTrigger
                        aria-label="Select view"
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border bg-fd-secondary/50 px-3 font-medium text-fd-foreground text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
                    >
                        {/* Ingest resolves named icons (icon="code") into
                            inline <svg…> strings before this renders — the
                            same contract iconFromName honors in mdx.tsx;
                            docsIconNode covers asset/https image refs. */}
                        {trustedInlineSvg(active.icon) ? (
                            <span
                                className="inline-flex size-4 shrink-0 [&>svg]:size-full"
                                // biome-ignore lint/security/noDangerouslySetInnerHtml: ingest rejects authored inline markup; trustedInlineSvg re-checks for active content
                                dangerouslySetInnerHTML={{
                                    __html: trustedInlineSvg(active.icon) ?? "",
                                }}
                            />
                        ) : (
                            docsIconNode(active.icon, {
                                className:
                                    "inline-flex size-4 shrink-0 [&>svg]:size-full",
                            })
                        )}
                        {active.title}
                        <svg
                            role="img"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                            className="size-3.5 text-fd-muted-foreground"
                        >
                            <title>Choose view</title>
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </PopoverTrigger>
                    <PopoverContent className="flex min-w-36 flex-col p-1">
                        {menuOrder.map((index) => {
                            const entry = entries[index]
                            if (!entry) return null
                            return (
                                <PopoverClose
                                    key={`${entry.title}-${index}`}
                                    onClick={() => select(index)}
                                    aria-current={
                                        index === selected ? "true" : undefined
                                    }
                                    className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-fd-accent hover:text-fd-accent-foreground aria-[current=true]:font-medium"
                                >
                                    {trustedInlineSvg(entry.icon) ? (
                                        <span
                                            className="inline-flex size-4 shrink-0 [&>svg]:size-full"
                                            // biome-ignore lint/security/noDangerouslySetInnerHtml: ingest rejects authored inline markup; trustedInlineSvg re-checks for active content
                                            dangerouslySetInnerHTML={{
                                                __html:
                                                    trustedInlineSvg(
                                                        entry.icon,
                                                    ) ?? "",
                                            }}
                                        />
                                    ) : (
                                        docsIconNode(entry.icon, {
                                            className:
                                                "inline-flex size-4 shrink-0 [&>svg]:size-full",
                                        })
                                    )}
                                    {entry.title}
                                </PopoverClose>
                            )
                        })}
                    </PopoverContent>
                </Popover>
            </div>
            {entries.map((entry, index) => (
                <div
                    key={`${entry.title}-${
                        // biome-ignore lint/suspicious/noArrayIndexKey: titles may repeat; group children never reorder
                        index
                    }`}
                    data-view-wrapper=""
                    hidden={index !== selected}
                >
                    {entry.element}
                </div>
            ))}
        </div>
    )
}
