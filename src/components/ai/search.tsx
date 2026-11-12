"use client"
import { type UseChatHelpers, useChat } from "@ai-sdk/react"
import { Presence } from "@radix-ui/react-presence"
import {
    DefaultChatTransport,
    type InferUITool,
    type Tool,
    type UIMessage,
    type UIToolInvocation,
} from "ai"
import type { SortedResult } from "fumadocs-core/search"
import {
    type ComponentProps,
    createContext,
    type SyntheticEvent,
    use,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react"
import { minLength, object, string } from "zod/mini"
import {
    LoaderIcon,
    MaximizeIcon,
    MessageCircleIcon,
    MinimizeIcon,
    RefreshIcon,
    SearchIcon,
    SendIcon,
    XIcon,
} from "@/components/chrome-icons"
import { basePath, stripBase, withBase } from "@/lib/base-path"
import { useChromeStrings } from "@/lib/chrome-strings"
import type { BrowserEvent } from "@/routes/api/agent.event"
import { cn } from "../../lib/cn"
import { Markdown } from "../markdown"
import { buttonVariants } from "../ui/button"
import { useAISearchActions, useAISearchState } from "./search-context"

export type ChatUIMessage = UIMessage<
    {
        /** Minted by /api/chat per answer; thumbs feedback sends it back. */
        answerId?: string
        /** The docs page the question was asked on — votes report this page. */
        pageUrl?: string
    },
    {
        client: {
            location: string
        }
    },
    { search: InferUITool<SearchTool> }
>

export type SearchTool = Tool<{ query: string; limit: number }, SortedResult[]>

/** The chat lives with the (lazily loaded) panel, not the light provider in
 * search-context.tsx — mounting @ai-sdk/react on every page load was most of
 * what kept the AI stack in the first-paint bundle. */
const ChatContext = createContext<UseChatHelpers<ChatUIMessage> | null>(null)
const assistantErrorSchema = object({
    error: string(),
    message: string().check(minLength(1)),
})

export function AISearchPanelHeader({
    className,
    ...props
}: ComponentProps<"div">) {
    const { expanded } = useAISearchState()
    const { setOpen, setExpanded } = useAISearchActions()
    const strings = useChromeStrings()

    return (
        <div
            className={cn(
                "sticky top-0 flex items-start gap-2 border rounded-xl bg-fd-secondary text-fd-secondary-foreground shadow-sm",
                className,
            )}
            {...props}
        >
            <div className="px-3 py-2 flex-1">
                <p className="text-sm font-medium mb-2">{strings.assistant}</p>
                <p className="text-xs text-fd-muted-foreground">
                    {strings.aiDisclaimer}
                </p>
            </div>
            {/* Maximise/minimise: widens the lg+ rail
                into a reading-width column; below lg the panel is already
                a near-fullscreen sheet, so the control hides there. */}
            <button
                type="button"
                aria-label={expanded ? strings.minimize : strings.maximize}
                aria-pressed={expanded}
                data-testid="assistant-maximize"
                className={cn(
                    buttonVariants({
                        size: "icon-sm",
                        color: "ghost",
                        className:
                            "text-fd-muted-foreground rounded-full max-lg:hidden",
                    }),
                )}
                onClick={() => setExpanded(!expanded)}
            >
                {expanded ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>

            <button
                type="button"
                aria-label={strings.close}
                tabIndex={-1}
                className={cn(
                    buttonVariants({
                        size: "icon-sm",
                        color: "ghost",
                        className: "text-fd-muted-foreground rounded-full",
                    }),
                )}
                onClick={() => setOpen(false)}
            >
                <XIcon />
            </button>
        </div>
    )
}

export function AISearchInputActions() {
    const { messages, status, setMessages, regenerate } = useChatContext()
    const strings = useChromeStrings()
    const isLoading = status === "streaming"

    if (messages.length === 0) return null

    return (
        <>
            {!isLoading && messages.at(-1)?.role === "assistant" && (
                <button
                    type="button"
                    className={cn(
                        buttonVariants({
                            color: "secondary",
                            size: "sm",
                            className: "rounded-full gap-1.5",
                        }),
                    )}
                    onClick={() => regenerate()}
                >
                    <RefreshIcon className="size-4" />
                    {strings.retry}
                </button>
            )}
            <button
                type="button"
                className={cn(
                    buttonVariants({
                        color: "secondary",
                        size: "sm",
                        className: "rounded-full",
                    }),
                )}
                onClick={() => setMessages([])}
            >
                {strings.clearChat}
            </button>
        </>
    )
}

const StorageKeyInput = "docs:v1:ai-search-input"
export function AISearchInput(props: ComponentProps<"form">) {
    const { status, sendMessage, stop } = useChatContext()
    const { draft, sendDraft } = useAISearchState()
    const { setDraft, setSendDraft } = useAISearchActions()
    const strings = useChromeStrings()
    const [input, setInput] = useState(
        () => localStorage.getItem(StorageKeyInput) ?? "",
    )
    const isLoading = status === "streaming" || status === "submitted"
    const send = useCallback(
        (message: string) => {
            void sendMessage({
                role: "user",
                parts: [
                    {
                        type: "data-client",
                        data: {
                            location: location.href,
                        },
                    },
                    {
                        type: "text",
                        text: message,
                    },
                ],
            })
            setInput("")
            localStorage.removeItem(StorageKeyInput)
        },
        [sendMessage],
    )
    // Prefilled asks (search dialog, code blocks) land here once the panel
    // has mounted the input; consuming the draft keeps a later manual open
    // from re-filling it. The docked bar's asks send straight away.
    useEffect(() => {
        if (draft === null) return
        setDraft(null)
        if (sendDraft) {
            setSendDraft(false)
            if (draft.trim().length > 0) send(draft.trim())
            return
        }
        setInput(draft)
        localStorage.setItem(StorageKeyInput, draft)
        const element = document.getElementById("nd-ai-input")
        if (element instanceof HTMLTextAreaElement) {
            element.focus()
            element.setSelectionRange(draft.length, draft.length)
        }
    }, [draft, setDraft, sendDraft, setSendDraft, send])
    const onStart = (e?: SyntheticEvent) => {
        e?.preventDefault()
        const message = input.trim()
        if (message.length === 0) return
        send(message)
    }

    useEffect(() => {
        if (isLoading) document.getElementById("nd-ai-input")?.focus()
    }, [isLoading])

    return (
        <form
            {...props}
            className={cn("flex items-start pe-2", props.className)}
            onSubmit={onStart}
        >
            <Input
                value={input}
                placeholder={
                    isLoading ? strings.aiAnswering : strings.askQuestion
                }
                autoFocus
                className="p-3"
                disabled={status === "streaming" || status === "submitted"}
                onChange={(e) => {
                    setInput(e.target.value)
                    localStorage.setItem(StorageKeyInput, e.target.value)
                }}
                onKeyDown={(event) => {
                    if (!event.shiftKey && event.key === "Enter") {
                        onStart(event)
                    }
                }}
            />
            {isLoading ? (
                <button
                    key="bn"
                    type="button"
                    className={cn(
                        buttonVariants({
                            color: "secondary",
                            className: "transition-all rounded-full mt-2 gap-2",
                        }),
                    )}
                    onClick={stop}
                >
                    <LoaderIcon className="size-4 animate-spin text-fd-muted-foreground" />
                    {strings.abortAnswer}
                </button>
            ) : (
                <button
                    key="bn"
                    type="submit"
                    className={cn(
                        buttonVariants({
                            color: "primary",
                            className: "transition-all rounded-full mt-2",
                        }),
                    )}
                    disabled={input.length === 0}
                >
                    <SendIcon className="size-4" />
                </button>
            )}
        </form>
    )
}

function List(props: Omit<ComponentProps<"div">, "dir">) {
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!containerRef.current) return
        function callback() {
            const container = containerRef.current
            if (!container) return

            container.scrollTo({
                top: container.scrollHeight,
                behavior: "instant",
            })
        }

        const observer = new ResizeObserver(callback)
        callback()

        const element = containerRef.current?.firstElementChild

        if (element) {
            observer.observe(element)
        }

        return () => {
            observer.disconnect()
        }
    }, [])

    return (
        <div
            ref={containerRef}
            {...props}
            className={cn(
                "fd-scroll-container overflow-y-auto min-w-0 flex flex-col",
                props.className,
            )}
        >
            {props.children}
        </div>
    )
}

