import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { flushSync } from "react-dom"
import { cn } from "@/lib/cn"

const ORDER = ["light", "dark", "system"] as const

/**
 * luma theme control: ONE round icon button that cycles
 * light → dark → system (the icon shows the current preference; the monitor
 * glyph is "system"). Keeps fumadocs' `aria-label="Toggle Theme"` and
 * `data-theme-toggle` hooks so the chrome e2e's single-toggle assertion and
 * site CSS keep working.
 */
export function ThemeCycleButton(props: { className?: string }) {
    const { setTheme, theme, resolvedTheme } = useTheme()
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])
    const current = mounted
        ? (ORDER.find((entry) => entry === theme) ?? "system")
        : "system"
    // From "system" the first click flips the RESOLVED scheme (a visitor
    // pressing the button wants the other look, not a no-op), then
    // light → dark → system.
    const next =
        current === "system"
            ? resolvedTheme === "dark"
                ? "light"
                : "dark"
            : current === "light"
              ? "dark"
              : "system"
    return (
        <button
            type="button"
            aria-label="Toggle Theme"
            title={`Theme: ${current}`}
            data-theme-toggle=""
            data-theme-preference={current}
            className={cn(
                "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-fd-foreground/[0.03] text-fd-muted-foreground transition-colors hover:bg-fd-foreground/[0.07] hover:text-fd-foreground",
                props.className,
            )}
            onClick={() => {
                if (document.startViewTransition)
                    document.startViewTransition(() =>
                        flushSync(() => setTheme(next)),
                    )
                else setTheme(next)
            }}
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="size-4"
            >
                {current === "light" ? (
                    <>
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                    </>
                ) : current === "dark" ? (
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                ) : (
                    <>
                        <rect width="20" height="14" x="2" y="3" rx="2" />
                        <path d="M8 21h8M12 17v4" />
                    </>
                )}
            </svg>
        </button>
    )
}
