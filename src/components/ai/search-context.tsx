import {
    type ComponentProps,
    createContext,
    lazy,
    type ReactNode,
    Suspense,
    use,
    useEffect,
    useEffectEvent,
    useMemo,
    useState,
} from "react"
import { cn } from "../../lib/cn"

/**
 * The light half of the Assistant: open state, the docs path the question is
 * asked on, the header/float triggers and the Cmd+/ / Cmd+I hotkeys.
 * Everything that costs bundle weight — @ai-sdk/react, the streaming
 * transport, the markdown renderer — lives in ./search and loads on first
 * open (AISearchPanelSlot), so the first paint of every docs page no longer
 * ships a chat client.
 *
 * State and actions are separate contexts: every code block's "Ask AI"
 * button needs only `ask`, and a stable actions value keeps those buttons
 * (and the search dialog) from re-rendering on each open/draft change.
 */
const StateContext = createContext<{
    open: boolean
    /** Current docs path — /api/chat resolves the locale/version context
     * (and the feedback page) from it. */
    path: string
    /** Panel width on lg+: default rail width or the maximised reading width. */
    expanded: boolean
    /** Pending prefill for the input — consumed once the panel mounts it. */
    draft: string | null
    /** Whether the pending draft sends as soon as the panel consumes it
     * (the docked "Ask a question…" bar submits directly). */
    sendDraft: boolean
} | null>(null)

/** Null outside the provider — chrome that renders regardless of
 * <CONFIG_EXTENSION_KEY>.search.mode (search dialog, code blocks) reads it with use()
 * and offers its assistant affordance only when the Assistant exists. */
export const AISearchActionsContext = createContext<{
    setOpen: (open: boolean) => void
    setExpanded: (expanded: boolean) => void
    setDraft: (draft: string | null) => void
    setSendDraft: (send: boolean) => void
    /** Open the panel with `text` prefilled (search "Ask Assistant", code
     * block "Ask AI"). Sends only when `send` is set — otherwise the
     * visitor confirms. */
    ask: (text: string, options?: { send?: boolean }) => void
} | null>(null)

export function AISearch({
    children,
    path,
}: {
    children: ReactNode
    path: string
}) {
    const [open, setOpen] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [draft, setDraft] = useState<string | null>(null)
    const [sendDraft, setSendDraft] = useState(false)
    // Built once: state setters are stable, so the value never changes.
    const [actions] = useState(() => ({
        setOpen,
        setExpanded,
        setDraft,
        setSendDraft,
        ask: (text: string, options?: { send?: boolean }) => {
            setDraft(text)
            setSendDraft(options?.send === true)
            setOpen(true)
        },
    }))
    // The hotkey lives here (not in the panel) so it opens the Assistant
    // before its chunk has ever loaded.
    const onKeyPress = useEffectEvent((e: KeyboardEvent) => {
        if (e.key === "Escape" && open) {
            setOpen(false)
            e.preventDefault()
        }
        // Ctrl+/ (fumadocs) and Ctrl/Cmd+I both open the panel —
        // except while typing: inputs, textareas (the search box, the
        // assistant's own composer) and contenteditable editors keep their
        // native shortcuts (Cmd+I = italic).
        const typing =
            e.target instanceof HTMLElement &&
            (e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target.isContentEditable)
        if (
            (e.key === "/" || e.key === "i" || e.key === "I") &&
            (e.metaKey || e.ctrlKey) &&
            !e.altKey &&
            !e.shiftKey &&
            !open &&
            !typing
        ) {
            setOpen(true)
            e.preventDefault()
        }
    })
    useEffect(() => {
        window.addEventListener("keydown", onKeyPress)
        return () => window.removeEventListener("keydown", onKeyPress)
    }, [])

    return (
        <AISearchActionsContext value={actions}>
            <StateContext
                value={useMemo(
                    () => ({ open, path, expanded, draft, sendDraft }),
                    [open, path, expanded, draft, sendDraft],
                )}
            >
                {children}
            </StateContext>
        </AISearchActionsContext>
    )
}

const LazyPanel = lazy(() =>
    import("./search").then((module) => ({ default: module.AISearchPanel })),
)

/**
 * Mounts the heavy panel on first open and keeps it mounted afterwards so the
 * conversation survives closing the drawer. Never rendered on the server
 * (open starts false), so hydration sees the same empty slot.
 */
export function AISearchPanelSlot(props: {
    /** Seed questions — the current page's leading TOC headings. */
    suggestions?: string[]
}) {
    const { open } = useAISearchState()
    const [mounted, setMounted] = useState(false)
    useEffect(() => {
        if (open) setMounted(true)
    }, [open])
    return mounted ? (
        <Suspense fallback={null}>
            <LazyPanel suggestions={props.suggestions} />
        </Suspense>
    ) : null
}

export function AISearchTrigger({
    position = "default",
    className,
    ...props
}: ComponentProps<"button"> & { position?: "default" | "float" }) {
    const { open } = useAISearchState()
    const { setOpen } = useAISearchActions()

    return (
        <button
            data-state={open ? "open" : "closed"}
            // The float trigger hides when the panel opens; opacity alone kept
            // an invisible button clickable and tabbable under the panel.
            inert={(position === "float" && open) || undefined}
            className={cn(
                position === "float" && [
                    // Bottom-centred "Ask a question…" bar.
                    // max-md:hidden: on phone widths the pill sat on top of
                    // full-width code blocks (obscuring line ends and the
                    // copy corner) with no free gutter to move it into.
                    "fixed bottom-[max(--spacing(4),env(safe-area-inset-bottom))] inset-x-0 mx-auto w-fit gap-3 shadow-lg z-20 transition-[translate,opacity] max-md:hidden",
                    open && "translate-y-10 opacity-0 pointer-events-none",
                ],
                className,
            )}
            onClick={() => setOpen(!open)}
            // Warm the panel chunk on intent so the first open paints at once.
            onPointerEnter={() => void import("./search")}
            onFocus={() => void import("./search")}
            {...props}
        >
            {props.children}
        </button>
    )
}

export function useAISearchState() {
    const context = use(StateContext)
    if (!context) {
        throw new Error("AISearch components must be rendered inside AISearch.")
    }
    return context
}

export function useAISearchActions() {
    const context = use(AISearchActionsContext)
    if (!context) {
        throw new Error("AISearch components must be rendered inside AISearch.")
    }
    return context
}

/**
 * Platform-aware hotkey caption for the assistant triggers ("⌘I" / "Ctrl I").
 * Defaults to the Ctrl spelling and corrects after mount, matching the
 * header search pill.
 */
export function useAssistantHotkeyLabel() {
    const [label, setLabel] = useState("Ctrl I")
    useEffect(() => {
        if (/Mac|iP(hone|ad|od)/.test(navigator.platform ?? "")) setLabel("⌘I")
    }, [])
    return label
}
