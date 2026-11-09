import { useState } from "react"
import { useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import {
    useAISearchActions,
    useAISearchState,
    useAssistantHotkeyLabel,
} from "./search-context"

/**
 * The luma theme's docked "Ask a question…" bar: a 58px pill the width of the
 * article column, pinned to the bottom of the viewport while the column
 * scrolls (sticky as the column's last child), with the platform hotkey
 * caption and a round send button. Submitting opens the Assistant panel and
 * sends the question straight away — the visitor already typed it here.
 * Hidden (inert) while the panel is open, like the floating trigger.
 */
export function AssistantDock() {
    const { open } = useAISearchState()
    const { ask } = useAISearchActions()
    const strings = useChromeStrings()
    const hotkey = useAssistantHotkeyLabel()
    const [value, setValue] = useState("")
    const submit = () => {
        const text = value.trim()
        if (text.length === 0) return
        ask(text, { send: true })
        setValue("")
    }
    return (
        <form
            data-assistant-dock=""
            inert={open || undefined}
            className={cn(
                "sticky bottom-6 z-20 mt-10 flex h-[58px] w-full items-center gap-3 rounded-full border bg-fd-background ps-5 pe-2 shadow-sm transition-[translate,opacity] max-md:hidden",
                open && "translate-y-10 opacity-0",
            )}
            onSubmit={(event) => {
                event.preventDefault()
                submit()
            }}
            // Warm the panel chunk on intent so the first send paints at once.
            onPointerEnter={() => void import("./search")}
            onFocus={() => void import("./search")}
        >
            <input
                type="text"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={`${strings.askQuestion}...`}
                aria-label={`${strings.askQuestion}...`}
                autoComplete="off"
                className="h-10 min-w-0 flex-1 bg-transparent text-fd-foreground text-sm outline-none placeholder:text-fd-muted-foreground"
            />
            <kbd className="shrink-0 font-medium font-sans text-fd-muted-foreground text-xs">
                {hotkey.replace(/\s+/, "+")}
            </kbd>
            <button
                type="submit"
                aria-label="Send message"
                disabled={value.trim().length === 0}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground transition-opacity disabled:opacity-40"
            >
                <svg
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="size-2.5"
                >
                    <path d="M9 1.58V16.42" />
                    <path d="M2.26 8.32 9 1.58l6.74 6.74" />
                </svg>
            </button>
        </form>
    )
}
