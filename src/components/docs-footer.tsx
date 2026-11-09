import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch"
import type { ReactNode } from "react"
import { array, minLength, object, string, unknown } from "zod/mini"
import { ChromeLink } from "@/components/chrome-link"
import { FooterSocials } from "@/components/page-feedback"
import type { LayoutConfig } from "@/lib/source"
import { isAllowedUrl } from "@/types/docs-shared"

const footerItemSchema = object({
    label: string().check(minLength(1)),
    href: string().check(minLength(1)),
})
const footerColumnSchema = object({
    header: string().check(minLength(1)),
    items: array(unknown()),
})

/**
 * docs.json footer.links columns as a real multi-column page-bottom footer
 * (Explore/Resources/… columns), not sidebar menu entries.
 *
 * Default: rendered after the socials row at the end of the article column.
 * luma (`variant="luma"`): an advanced footer spanning the main +
 * TOC tracks of #nd-docs-layout — logo and socials in a left column, the
 * link columns beside it, then a hairline bar with the wordmark and the
 * 3-way theme control. Absent config renders nothing (luma still renders
 * the bar).
 */
export function DocsFooter(props: {
    links: unknown
    variant?: "default" | "luma"
    socials?: NonNullable<LayoutConfig["footer"]>["socials"]
    logo?: ReactNode
    logoHref?: string
    themeSwitchEnabled?: boolean
}) {
    const rawColumns = Array.isArray(props.links) ? props.links : []
    const columns = rawColumns.flatMap((rawColumn) => {
        const column = footerColumnSchema.safeParse(rawColumn)
        if (!column.success) return []
        const items = column.data.items.flatMap((rawItem) => {
            const item = footerItemSchema.safeParse(rawItem)
            return item.success && isAllowedUrl(item.data.href)
                ? [item.data]
                : []
        })
        return items.length > 0 ? [{ header: column.data.header, items }] : []
    })
    const columnList = (
        <div
            className={
                props.variant === "luma"
                    ? "grid flex-1 grid-cols-2 gap-8 sm:grid-cols-4"
                    : "grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-4"
            }
        >
            {columns.map((column) => (
                <div key={column.header} className="flex flex-col gap-4">
                    <p className="my-0 font-semibold text-fd-foreground text-sm">
                        {column.header}
                    </p>
                    <ul className="my-0 flex list-none flex-col gap-4 ps-0">
                        {column.items.map((item) => (
                            <li key={`${item.label}:${item.href}`}>
                                <ChromeLink
                                    href={item.href}
                                    {...(/^https?:\/\//i.test(item.href)
                                        ? {
                                              target: "_blank",
                                              rel: "noreferrer noopener",
                                          }
                                        : {})}
                                    className="text-fd-muted-foreground text-sm transition-colors hover:text-fd-accent-foreground"
                                >
                                    {item.label}
                                </ChromeLink>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    )
    if (props.variant !== "luma") {
        if (columns.length === 0) return null
        return (
            <footer className="mt-12 border-t pt-10 pb-4">{columnList}</footer>
        )
    }
    return (
        <footer
            id="footer"
            data-footer-variant="luma"
            // Placed by fumadocs' named `main` area lines, not track numbers:
            // the implicit row after `main`, under the main track and the TOC
            // track beside it. A fixed row number broke when fumadocs added a
            // `tabs` row above `main`. Rendered at every width — below md it
            // is the only footer the page has.
            className="[grid-column:main-start/span_2] [grid-row:main-end] mt-12 flex w-full flex-col gap-12 px-4 pt-12 pb-10 text-sm md:px-8 md:pt-16"
        >
            <div className="flex flex-col justify-between gap-8 md:flex-row">
                <div className="flex min-w-[140px] flex-col justify-between gap-8">
                    <ChromeLink
                        href={props.logoHref ?? "/"}
                        className="inline-flex w-fit items-center [&_img]:h-6 [&_img]:w-auto"
                    >
                        {props.logo}
                    </ChromeLink>
                    <FooterSocials socials={props.socials} />
                </div>
                {columns.length > 0 ? columnList : null}
            </div>
            <div className="flex items-center justify-between border-t pt-6">
                <span className="inline-flex items-center opacity-60 [&_img]:h-4 [&_img]:w-auto">
                    {props.logo}
                </span>
                {props.themeSwitchEnabled ? (
                    <ThemeSwitch mode="light-dark-system" />
                ) : null}
            </div>
        </footer>
    )
}
