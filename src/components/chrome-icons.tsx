import CHROME_ICONS from "virtual:chrome-icons"
import type { ComponentProps } from "react"
import { cn } from "@/lib/cn"

/**
 * Framework chrome icons, rendered from the same generated Hugeicons map that
 * serves tenant content — so our own UI matches the icons tenants get, without
 * a second icon dependency (fumadocs-ui keeps its internal lucide glyphs;
 * those are not ours to swap). The handful of glyphs the chrome needs are
 * extracted at BUILD time (virtual:chrome-icons in vite.config.ts) so the
 * 2 MB icon map itself never reaches the browser.
 */
export function chromeIconSvg(name: string): string {
    const svg = CHROME_ICONS[name]
    if (!svg) throw new Error(`chrome icon "${name}" is missing from the map`)
    return svg
}

/** A span component rendering one chrome glyph at `size-4`; size it with a
 * `size-*` class, thicken it with `[&_[stroke]]:stroke-*`. */
export function chromeIcon(name: string) {
    const svg = chromeIconSvg(name)
    // biome-ignore lint/correctness/noComponentHookFactories: callers build each icon once at module level.
    return function ChromeIcon({
        className,
        ...props
    }: ComponentProps<"span">) {
        return (
            <span
                aria-hidden="true"
                // The mapped SVGs carry only a viewBox (no width/height), so
                // the wrapper must own a definite size — callers override it
                // with their own size-* class.
                className={cn(
                    "inline-flex size-4 [&>svg]:size-full",
                    className,
                )}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: markup comes from the generated icon map, never user input
                dangerouslySetInnerHTML={{ __html: svg }} // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- `svg` is a CHROME_ICONS entry (committed, generated icon map), never tenant input
                {...props}
            />
        )
    }
}

export const BugIcon = chromeIcon("bug")
export const ChevronDownIcon = chromeIcon("chevron-down")
export const ExternalLinkIcon = chromeIcon("external-link")
export const FileTextIcon = chromeIcon("file-text")
export const LoaderIcon = chromeIcon("loader-circle")
export const MailIcon = chromeIcon("mail")
export const MaximizeIcon = chromeIcon("maximize-2")
export const MessageCircleIcon = chromeIcon("message-circle")
export const MinimizeIcon = chromeIcon("minimize-2")
export const RefreshIcon = chromeIcon("refresh-cw")
export const SearchIcon = chromeIcon("search")
export const SendIcon = chromeIcon("send")
export const SparklesIcon = chromeIcon("sparkles")
export const TextIcon = chromeIcon("text")
export const XIcon = chromeIcon("x")
