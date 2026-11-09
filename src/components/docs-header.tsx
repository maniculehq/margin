import { usePathname } from "fumadocs-core/framework"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "fumadocs-ui/components/ui/popover"
import { useSearchContext } from "fumadocs-ui/contexts/search"
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch"
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
    chromeIconSvg,
    ExternalLinkIcon,
    SearchIcon,
} from "@/components/chrome-icons"
import { ChromeLink } from "@/components/chrome-link"
import { GithubWidget } from "@/components/github-widget"
import { ThemeCycleButton } from "@/components/theme-cycle-button"
import {
    VersionSwitch,
    type VersionSwitchModel,
} from "@/components/version-switch"
import { withBase } from "@/lib/base-path"
import { useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import { docsIconNode } from "@/lib/docs-icon"
import { navbarChromeLinks } from "@/lib/layout.shared"
import type { LayoutConfig } from "@/lib/source"
import type { TabNode } from "@/types/docs"
import { isAllowedUrl } from "@/types/docs-shared"

/**
 * Search pill: borderless tinted fill, "Search..." placeholder
 * and a plain ⌘K hint. fumadocs' FullSearchTrigger owns its label ("Search",
 * i18n) and renders bordered <kbd> chips, so the pill is ours; opening still
 * goes through fumadocs' search context.
 */
function SearchPill(props: { prompt?: string }) {
    const { enabled, setOpenSearch } = useSearchContext()
    const strings = useChromeStrings()
    const [hotkey, setHotkey] = useState("⌘K")
    useEffect(() => {
        if (!/Mac|iP(hone|ad|od)/.test(navigator.platform ?? ""))
            setHotkey("Ctrl K")
    }, [])
    if (!enabled) return null
    return (
        <button
            type="button"
            onClick={() => setOpenSearch(true)}
            className="inline-flex h-9 w-full max-w-96 items-center gap-2 justify-self-center rounded-full bg-fd-foreground/[0.04] px-3.5 text-fd-muted-foreground text-sm transition-colors hover:bg-fd-foreground/[0.07] dark:bg-fd-secondary dark:hover:bg-fd-secondary/80"
        >
            {iconSpan(chromeIconSvg("search"))}
            {props.prompt ?? strings.search}
            <span className="ms-auto text-fd-muted-foreground text-xs">
                {hotkey}
            </span>
        </button>
    )
}

/**
 * luma search control: a 36px round icon button (upstream
 * `aria-label="Open search"`), no visible label or hotkey. Opens the same
 * fumadocs search dialog as the pill.
 */
function SearchIconButton() {
    const { enabled, setOpenSearch } = useSearchContext()
    if (!enabled) return null
    return (
        <button
            type="button"
            aria-label="Open search"
            onClick={() => setOpenSearch(true)}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-fd-foreground/[0.03] text-fd-foreground transition-colors hover:bg-fd-foreground/[0.07]"
        >
            <SearchIcon className="size-4" />
        </button>
    )
}

export function iconSpan(name: string | undefined): ReactNode | null {
    return docsIconNode(name, {
        className: "inline-flex size-4 shrink-0 [&>svg]:size-full",
    })
}

/**
 * Normalize a compiled-nav page ref ("/index", "/pm/cli/add", "pm/cli/add")
 * to a served URL. compileNavigation stores repo paths with a leading slash.
 */
function _pageUrl(path: string): string {
    const trimmed = path
        .replace(/^\/+/, "")
        .replace(/\.(mdx|md)$/i, "")
        .replace(/(^|\/)index$/i, "$1")
        .replace(/\/+$/, "")
    return `/${trimmed}`
}

export interface HeaderLocale {
    /** Language tag (doubles as the URL prefix for non-default locales). */
    locale: string
    /** Endonym display name, resolved server-side via Intl.DisplayNames. */
    label: string
    /** Counterpart URL of the current page in this locale (or its home). */
    href: string
    active: boolean
}

/**
 * Popover body with the WAI-ARIA menu keyboard contract, shared by the
 * locale switch and mega-menu tabs: the active item (or the first) takes
 * focus on open; ArrowUp/ArrowDown/Home/End rove among the `a[role=menuitem]`
 * children; Space activates the focused item (Enter is the anchor's native
 * activation); Escape closing is Radix's own.
 */
function MenuPopoverContent(props: {
    label: string
    className?: string
    children: ReactNode
}) {
    const listRef = useRef<HTMLDivElement>(null)
    const menuItems = () =>
        Array.from(
            listRef.current?.querySelectorAll<HTMLAnchorElement>(
                "a[role='menuitem']",
            ) ?? [],
        )
    return (
        <PopoverContent
            ref={listRef}
            role="menu"
            aria-label={props.label}
            className={props.className}
            onOpenAutoFocus={(event) => {
                event.preventDefault()
                const items = menuItems()
                const activeItem = items.find(
                    (item) => item.dataset.active === "true",
                )
                ;(activeItem ?? items[0])?.focus()
            }}
            onKeyDown={(event) => {
                const items = menuItems()
                if (items.length === 0) return
                const focused = document.activeElement
                const current =
                    focused instanceof HTMLAnchorElement
                        ? items.indexOf(focused)
                        : -1
                if (event.key === " ") {
                    if (current === -1) return
                    // Space on an anchor scrolls the page; menuitems must
                    // select instead.
                    event.preventDefault()
                    items[current]?.click()
                    return
                }
                if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                    return
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : event.key === "ArrowDown"
                            ? (current + 1) % items.length
                            : (current - 1 + items.length) % items.length
                event.preventDefault()
                items[next]?.focus()
            }}
        >
            {props.children}
        </PopoverContent>
    )
}

/**
 * Language selector (Phase A): visible only for multi-locale sites.
 * fumadocs popover, matching the page-action menu's chrome.
 */
export function LocaleSwitch(props: {
    locales: HeaderLocale[]
    /** luma: a plain "English ⌄" text dropdown — no globe. */
    variant?: "default" | "luma"
}) {
    const active = props.locales.find((entry) => entry.active)
    const strings = useChromeStrings()
    const activeLabel = active?.label ?? props.locales[0]?.label ?? ""
    return (
        <Popover>
            <PopoverTrigger
                // Accessible name carries the visible label too ("Language:
                // Français") so the control reads as its current value.
                aria-label={`${strings.language}: ${activeLabel}`}
                aria-haspopup="menu"
                className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 font-medium text-sm transition-colors hover:bg-fd-foreground/[0.04] hover:text-fd-accent-foreground",
                    props.variant === "luma"
                        ? "text-fd-foreground"
                        : "text-fd-muted-foreground",
                )}
            >
                {props.variant === "luma"
                    ? null
                    : iconSpan(chromeIconSvg("globe"))}
                {activeLabel}
                {props.variant === "luma" ? <MenuChevron /> : null}
            </PopoverTrigger>
            <MenuPopoverContent
                label={strings.language}
                className="flex w-44 flex-col p-1"
            >
                {props.locales.map((entry) => (
                    <a
                        key={entry.locale}
                        href={withBase(entry.href)}
                        role="menuitem"
                        tabIndex={-1}
                        data-active={entry.active}
                        className="rounded-lg px-2.5 py-1.5 text-sm outline-none hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:bg-fd-accent focus-visible:text-fd-accent-foreground data-[active=true]:font-semibold data-[active=true]:text-fd-primary"
                    >
                        {entry.label}
                    </a>
                ))}
            </MenuPopoverContent>
        </Popover>
    )
}