function Input(props: ComponentProps<"textarea">) {
    const ref = useRef<HTMLDivElement>(null)
    const shared = cn("col-start-1 row-start-1", props.className)

    return (
        <div className="grid flex-1">
            <textarea
                id="nd-ai-input"
                {...props}
                className={cn(
                    "resize-none bg-transparent placeholder:text-fd-muted-foreground focus-visible:outline-none",
                    shared,
                )}
            />
            <div ref={ref} className={cn(shared, "break-all invisible")}>
                {`${props.value?.toString() ?? ""}\n`}
            </div>
        </div>
    )
}

function Message({
    message,
    ...props
}: { message: ChatUIMessage } & ComponentProps<"div">) {
    const { status, messages } = useChatContext()
    const strings = useChromeStrings()
    const [voted, setVoted] = useState<"helpful" | "not_helpful" | null>(null)
    let markdown = ""
    const searchCalls: UIToolInvocation<SearchTool>[] = []

    for (const part of message.parts ?? []) {
        if (part.type === "text") {
            markdown += part.text
            continue
        }

        if (part.type === "tool-search" && part.toolCallId)
            searchCalls.push(part)
    }

    // Chat-answer thumbs, same POST as the page widget (page-feedback.tsx).
    // The message metadata's answerId (set by /api/chat) rides along so the
    // stored vote names the answer it rates.
    const answered =
        message.role === "assistant" &&
        markdown.length > 0 &&
        !(
            (status === "streaming" || status === "submitted") &&
            messages.at(-1)?.id === message.id
        )
    const vote = (kind: "helpful" | "not_helpful") => {
        setVoted(kind)
        const { answerId, pageUrl } = message.metadata ?? {}
        // Best-effort — the widget thanks optimistically either way.
        void fetch(withBase("/api/agent/feedback"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                // The answer's origin page, not wherever the visitor
                // navigated to before clicking the thumb.
                url: pageUrl ?? location.pathname,
                kind,
                source: "chat_answer",
                ...(answerId ? { answerId } : {}),
            }),
        }).catch(() => {})
    }

    return (
        <div {...props}>
            <p
                className={cn(
                    "mb-1 text-sm font-medium text-fd-muted-foreground",
                    message.role === "assistant" && "text-fd-primary",
                )}
            >
                {message.role === "user"
                    ? strings.you
                    : message.role === "assistant"
                      ? strings.assistant
                      : message.role}
            </p>
            <div className="prose text-sm">
                <Markdown text={markdown} />
            </div>

            {searchCalls.map((call) => {
                // One expandable chip per tool call, labeled with the query —
                // a bare "10 search results" pill per call read as debug
                // output once the model ran several searches.
                const failed =
                    call.state === "output-error" ||
                    call.state === "output-denied"
                const query =
                    call.input && typeof call.input.query === "string"
                        ? call.input.query
                        : null
                const hits = (call.output ?? []).filter(
                    (hit) => hit.type === "page",
                )
                return (
                    <details
                        key={call.toolCallId}
                        className="mt-3 rounded-lg border bg-fd-secondary text-fd-muted-foreground text-xs"
                    >
                        <summary className="flex cursor-pointer list-none flex-row items-center gap-2 p-2 [&::-webkit-details-marker]:hidden">
                            <SearchIcon className="size-4 shrink-0" />
                            {failed ? (
                                <span className="text-fd-error">
                                    {call.errorText ?? strings.searchFailed}
                                </span>
                            ) : !call.output ? (
                                <span>
                                    {query
                                        ? `${strings.searching} "${query}"…`
                                        : `${strings.searching}…`}
                                </span>
                            ) : (
                                <span>
                                    {query
                                        ? `${strings.searched} "${query}"`
                                        : strings.searched}
                                    {` · ${strings.results}: ${call.output.length}`}
                                </span>
                            )}
                        </summary>
                        {hits.length > 0 ? (
                            <ul className="flex flex-col gap-1 border-t p-2">
                                {hits.slice(0, 6).map((hit, index) => (
                                    <li key={hit.id} className="truncate">
                                        <a
                                            href={withBase(hit.url)}
                                            // Which cited page the reader
                                            // followed — never the query or
                                            // the answer text.
                                            onClick={() => {
                                                const beacon = JSON.stringify({
                                                    type: "chat_citation_clicked",
                                                    // The router's path, as
                                                    // every page_path is.
                                                    page_path:
                                                        stripBase(
                                                            location.pathname,
                                                            basePath(),
                                                        ) ?? location.pathname,
                                                    hit_position: index + 1,
                                                } satisfies BrowserEvent)
                                                if (
                                                    !navigator.sendBeacon(
                                                        withBase(
                                                            "/api/agent/event",
                                                        ),
                                                        beacon,
                                                    )
                                                )
                                                    void fetch(
                                                        withBase(
                                                            "/api/agent/event",
                                                        ),
                                                        {
                                                            method: "POST",
                                                            body: beacon,
                                                            keepalive: true,
                                                        },
                                                    ).catch(() => {})
                                            }}
                                            className="hover:text-fd-accent-foreground hover:underline"
                                        >
                                            {hit.content}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </details>
                )
            })}

            {answered && (
                <div className="mt-2 flex items-center gap-1 text-fd-muted-foreground text-xs">
                    {voted ? (
                        <span>{strings.thanksFeedback}</span>
                    ) : (
                        <>
                            <button
                                type="button"
                                aria-label={strings.helpful}
                                className={cn(
                                    buttonVariants({
                                        size: "icon-sm",
                                        color: "ghost",
                                        className:
                                            "rounded-full text-fd-muted-foreground",
                                    }),
                                )}
                                onClick={() => vote("helpful")}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="size-3.5"
                                    aria-hidden
                                >
                                    <title>{strings.helpful}</title>
                                    <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
                                </svg>
                            </button>
                            <button
                                type="button"
                                aria-label={strings.notHelpful}
                                className={cn(
                                    buttonVariants({
                                        size: "icon-sm",
                                        color: "ghost",
                                        className:
                                            "rounded-full text-fd-muted-foreground",
                                    }),
                                )}
                                onClick={() => vote("not_helpful")}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="size-3.5"
                                    aria-hidden
                                >
                                    <title>{strings.notHelpful}</title>
                                    <path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
                                </svg>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

export function AISearchPanel(props: {
    /** Seed questions — the current page's leading TOC headings. */
    suggestions?: string[]
}) {
    const { open, expanded, path } = useAISearchState()
    const { setOpen } = useAISearchActions()
    const strings = useChromeStrings()
    // The transport closes over the path at construction; a ref keeps the
    // chat stable across client navigations (the provider lives in the root
    // route, above every page) while requests still carry the CURRENT page.
    const pathRef = useRef(path)
    pathRef.current = path
    const chat = useChat<ChatUIMessage>({
        id: "search",
        transport: new DefaultChatTransport({
            api: withBase("/api/chat"),
            prepareSendMessagesRequest({ id, messages, trigger, messageId }) {
                return {
                    body: {
                        id,
                        messages,
                        trigger,
                        messageId,
                        // Inbound paths are public (normalizeDocUrl).
                        path: withBase(pathRef.current),
                    },
                }
            },
        }),
    })

    return (
        <ChatContext value={chat}>
            <style>
                {`
        @keyframes ask-ai-open {
          from {
            translate: 100% 0;
          }
          to {
            translate: 0 0;
          }
        }
        @keyframes ask-ai-close {
          from {
            width: var(--ai-chat-width);
          }
          to {
            width: 0px;
          }
        }`}
            </style>
            <Presence present={open}>
                <button
                    type="button"
                    aria-label={strings.close}
                    className={cn(
                        "fixed inset-0 z-30 backdrop-blur-xs bg-fd-overlay lg:hidden",
                        open ? "animate-fd-fade-in" : "animate-fd-fade-out",
                    )}
                    onClick={() => setOpen(false)}
                />
            </Presence>
            <Presence present={open}>
                <div
                    role="dialog"
                    aria-label={strings.assistant}
                    data-expanded={expanded || undefined}
                    // app.css sizes the docs grid's toc track from this
                    // attribute so the column grows with the panel.
                    data-assistant-panel=""
                    className={cn(
                        "overflow-hidden z-30 bg-fd-card text-fd-card-foreground",
                        // Maximised: a reading-width column (the toc grid
                        // track stretches with it; the article yields).
                        // Widths: app.css --ai-chat-width(-expanded).
                        expanded &&
                            "lg:[--ai-chat-width:var(--ai-chat-width-expanded)]",
                        "max-lg:fixed max-lg:inset-x-2 max-lg:inset-y-4 max-lg:border max-lg:rounded-2xl max-lg:shadow-xl",
                        // Under the docs header like the TOC it replaces:
                        // --fd-docs-row-1 is the height of everything pinned
                        // above the layout. At top-0 and full height the
                        // panel ran past the viewport by that much, hiding
                        // its input, and slid under the header on scroll.
                        "lg:sticky lg:top-[var(--fd-docs-row-1,0px)] lg:h-[calc(100dvh-var(--fd-docs-row-1,0px))] lg:border-s lg:ms-auto lg:in-[#nd-docs-layout]:[grid-area:toc] lg:in-[#nd-notebook-layout]:row-span-full lg:in-[#nd-notebook-layout]:col-start-5",
                        open
                            ? "animate-fd-dialog-in lg:animate-[ask-ai-open_200ms]"
                            : "animate-fd-dialog-out lg:animate-[ask-ai-close_200ms]",
                    )}
                >
                    <div className="flex flex-col size-full p-2 lg:p-3 lg:w-(--ai-chat-width)">
                        <AISearchPanelHeader />
                        <AISearchPanelList
                            className="flex-1"
                            suggestions={props.suggestions}
                        />
                        <div className="rounded-xl border bg-fd-secondary text-fd-secondary-foreground shadow-sm has-focus-visible:shadow-md">
                            <AISearchInput />
                            <div className="flex items-center gap-1.5 p-1 empty:hidden">
                                <AISearchInputActions />
                            </div>
                        </div>
                    </div>
                </div>
            </Presence>
        </ChatContext>
    )
}

export function AISearchPanelList({
    className,
    style,
    suggestions,
    ...props
}: ComponentProps<"div"> & { suggestions?: string[] }) {
    const chat = useChatContext()
    const strings = useChromeStrings()
    const messages = chat.messages.filter((msg) => msg.role !== "system")
    const seeds = (suggestions ?? []).filter((s) => s.trim().length > 0)
    let errorMessage = "The assistant request failed. Please try again."
    if (chat.error) {
        try {
            const parsed = assistantErrorSchema.safeParse(
                JSON.parse(chat.error.message),
            )
            if (parsed.success) errorMessage = parsed.data.message
        } catch {
            // Unstructured transport errors use the readable fallback.
        }
    }

    return (
        <List
            className={cn("py-4 overscroll-contain", className)}
            style={{
                maskImage:
                    "linear-gradient(to bottom, transparent, white 1rem, white calc(100% - 1rem), transparent 100%)",
                ...style,
            }}
            {...props}
        >
            {messages.length === 0 ? (
                <div className="text-sm text-fd-muted-foreground/80 size-full flex flex-col items-center justify-center text-center gap-2 px-3">
                    <MessageCircleIcon className="size-6" />
                    {seeds.length > 0 ? (
                        // "Suggestions" block: one tap asks about
                        // a section of the page the visitor is reading.
                        <div
                            data-testid="assistant-suggestions"
                            className="mt-4 flex w-full flex-col items-stretch gap-1.5 text-start"
                        >
                            <p className="px-1 font-medium text-fd-muted-foreground text-xs uppercase tracking-wide">
                                {strings.suggestions}
                            </p>
                            {seeds.slice(0, 3).map((seed) => (
                                <button
                                    key={seed}
                                    type="button"
                                    onClick={() =>
                                        void chat.sendMessage({
                                            role: "user",
                                            parts: [
                                                {
                                                    type: "data-client",
                                                    data: {
                                                        location: location.href,
                                                    },
                                                },
                                                { type: "text", text: seed },
                                            ],
                                        })
                                    }
                                    className="rounded-lg border bg-fd-secondary px-3 py-2 text-start text-fd-secondary-foreground text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
                                >
                                    {seed}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="flex flex-col px-3 gap-4">
                    {chat.error && (
                        <div className="p-2 bg-fd-secondary text-fd-secondary-foreground border rounded-lg">
                            <p className="text-xs text-fd-muted-foreground mb-1">
                                {strings.requestFailed}: {chat.error.name}
                            </p>
                            <p className="text-sm">{errorMessage}</p>
                        </div>
                    )}
                    {messages.map((item) => (
                        <Message key={item.id} message={item} />
                    ))}
                </div>
            )}
        </List>
    )
}

function useChatContext() {
    const chat = use(ChatContext)
    if (!chat) {
        throw new Error(
            "Chat components must be rendered inside AISearchPanel.",
        )
    }
    return chat
}
