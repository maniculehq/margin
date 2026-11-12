import type {
    BaseLayoutProps,
    LinkItemType,
    MenuItemType,
} from "fumadocs-ui/layouts/shared"
import type { ReactNode } from "react"
import {
    array,
    boolean,
    json,
    minLength,
    object,
    optional,
    record,
    string,
    union,
} from "zod/mini"
import { ExternalLinkIcon, MailIcon } from "@/components/chrome-icons"
import { ChromeLink } from "@/components/chrome-link"
import { buttonVariants } from "@/components/ui/button"
import {
    VersionSwitch,
    type VersionSwitchModel,
} from "@/components/version-switch"
import { withBase } from "@/lib/base-path"
import { docsIconNode } from "@/lib/docs-icon"
import { CONFIG_EXTENSION_KEY } from "@/types/constants"
import type { ChromeMode, SearchMode, VersionsManifest } from "@/types/docs"
import { isAllowedUrl } from "@/types/docs-shared"
import { appName } from "./shared"
import type { LayoutConfig } from "./source"

// Browser-side chrome parsing (zod/mini): the layout config itself is
// parsed server-side by `layoutConfigSchema` in source.ts.
export const chromeSchema = object({
    links: optional(json()),
    primary: optional(json()),
    socials: optional(
        union([
            record(string(), string()),
            array(
                object({
                    type: optional(string()),
                    label: optional(string()),
                    href: string(),
                }),
            ),
        ]),
    ),
})
// docs.json navbar.links entries may carry an icon and a `primary: true` flag
// (bun's "Install Bun" button) alongside label/href.
export const chromeLinkSchema = object({
    label: optional(string()),
    name: optional(string()),
    href: string(),
    icon: optional(string()),
    primary: optional(boolean()),
})
// docs.json navbar.primary: {type:"button", label, href} or {type:"github", href}.
export const chromePrimarySchema = object({
    type: optional(string()),
    label: optional(string().check(minLength(1))),
    href: string().check(minLength(1)),
})

/**
 * docs.json `appearance` → next-themes options on RootProvider (spec:
 * deployment-standard.md §appearance). `default` seeds first-visit theme;
 * `strict` pins it (the theme switch is already hidden via themeSwitch in
 * baseOptions). Forcing "system" is meaningless, so strict only forces an
 * explicit light/dark.
 */
export function resolveThemeOptions(config: LayoutConfig | null): {
    defaultTheme: string
    forcedTheme?: string
} {
    const appearance = config?.appearance
    const defaultTheme = appearance?.default ?? "system"
    if (appearance?.strict === true && defaultTheme !== "system") {
        return { defaultTheme, forcedTheme: defaultTheme }
    }
    return { defaultTheme }
}

/**
 * Desktop chrome structure for a site. The maple theme hides the
 * navbar on desktop and hosts logo/search/theme/nav vertically at the top of
 * the sidebar — everything else keeps the top band. `<CONFIG_EXTENSION_KEY>.layout.
 * chromeMode` is the explicit override; almond stays "band" until an
 * upstream almond site proves it also hides the navbar.
 */
/**
 * Search the chrome renders. `<CONFIG_EXTENSION_KEY>.search.mode`: "ai"
 * (default) keeps the Assistant, "static" renders plain search only, "off"
 * additionally disables the search dialog; sites can opt out
 * per-config. "ai" falls back to "static" when the deployment has no AI
 * Gateway credential (env.ts assistantAvailable, via the root loader), so
 * no Assistant control points at a /api/chat that refuses.
 */
export function searchModeOf(
    config: LayoutConfig | null,
    assistantAvailable: boolean,
): SearchMode {
    const mode = config?.[CONFIG_EXTENSION_KEY]?.search?.mode ?? "ai"
    return mode === "ai" && !assistantAvailable ? "static" : mode
}

export function chromeMode(config: LayoutConfig | null): ChromeMode {
    const override = config?.[CONFIG_EXTENSION_KEY]?.layout?.chromeMode
    if (override) return override
    return config?.theme === "maple" ? "sidenav" : "band"
}

