import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "fumadocs-ui/components/ui/popover"
import { ChromeLink } from "@/components/chrome-link"

export interface VersionSwitchItem {
    label: string
    url: string
    external: boolean
    /** docs.json version.tag — a small badge beside the entry. */
    tag?: string
}

/**
 * Built by versionSwitcherModel (lib/layout.shared.tsx). The types live here
 * so layout.shared can build the model and docs-header can render it without
 * a docs-header ↔ layout.shared import cycle.
 */
export interface VersionSwitchModel {
    /** Trigger/chip label — the default (or first visible) version root. */
    label: string
    /** Menu destinations; null renders the single-visible static chip. */
    items: VersionSwitchItem[] | null
}

/**
 * Global version control: a dropdown beside the logo in
 * band chrome, a row under search in sidenav chrome, and a mobile drawer
 * copy. A lone visible version among hidden siblings uses the chip form.
 */
export function VersionSwitch(props: { model: VersionSwitchModel }) {
    if (props.model.items === null) {
        return (
            <span className="inline-flex h-9 items-center rounded-xl bg-fd-foreground/[0.04] px-3 font-medium text-fd-muted-foreground text-sm dark:bg-fd-secondary">
                {props.model.label}
            </span>
        )
    }
    return (
        <Popover>
            <PopoverTrigger
                aria-label="Version"
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-fd-foreground/[0.04] px-3 font-medium text-fd-muted-foreground text-sm transition-colors hover:bg-fd-foreground/[0.07] hover:text-fd-accent-foreground dark:bg-fd-secondary dark:hover:bg-fd-secondary/80"
            >
                {props.model.label}
                <svg
                    role="img"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="size-3.5"
                >
                    <title>Choose version</title>
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </PopoverTrigger>
            <PopoverContent className="flex w-36 flex-col p-1">
                {props.model.items.map((item) => (
                    <ChromeLink
                        key={item.label}
                        href={item.url}
                        role="menuitem"
                        {...(item.external
                            ? { target: "_blank", rel: "noreferrer noopener" }
                            : {})}
                        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
                    >
                        {item.label}
                        {item.tag ? (
                            <span className="rounded-full border bg-fd-muted px-1.5 py-px font-medium text-[0.65rem] text-fd-muted-foreground">
                                {item.tag}
                            </span>
                        ) : null}
                    </ChromeLink>
                ))}
            </PopoverContent>
        </Popover>
    )
}