export interface BandMenuItem {
    title: string
    icon?: string
    description?: string
    href: string
    external: boolean
}

export interface BandTab {
    /** Stable identity shared with the loader: `tabs:<i>` / `global:<i>`
     * (list position — titles are not unique). */
    key: string
    title: string
    icon?: string
    href: string
    external: boolean
    /** docs.json tab alignment; "end" pushes this tab (and followers) right. */
    align?: "start" | "end"
    /** Content tabs: the loader-resolved active tab drives active state (an
     * empty set on the 404 page, where no tab is active). */
    urls: Set<string> | null
    /** docs.json `hidden` tab: rendered only while it is the active tab. */
    hidden?: boolean
    /** Mega-menu tabs (docs.json tab.menu): the header renders a dropdown
     * of these instead of a plain link. */
    menu?: BandMenuItem[]
}

export function bandTabs(config: LayoutConfig | null): BandTab[] {
    const resolvedNav = config?.__resolvedNav
    const tabs: BandTab[] = []
    const keyed: { key: string; tab: TabNode }[] = [
        ...(resolvedNav?.tabs ?? []).map((tab, index) => ({
            key: `tabs:${index}`,
            tab,
        })),
        ...(resolvedNav?.global?.tabs ?? []).map((tab, index) => ({
            key: `global:${index}`,
            tab,
        })),
    ]
    for (const { key, tab } of keyed) {
        // Hidden href-only tabs (no compiled membership) are never shown;
        // hidden tabs WITH pages fall through and render while active.
        if (tab.hidden && tab.href && !tab.resolvedHref) continue
        if (tab.href && !tab.resolvedHref) {
            if (!isAllowedUrl(tab.href)) continue
            tabs.push({
                key,
                title: tab.tab,
                icon: tab.icon,
                href: tab.href,
                external: /^https?:\/\//i.test(tab.href),
                align: tab.align,
                urls: null,
            })
            continue
        }
        // Menu items land on their authored href or the ingest-resolved
        // first page (serveLayoutConfig keeps exactly these fields).
        const menu = (tab.menu ?? []).flatMap((item) => {
            const href = item.href ?? item.resolvedHref
            if (item.hidden || !href || !isAllowedUrl(href)) return []
            return [
                {
                    title: item.item,
                    icon: item.icon,
                    description: item.description,
                    href,
                    external: /^https?:\/\//i.test(href),
                },
            ]
        })
        // Ingest stamps every content tab's landing URL; membership lists
        // stay on the server (serveLayoutConfig), where the loader resolves
        // the active tab.
        const href = tab.resolvedHref ?? menu[0]?.href
        if (!href) continue
        tabs.push({
            key,
            title: tab.tab,
            icon: tab.icon,
            href,
            external: false,
            align: tab.align,
            urls: new Set(),
            ...(tab.hidden ? { hidden: true } : {}),
            ...(menu.length > 0 ? { menu } : {}),
        })
    }
    return tabs
}