export interface BaseOptionsInput {
    config: LayoutConfig | null
    siteName?: string
    versionsManifest: VersionsManifest
    /** Non-default locale tag — version switcher URLs need its prefix. */
    activeLocale?: string | null
}

export interface SidebarAnchor {
    text: string
    url: string
    icon?: string
    /** docs.json anchor color — tints the boxed icon. */
    color?: { light: string; dark: string }
    external: boolean
}

/**
 * Link-only anchors (community/blog/console escapes), pinned as
 * boxed-icon rows at the top of the sidebar scroll viewport, above the page
 * tree — baseOptions renders them as custom link items on every surface
 * (desktop sidebar and mobile drawer).
 */
export function sidebarAnchors(config: LayoutConfig | null): SidebarAnchor[] {
    const resolvedNav = config?.__resolvedNav
    const anchors: SidebarAnchor[] = []
    for (const anchor of [
        ...(resolvedNav?.anchors ?? []),
        ...(resolvedNav?.global?.anchors ?? []),
    ]) {
        if (!anchor.href || anchor.hidden || !isAllowedUrl(anchor.href))
            continue
        anchors.push({
            text: anchor.anchor,
            url: anchor.href,
            ...(anchor.icon ? { icon: anchor.icon } : {}),
            ...(anchor.color ? { color: anchor.color } : {}),
            external: /^https?:\/\//i.test(anchor.href),
        })
    }
    return anchors
}

export interface NavbarChromeLink {
    href: string
    label: string
    icon?: string
    primary: boolean
    external: boolean
}

/**
 * Shared by the header, sidenav, and mobile drawer. Only top-level version
 * roots appear in site chrome; nested roots belong to their container.
 * Hidden versions remain routable but are omitted from the menu, and a
 * root-directory version links to `/`. Keep the current-version chip when
 * only one version is visible.
 */
export function versionSwitcherModel(
    versionsManifest: VersionsManifest,
    activeLocale?: string | null,
): VersionSwitchModel | null {
    const topLevelVersions = [...versionsManifest]
        .filter((entry) => entry.nested !== true)
        .sort((left, right) => left.seq - right.seq)
    const versions = topLevelVersions.filter((entry) => entry.hidden !== true)
    // Locale-scoped manifests carry unqualified labels (es/v1 → "v1"); the
    // switcher must keep the reader inside their locale (/es/v1, /es — not
    // /v1, /).
    const localeBase = activeLocale ? `/${activeLocale}` : ""
    if (versions.length > 1) {
        return {
            // A nested default (filtered above) must not blank the trigger —
            // fall back to the first retained root.
            label:
                (versions.find((entry) => entry.default) ?? versions[0])
                    ?.label ?? "Versions",
            items: versions.flatMap((entry) =>
                entry.href && !isAllowedUrl(entry.href)
                    ? []
                    : [
                          {
                              label: entry.label,
                              url:
                                  entry.href ??
                                  (entry.directory === ""
                                      ? localeBase || "/"
                                      : `${localeBase}/${entry.label}`),
                              external: entry.href !== undefined,
                              ...(entry.tag ? { tag: entry.tag } : {}),
                          },
                      ],
            ),
        }
    }
    if (versions.length === 1 && topLevelVersions.length > 1) {
        const only = versions[0]
        if (only) return { label: only.label, items: null }
    }
    return null
}

/**
 * Dedup key for chrome/navigation destinations: case-folded, `www.`-less
 * host, no trailing slash. The same destination can arrive from several
 * config surfaces (navbar.links + navbar.primary, anchors + navbar,
 * local + global) with cosmetic URL variations. Normalize those variants
 * so the drawer does not repeat a link.
 */
function linkDedupKey(url: string): string {
    try {
        const parsed = new URL(url, "https://relative.invalid")
        const host =
            parsed.host === "relative.invalid"
                ? ""
                : `${parsed.protocol}//${parsed.host.replace(/^www\./, "")}`
        const pathname = parsed.pathname.replace(/\/+$/, "") || "/"
        // Fragment included: links differing only by #section are distinct
        // destinations (review finding — the later one was silently
        // dropped).
        return `${host}${pathname}${parsed.search}${parsed.hash}`.toLowerCase()
    } catch {
        return url.toLowerCase()
    }
}

/** Normalize authored navbar links for the desktop band, sidenav, and mobile
 * drawer. CTA precedence is explicit primary button, `primary: true`, then
 * the docs.json last-link convention; GitHub/Discord widgets are not CTAs here. */
export function navbarChromeLinks(
    config: LayoutConfig | null,
): NavbarChromeLink[] {
    const navbar = chromeSchema.safeParse(config?.navbar)
    if (!navbar.success) return []
    const links: NavbarChromeLink[] = []
    if (Array.isArray(navbar.data.links)) {
        for (const rawLink of navbar.data.links) {
            const link = chromeLinkSchema.safeParse(rawLink)
            if (!link.success || !isAllowedUrl(link.data.href)) continue
            links.push({
                href: link.data.href,
                label: link.data.label ?? link.data.name ?? link.data.href,
                ...(link.data.icon ? { icon: link.data.icon } : {}),
                primary: link.data.primary === true,
                external: /^https?:\/\//i.test(link.data.href),
            })
        }
    }
    if (navbar.data.primary !== undefined) {
        const primary = chromePrimarySchema.safeParse(navbar.data.primary)
        const primaryType = primary.success
            ? primary.data.type?.toLowerCase()
            : undefined
        if (
            primary.success &&
            isAllowedUrl(primary.data.href) &&
            primaryType !== "github" &&
            primaryType !== "discord"
        ) {
            links.push({
                href: primary.data.href,
                label: primary.data.label ?? primary.data.href,
                primary: true,
                external: true,
            })
        }
    }
    // One entry per destination on every surface (band, sidebar footer,
    // drawer): sites carry the same CTA in navbar.links AND navbar.primary
    // — keep the first occurrence's position, CTA styling wins.
    const byDestination = new Map<string, NavbarChromeLink>()
    for (const link of links) {
        const key = linkDedupKey(link.href)
        const existing = byDestination.get(key)
        if (!existing || (link.primary && !existing.primary))
            byDestination.set(key, link)
    }
    const deduped = [...byDestination.values()]
    // Implicit CTA (post-dedup so it lands on the surviving entry): with no
    // explicit primary anywhere, the last links entry becomes the button.
    const last = deduped.at(-1)
    if (last && !deduped.some((link) => link.primary)) last.primary = true
    return deduped
}