/** Inline ⌄ for dropdown triggers (version, locale, menu tabs). */
function MenuChevron() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="size-3.5 shrink-0 opacity-70"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

/**
 * Tab treatments. `underline` (default band): labels near-foreground in
 * both states, activity as the primary underline. `pill` (luma):
 * centred 36px pills — muted label, active gets a 3% foreground fill.
 */
function tabClass(
    variant: "underline" | "pill",
    active: boolean,
    alignEnd: boolean,
) {
    return cn(
        variant === "pill"
            ? "inline-flex h-9 items-center gap-2 rounded-full px-4 font-medium text-fd-muted-foreground text-sm text-nowrap transition-colors hover:bg-fd-foreground/[0.03] hover:text-fd-foreground"
            : "inline-flex h-full items-center gap-2 border-b-2 border-transparent font-medium text-[0.8rem] text-fd-foreground/90 text-nowrap",
        active &&
            (variant === "pill"
                ? "bg-fd-foreground/[0.03] text-fd-foreground"
                : "border-fd-primary font-semibold text-fd-foreground"),
        alignEnd && "ms-auto",
    )
}

function TabLink(props: {
    tab: BandTab
    active: boolean
    alignEnd: boolean
    variant: "underline" | "pill"
}) {
    const { tab, active } = props
    const icon = iconSpan(tab.icon)
    // Controlled so selecting an item closes the menu: the header stays
    // mounted across SPA navigations, so an uncontrolled popover would sit
    // open over the destination page.
    const [menuOpen, setMenuOpen] = useState(false)
    if (tab.menu) {
        return (
            // docs.json tab.menu: the tab renders as a dropdown of
            // (icon, item, description) rows — never a bare link.
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger
                    data-active={active}
                    aria-haspopup="menu"
                    className={tabClass(props.variant, active, props.alignEnd)}
                >
                    {icon}
                    {tab.title}
                    <MenuChevron />
                </PopoverTrigger>
                <MenuPopoverContent
                    label={tab.title}
                    className="flex w-72 flex-col gap-0.5 p-1.5"
                >
                    {tab.menu.map((item) => (
                        <ChromeLink
                            key={item.href}
                            href={item.href}
                            role="menuitem"
                            tabIndex={-1}
                            onClick={() => setMenuOpen(false)}
                            {...(item.external
                                ? {
                                      target: "_blank",
                                      rel: "noreferrer noopener",
                                  }
                                : {})}
                            className="flex items-start gap-3 rounded-lg px-2.5 py-2 text-sm outline-none hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:bg-fd-accent focus-visible:text-fd-accent-foreground"
                        >
                            {iconSpan(item.icon) ?? null}
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="font-medium text-fd-foreground">
                                    {item.title}
                                </span>
                                {item.description ? (
                                    <span className="text-fd-muted-foreground text-xs">
                                        {item.description}
                                    </span>
                                ) : null}
                            </span>
                        </ChromeLink>
                    ))}
                </MenuPopoverContent>
            </Popover>
        )
    }
    return (
        <ChromeLink
            href={tab.href}
            {...(tab.external
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
            data-active={active}
            aria-current={active ? "location" : undefined}
            className={tabClass(props.variant, active, props.alignEnd)}
        >
            {/* No wrapper when the name doesn't resolve: an empty span left
                a phantom gap, and a plain (baseline) span floated the lone
                resolved icon ~4px above the label's center (audit). */}
            {icon ? (
                <span
                    className={cn(
                        "inline-flex items-center",
                        active &&
                            props.variant === "underline" &&
                            "text-fd-primary",
                    )}
                >
                    {icon}
                </span>
            ) : null}
            {tab.title}
        </ChromeLink>
    )
}

function SideNavRow(props: {
    title: string
    icon?: string
    href: string
    external: boolean
    active: boolean
}) {
    // Box only when the name resolves: an empty bordered square (unresolved
    // FontAwesome names, until the icon map covers them) is worse than a
    // plain label row.
    const icon = iconSpan(props.icon)
    return (
        <ChromeLink
            href={props.href}
            {...(props.external
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
            data-active={props.active}
            aria-current={props.active ? "location" : undefined}
            className={cn(
                "group flex items-center gap-2.5 rounded-lg p-2 font-medium text-fd-muted-foreground text-sm transition-colors hover:text-fd-accent-foreground",
                props.active && "text-fd-primary",
            )}
        >
            {icon ? (
                <span
                    className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md border bg-fd-background text-fd-muted-foreground transition-colors group-hover:text-fd-primary [&_svg]:size-3.5",
                        props.active &&
                            "border-fd-primary/40 bg-fd-primary/10 text-fd-primary",
                    )}
                >
                    {icon}
                </span>
            ) : null}
            {props.title}
        </ChromeLink>
    )
}

/** Sidenav mode moves the desktop band into the sidebar banner. The mobile
 * drawer retains its own copies; app.css hides only the stock desktop chrome. */
export function SidebarChrome(props: {
    logo: ReactNode
    /** Object-form docs.json logo.href (validated); default "/". */
    logoHref?: string
    config: LayoutConfig | null
    /** Server-resolved active tab key (loader, exact membership); null →
     * derive from the pathname. */
    activeTabKey: string | null
    themeSwitchEnabled: boolean
    locales?: HeaderLocale[]
    /** Global version switcher model; renders below the search row. */
    versions?: VersionSwitchModel | null
    aiTrigger?: ReactNode
}) {
    const pathname = usePathname().replace(/\/+$/, "") || "/"
    const tabs = bandTabs(props.config).filter(
        (tab) => !tab.hidden || tab.key === props.activeTabKey,
    )
    const activeTab = props.activeTabKey
        ? tabs.find((tab) => tab.key === props.activeTabKey)
        : tabs.find((tab) => tab.urls?.has(pathname))
    return (
        <div
            data-sidebar-chrome=""
            className="flex flex-col gap-3 max-md:hidden"
        >
            <div className="flex items-center justify-between gap-2">
                <ChromeLink
                    href={props.logoHref ?? "/"}
                    className="inline-flex w-fit items-center gap-2.5 font-semibold [&_img]:h-6 [&_img]:w-auto"
                >
                    {props.logo}
                </ChromeLink>
                <div className="flex shrink-0 items-center gap-1">
                    {props.locales && props.locales.length >= 2 ? (
                        <LocaleSwitch locales={props.locales} />
                    ) : null}
                    {props.themeSwitchEnabled ? (
                        <ThemeSwitch mode="light-dark" />
                    ) : null}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <SearchPill prompt={props.config?.search?.prompt} />
                {props.aiTrigger}
            </div>
            {props.versions ? (
                <div className="flex">
                    <VersionSwitch model={props.versions} />
                </div>
            ) : null}
            {/* Link-only anchors join the tabs INSIDE the scroll viewport
                (baseOptions custom items render above the page tree) — only
                the nav tabs live in this pinned block. */}
            {tabs.length > 0 ? (
                <nav
                    aria-label="Documentation"
                    className="flex flex-col gap-0.5 border-b pb-3"
                >
                    {tabs.map((tab) => (
                        <SideNavRow
                            key={tab.key}
                            title={tab.title}
                            icon={tab.icon}
                            href={tab.href}
                            external={tab.external}
                            active={tab === activeTab}
                        />
                    ))}
                </nav>
            ) : null}
        </div>
    )
}

/**
 * Desktop header band (plan §A1/§A2): full-width bar
 * with logo, centered search, navbar links and theme toggle, plus a
 * horizontal tab row. Rendered ABOVE fumadocs' DocsLayout; the container's
 * `--fd-docs-row-1` override in routes/$.tsx offsets the sticky
 * sidebar/TOC below it (see --docs-band-height in styles/app.css). Mobile
 * (< md) keeps fumadocs' built-in header + drawer chrome.
 */
export function DocsHeader(props: {
    logo: ReactNode
    /** Object-form docs.json logo.href (validated); default "/". */
    logoHref?: string
    config: LayoutConfig | null
    /** Server-resolved active tab key (loader, exact membership); null →
     * derive from the pathname. */
    activeTabKey: string | null
    themeSwitchEnabled: boolean
    /** Visible locales (≥2 renders the selector); loader-computed. */
    locales?: HeaderLocale[]
    /** Global version switcher model; renders beside the logo. */
    versions?: VersionSwitchModel | null
    /** Publicly-linked repo → stars widget in the right cluster (topbar
     * row 1, not the sidebar). */
    githubRepo?: { owner: string; repo: string; stars: number | null }
    /** Assistant trigger (AISearchTrigger), rendered beside the nav links. */
    aiTrigger?: ReactNode
    /** Layout preset — "contrast" (the luma theme) renders upstream's single
     * 48px row: centred pill tabs (≤5), icon search/assistant/theme buttons,
     * outlined + filled navbar pills, no border. Other presets keep the
     * two-row band with the search pill. */
    layoutPreset?: string
}) {
    const pathname = usePathname().replace(/\/+$/, "") || "/"
    const tabs = bandTabs(props.config).filter(
        (tab) => !tab.hidden || tab.key === props.activeTabKey,
    )
    const activeTab = props.activeTabKey
        ? tabs.find((tab) => tab.key === props.activeTabKey)
        : tabs.find((tab) => tab.urls?.has(pathname))
    // Tabs render flat in authoring order; alignment comes from the
    // `align: "end"` field (first such tab gets the auto margin) or from
    // site CSS (bun pushes its Guides tab right that way).
    const firstEndTab = tabs.find((tab) => tab.align === "end")
    const luma = props.layoutPreset === "contrast"
    const tabVariant = luma ? "pill" : "underline"
    // luma with more than five tabs falls back to the two-row band (pills
    // in the second row) — upstream wraps the same way.
    const pillRow = luma && tabs.length > 0 && tabs.length <= 5

    const navbarLinks = navbarChromeLinks(props.config)

    return (
        // Solid background: scrolled code blocks used to bleed through the
        // 80%-alpha blur (dark mode made code text legible through the band).
        <header
            id="docs-band"
            data-tabs={tabs.length > 0 && !pillRow ? "true" : undefined}
            data-variant={luma ? "luma" : undefined}
            className={cn(
                "sticky top-[var(--fd-banner-height,0px)] z-30 bg-fd-background max-md:hidden",
                !luma && "border-b",
            )}
        >
            {/* max-content track minimums: the side clusters must never
                shrink below their content — Chrome's auto (fr) minimum
                under-sized the left cluster once it grew past the logo
                (version chip + locale), sliding the centered search pill
                over the Language button. The middle column is the one that
                gives: the search pill's minmax(0,26rem), or the pill tabs'
                own width. */}
            <div
                className={cn(
                    "mx-auto grid w-full max-w-[var(--fd-layout-width,97rem)] items-center gap-6 px-9",
                    pillRow
                        ? "grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]"
                        : "grid-cols-[minmax(max-content,1fr)_minmax(0,26rem)_minmax(max-content,1fr)]",
                    luma ? "h-12" : "h-14",
                )}
            >
                {/* Left cluster, in order: logo, version dropdown,
                    locale selector. */}
                <div className="flex h-full items-center gap-3">
                    <ChromeLink
                        href={props.logoHref ?? "/"}
                        className="inline-flex w-fit shrink-0 items-center gap-2.5 font-semibold [&_img]:h-6 [&_img]:w-auto"
                    >
                        {props.logo}
                    </ChromeLink>
                    {props.versions ? (
                        <VersionSwitch model={props.versions} />
                    ) : null}
                    {props.locales && props.locales.length >= 2 ? (
                        <LocaleSwitch
                            locales={props.locales}
                            variant={luma ? "luma" : "default"}
                        />
                    ) : null}
                </div>
                {pillRow ? (
                    <nav
                        aria-label="Documentation tabs"
                        className="flex items-center gap-1"
                    >
                        {tabs.map((tab) => (
                            <TabLink
                                key={tab.key}
                                tab={tab}
                                active={tab === activeTab}
                                alignEnd={tab === firstEndTab}
                                variant="pill"
                            />
                        ))}
                    </nav>
                ) : luma ? (
                    <div />
                ) : (
                    <SearchPill prompt={props.config?.search?.prompt} />
                )}
                <div className="flex items-center justify-end gap-2">
                    {luma ? <SearchIconButton /> : null}
                    {props.aiTrigger}
                    {/* Header nav opens same-tab for first-party
                        destinations. Preserve ul > li.navbar-link > a:
                        authored CSS uses these hooks to order and tint CTAs. */}
                    {navbarLinks.length > 0 ? (
                        <ul className="flex items-center gap-2">
                            {navbarLinks.map((link) => (
                                <li key={link.href} className="navbar-link">
                                    {link.primary ? (
                                        // navbar CTA. luma: a filled brand
                                        // pill (upstream #primary, 34px);
                                        // other themes: the quiet neutral
                                        // pill (light-gray / dark-gray), never
                                        // a loud brand fill.
                                        <a
                                            href={withBase(link.href)}
                                            {...(link.external
                                                ? {
                                                      rel: "noreferrer noopener",
                                                  }
                                                : {})}
                                            className={
                                                luma
                                                    ? "inline-flex h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-fd-primary px-4 font-medium text-fd-primary-foreground text-sm transition-colors hover:bg-fd-primary/90"
                                                    : "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-fd-foreground/[0.04] px-3.5 font-medium text-fd-foreground text-sm transition-colors hover:bg-fd-foreground/[0.08] dark:bg-fd-secondary dark:hover:bg-fd-secondary/80"
                                            }
                                        >
                                            {iconSpan(link.icon)}
                                            {link.label}
                                        </a>
                                    ) : (
                                        // Secondary navbar link. luma:
                                        // upstream's outlined pill; others: a
                                        // muted text link with the external
                                        // glyph.
                                        <a
                                            href={withBase(link.href)}
                                            {...(link.external
                                                ? {
                                                      rel: "noreferrer noopener",
                                                  }
                                                : {})}
                                            className={
                                                luma
                                                    ? "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-fd-foreground/10 px-4 font-medium text-fd-muted-foreground text-sm transition-colors hover:bg-fd-foreground/[0.03] hover:text-fd-foreground"
                                                    : "inline-flex items-center gap-1.5 px-2 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-accent-foreground [&_svg]:size-3.5"
                                            }
                                        >
                                            {iconSpan(link.icon)}
                                            {link.label}
                                            {link.external &&
                                            !link.icon &&
                                            !luma ? (
                                                <ExternalLinkIcon />
                                            ) : null}
                                        </a>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {props.githubRepo ? (
                        <GithubWidget
                            owner={props.githubRepo.owner}
                            repo={props.githubRepo.repo}
                            stars={props.githubRepo.stars}
                            className="h-9 shrink-0 rounded-xl px-2.5 hover:bg-fd-foreground/[0.04]"
                        />
                    ) : null}
                    {props.themeSwitchEnabled ? (
                        luma ? (
                            <ThemeCycleButton />
                        ) : (
                            <ThemeSwitch mode="light-dark" />
                        )
                    ) : null}
                </div>
            </div>
            {tabs.length > 0 && !pillRow ? (
                <nav
                    aria-label="Documentation tabs"
                    className={cn(
                        "mx-auto flex h-10 w-full max-w-[var(--fd-layout-width,97rem)] overflow-x-auto px-9",
                        luma ? "items-center gap-1" : "gap-6",
                    )}
                >
                    {tabs.map((tab) => (
                        <TabLink
                            key={tab.key}
                            tab={tab}
                            active={tab === activeTab}
                            alignEnd={tab === firstEndTab}
                            variant={tabVariant}
                        />
                    ))}
                </nav>
            ) : null}
        </header>
    )
}