export function baseOptions(input: BaseOptionsInput): BaseLayoutProps & {
    tabMode: "top" | "auto"
    githubRepo?: { owner: string; repo: string }
} {
    const config = input.config
    const resolvedNav = config?.__resolvedNav
    const links: LinkItemType[] = []
    // Cross-source dedup for the drawer/menu list: the same destination can
    // arrive from anchors, href-tabs, menu items, products, and the navbar
    // chrome copies (the same destination can appear more than once in a drawer
    // link). First occurrence keeps its position; a primary CTA replaces a
    // plain copy in place. Menus/version controls have no single
    // destination and always push.
    const linkSlots = new Map<string, number>()
    const pushLink = (url: string, item: LinkItemType, primary = false) => {
        const key = linkDedupKey(url)
        const slot = linkSlots.get(key)
        if (slot === undefined) {
            linkSlots.set(key, links.length)
            links.push(item)
        } else if (primary) {
            links[slot] = item
        }
    }
    // Site nav icons (names or ingest-hashed image refs) → shared node
    // builder. Unknown names render no icon in chrome — a default glyph on
    // every link is worse than none here.
    const navIcon = (name: string | undefined): ReactNode | undefined =>
        docsIconNode(name, {
            className: "inline-flex size-4 [&>svg]:size-full",
        }) ?? undefined
    // Render link-only anchors above the page tree on desktop and in the
    // mobile drawer. `data-sidebar-anchor` preserves the first group divider
    // when these links precede the tree.
    for (const anchor of sidebarAnchors(config)) {
        pushLink(anchor.url, {
            type: "custom",
            children: (
                <ChromeLink
                    href={anchor.url}
                    data-sidebar-anchor=""
                    {...(anchor.external
                        ? { target: "_blank", rel: "noreferrer noopener" }
                        : {})}
                    className="group mb-0.5 flex items-center gap-2.5 rounded-lg p-2 font-medium text-fd-muted-foreground text-sm transition-colors hover:text-fd-accent-foreground"
                >
                    {anchor.icon ? (
                        <span
                            className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-fd-background text-fd-muted-foreground transition-colors group-hover:text-fd-primary [&_svg]:size-3.5"
                            // docs.json anchor color — the authored light-mode
                            // tint (dark tracks it; a per-scheme swap is not
                            // worth a stylesheet for a glyph tint).
                            style={
                                anchor.color
                                    ? { color: anchor.color.light }
                                    : undefined
                            }
                        >
                            {navIcon(anchor.icon)}
                        </span>
                    ) : null}
                    {anchor.text}
                </ChromeLink>
            ),
        })
    }
    // href-only tabs (external links like bun's Reference/Blog) render in the
    // desktop band's tab row (components/docs-header.tsx); the sidebar copy is
    // for the mobile drawer only.
    for (const tab of [
        ...(resolvedNav?.tabs ?? []),
        ...(resolvedNav?.global?.tabs ?? []),
    ]) {
        if (!tab.href || tab.hidden || !isAllowedUrl(tab.href)) continue
        const href = tab.href
        const isHttp = /^https?:\/\//i.test(href)
        pushLink(href, {
            type: "custom",
            children: (
                <a
                    href={withBase(href)}
                    {...(isHttp
                        ? { target: "_blank", rel: "noreferrer noopener" }
                        : {})}
                    className="mb-0.5 flex items-center gap-2 rounded-lg p-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground md:hidden [&_svg]:size-4"
                >
                    {navIcon(tab.icon)}
                    {tab.tab}
                </a>
            ),
        })
    }
    for (const dropdown of [
        ...(resolvedNav?.dropdowns ?? []),
        ...(resolvedNav?.global?.dropdowns ?? []),
    ]) {
        if (dropdown.hidden) continue
        const items: MenuItemType["items"] = []
        for (const tab of dropdown.tabs ?? []) {
            if (!tab.href || tab.hidden || !isAllowedUrl(tab.href)) continue
            items.push({
                text: tab.tab,
                url: tab.href,
                external: /^https?:\/\//i.test(tab.href),
            })
        }
        for (const anchor of dropdown.anchors ?? []) {
            if (!anchor.href || anchor.hidden || !isAllowedUrl(anchor.href))
                continue
            items.push({
                text: anchor.anchor,
                url: anchor.href,
                external: /^https?:\/\//i.test(anchor.href),
            })
        }
        for (const group of dropdown.groups ?? []) {
            if (group.hidden) continue
            for (const page of group.pages) {
                if (typeof page === "string") {
                    const url = page.startsWith("/")
                        ? page
                        : `/${page.replace(/\.(mdx|md)$/i, "")}`
                    items.push({ text: page, url })
                } else if ("href" in page && isAllowedUrl(page.href)) {
                    items.push({
                        text: group.group,
                        url: page.href,
                        external: /^https?:\/\//i.test(page.href),
                    })
                }
            }
        }
        if (items.length > 0) {
            links.push({
                type: "menu",
                text: dropdown.dropdown,
                items,
                ...(navIcon(dropdown.icon)
                    ? { icon: navIcon(dropdown.icon) }
                    : {}),
                ...(dropdown.href && isAllowedUrl(dropdown.href)
                    ? { url: dropdown.href }
                    : {}),
            })
        } else if (dropdown.href && isAllowedUrl(dropdown.href)) {
            pushLink(dropdown.href, {
                text: dropdown.dropdown,
                url: dropdown.href,
                external: /^https?:\/\//i.test(dropdown.href),
            })
        }
    }
    for (const item of resolvedNav?.menu ?? []) {
        const text = item.item
        if (!item.href || item.hidden || !isAllowedUrl(item.href)) continue
        pushLink(item.href, {
            text,
            url: item.href,
            external: /^https?:\/\//i.test(item.href),
        })
    }
    for (const product of [
        ...(resolvedNav?.products ?? []),
        ...(resolvedNav?.global?.products ?? []),
    ]) {
        if (product.hidden) continue
        const text = product.name ?? product.product
        if (product.href && isAllowedUrl(product.href)) {
            pushLink(product.href, {
                text,
                url: product.href,
                external: /^https?:\/\//i.test(product.href),
            })
            continue
        }

        const items: MenuItemType["items"] = []
        for (const tab of product.tabs ?? []) {
            if (!tab.href || tab.hidden || !isAllowedUrl(tab.href)) continue
            items.push({
                text: tab.tab,
                url: tab.href,
                external: /^https?:\/\//i.test(tab.href),
            })
        }
        for (const anchor of product.anchors ?? []) {
            if (!anchor.href || anchor.hidden || !isAllowedUrl(anchor.href))
                continue
            items.push({
                text: anchor.anchor,
                url: anchor.href,
                external: /^https?:\/\//i.test(anchor.href),
            })
        }
        for (const menuItem of product.menu ?? []) {
            if (
                !menuItem.href ||
                menuItem.hidden ||
                !isAllowedUrl(menuItem.href)
            )
                continue
            items.push({
                text: menuItem.item,
                url: menuItem.href,
                external: /^https?:\/\//i.test(menuItem.href),
            })
        }
        for (const group of product.groups ?? []) {
            if (group.hidden) continue
            for (const page of group.pages) {
                if (typeof page === "string") {
                    const url = page.startsWith("/")
                        ? page
                        : `/${page.replace(/\.(mdx|md)$/i, "")}`
                    items.push({ text: group.group, url })
                } else if ("href" in page && isAllowedUrl(page.href)) {
                    items.push({
                        text: group.group,
                        url: page.href,
                        external: /^https?:\/\//i.test(page.href),
                    })
                }
            }
        }
        for (const page of product.pages ?? []) {
            if (typeof page === "string") {
                const url = page.startsWith("/")
                    ? page
                    : `/${page.replace(/\.(mdx|md)$/i, "")}`
                items.push({ text: page, url })
            } else if ("href" in page && isAllowedUrl(page.href)) {
                items.push({
                    text,
                    url: page.href,
                    external: /^https?:\/\//i.test(page.href),
                })
            }
        }
        if (items.length > 0)
            links.push({
                type: "menu",
                text,
                items,
                ...(navIcon(product.icon)
                    ? { icon: navIcon(product.icon) }
                    : {}),
            })
    }

    // Global version control (versionSwitcherModel): the desktop dropdown
    // lives beside the logo in the band header / under the search row in
    // sidenav chrome; this md:hidden copy serves the mobile drawer (fumadocs
    // menu items expose no className hook, so it's a custom item).
    const versionModel = versionSwitcherModel(
        input.versionsManifest,
        input.activeLocale,
    )
    if (versionModel) {
        links.push({
            type: "custom",
            children: (
                <div className="mb-0.5 md:hidden">
                    <VersionSwitch model={versionModel} />
                </div>
            ),
        })
    }

    // Desktop navbar chrome lives in the header band (components/
    // docs-header.tsx, parity plan §A1) and the pinned sidebar footer
    // (routes/$.tsx); these are the md:hidden mobile-drawer copies of the
    // same navbarChromeLinks set — one parser, three surfaces.
    // Primary-flagged links render as real CTA buttons in both places.
    for (const link of navbarChromeLinks(config)) {
        const isMail = /^mailto:/i.test(link.href)
        const externalProps = link.external
            ? { target: "_blank", rel: "noreferrer noopener" }
            : {}
        pushLink(
            link.href,
            {
                type: "custom",
                children: link.primary ? (
                    <ChromeLink
                        href={link.href}
                        {...externalProps}
                        className={buttonVariants({
                            variant: "primary",
                            className: "w-full gap-1.5 rounded-lg md:hidden",
                        })}
                    >
                        {navIcon(link.icon)}
                        {link.label}
                    </ChromeLink>
                ) : (
                    // Text-first with a trailing glyph so the label lines up with
                    // the page-tree items below; p-2 matches their 36px height
                    // and rounded-lg their radius.
                    <ChromeLink
                        href={link.href}
                        {...externalProps}
                        className="mb-0.5 flex items-center gap-1.5 rounded-lg p-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground md:hidden [&_svg]:size-3.5"
                    >
                        {link.label}
                        {isMail ? (
                            <MailIcon />
                        ) : link.external ? (
                            <ExternalLinkIcon />
                        ) : null}
                    </ChromeLink>
                ),
            },
            link.primary,
        )
    }

    // footer.links columns render as a real page-bottom footer
    // (components/docs-footer.tsx) — not sidebar menus.

    // h-7 caps site wordmarks at a ~28px chrome height (§A4) —
    // bun's raw SVG carries width/height 210×70 and would render full-size
    // in the mobile header otherwise. The desktop band re-caps to the same.
    const logo = config?.logo
    const logoAlt = input.siteName ?? appName
    const logoSources =
        typeof logo === "string"
            ? { light: logo, dark: logo }
            : logo && typeof logo === "object"
              ? logo
              : null
    // serveLayoutConfig resolves width/height from docs_asset so the box is
    // reserved before the bytes arrive; a string logo carries none.
    const logoSize =
        logo && typeof logo === "object"
            ? { width: logo.width, height: logo.height }
            : {}
    let title: ReactNode = logoAlt
    if (logoSources && logoSources.light === logoSources.dark) {
        if (logoSources.light.startsWith("/_assets/"))
            title = (
                // biome-ignore lint/performance/noImgElement: site logos are immutable content-addressed assets, and this TanStack app has no image optimizer.
                <img
                    src={withBase(logoSources.light)}
                    alt={logoAlt}
                    {...logoSize}
                    className="h-7 w-auto"
                />
            )
    } else if (logoSources) {
        title = (
            <span>
                {logoSources.light.startsWith("/_assets/") ? (
                    // biome-ignore lint/performance/noImgElement: site logos are immutable content-addressed assets, and this TanStack app has no image optimizer.
                    <img
                        src={withBase(logoSources.light)}
                        alt={logoAlt}
                        {...logoSize}
                        className="nav-logo h-7 w-auto dark:hidden"
                    />
                ) : null}
                {logoSources.dark.startsWith("/_assets/") ? (
                    // biome-ignore lint/performance/noImgElement: site logos are immutable content-addressed assets, and this TanStack app has no image optimizer.
                    <img
                        src={withBase(logoSources.dark)}
                        alt={logoAlt}
                        {...logoSize}
                        className="nav-logo hidden h-7 w-auto dark:block"
                    />
                ) : null}
            </span>
        )
    }

    return {
        nav: { title },
        links,
        // Stamped by serveLayoutConfig: a repo the site links publicly.
        // fumadocs' own `githubUrl` icon pill is intentionally NOT emitted:
        // it renders as a mostly-empty bordered box pinned to the sidebar
        // bottom.
        githubRepo: config?.githubRepo,
        themeSwitch: {
            enabled: config?.appearance?.strict !== true,
            // Match the desktop band's 3-state control — fumadocs defaults
            // the sidebar/drawer copy to a 2-state toggle with no System.
            mode: "light-dark-system",
        },
        // "top" renders fumadocs' LayoutTabs into [grid-area:main], where the
        // grid stretches it into an opaque full-height overlay COVERING the
        // page (bun's all-tabs nav made every page invisible). "auto" renders
        // the tab switcher in the sidebar, where this framework keeps its nav
        // chrome anyway; sites can still opt into "top" explicitly.
        tabMode: config?.[CONFIG_EXTENSION_KEY]?.layout?.tabMode ?? "auto",
    }
}
