"use client"
import { usePathname } from "fumadocs-core/framework"
import { buttonVariants } from "fumadocs-ui/components/ui/button"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "fumadocs-ui/components/ui/popover"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { array, minLength, object, optional, string, union } from "zod/mini"
import {
    ChevronDownIcon,
    ExternalLinkIcon,
    TextIcon,
} from "@/components/chrome-icons"
import { toast } from "@/components/ui/toast"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { withBase } from "@/lib/base-path"
import { useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import { docsIconNode } from "@/lib/docs-icon"
import type { BrowserEvent } from "@/routes/api/agent.event"
import { isAllowedUrl } from "@/types/docs-shared"

type PageActionItem = {
    key: string
    title: string
    sub: string
    icon: ReactNode
} & (
    | { href: string }
    | { copy: string }
    | { action: true }
    /** $page templates: the href needs the page markdown, fetched on click. */
    | { resolveHref: (markdown: string) => string }
)

/**
 * docs.json custom contextual option: `{title, description, href, icon|src}`,
 * where href is a URL template (string or {base, query}) with $page/$path/
 * $mcp substitution values — $page is the page's MARKDOWN CONTENT (per the
 * docs.json contextual-menu contract), not its URL.
 */
const customOptionSchema = object({
    title: string().check(minLength(1)),
    description: optional(string()),
    icon: optional(string()),
    /** Image icon (ingest-hashed /_assets path or allow-listed URL). */
    src: optional(string().check(minLength(1))),
    href: union([
        string().check(minLength(1)),
        object({
            base: string().check(minLength(1)),
            query: optional(array(object({ key: string(), value: string() }))),
        }),
    ]),
})

const OPENAI_ICON = (
    <svg
        role="img"
        viewBox="0 0 24 24"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
    >
        <title>OpenAI</title>
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
)

const ANTHROPIC_ICON = (
    <svg
        fill="currentColor"
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
    >
        <title>Anthropic</title>
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
)

const CURSOR_ICON = (
    <svg
        fill="currentColor"
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
    >
        <title>Cursor</title>
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
)

const T3_ICON = (
    <svg
        fill="currentColor"
        role="img"
        viewBox="0 0 258 199"
        xmlns="http://www.w3.org/2000/svg"
    >
        <title>T3 Chat</title>
        <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M165.735 25.0701L188.947 0.972412H0.465994V25.0701H165.735Z"
        />
        <path d="M163.981 96.3239L254.022 3.68314L221.206 3.68295L145.617 80.7609L163.981 96.3239Z" />
        <path d="M233.658 131.418C233.658 155.075 214.48 174.254 190.823 174.254C171.715 174.254 155.513 161.738 150 144.439L146.625 133.848L127.329 153.143L129.092 157.336C139.215 181.421 163.034 198.354 190.823 198.354C227.791 198.354 257.759 168.386 257.759 131.418C257.759 106.937 244.399 85.7396 224.956 74.0905L220.395 71.3582L202.727 89.2528L210.788 93.5083C224.403 100.696 233.658 114.981 233.658 131.418Z" />
        <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M88.2625 192.669L88.2626 45.6459H64.1648L64.1648 192.669H88.2625Z"
        />
    </svg>
)

const COPY_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
)

const SERVER_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <title>Connect MCP server</title>
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
        <line x1="6" x2="6.01" y1="6" y2="6" />
        <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
)

const PERPLEXITY_ICON = (
    <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>Perplexity</title>
        <path d="M12 1.5 5.25 7.06V1.5H3.75v5.72H1.5v9.56h2.25v5.72h1.5v-5.56L12 22.5v-5.72h2.25v5.16h1.5v-5.16h6.75V7.22h-2.25V1.5h-1.5v5.56L12 1.5zm-1.5 8.28v6.44l-5.25 4.33v-6.35l5.25-4.42zm3 0 5.25 4.42v6.35l-5.25-4.33V9.78zM3 8.72h6.42L3 14.13V8.72zm11.58 0H21v5.41l-6.42-5.41z" />
    </svg>
)

// Grok's wordmark isn't in the committed icon set — a neutral spark glyph
// stands in (same treatment as the other stroke icons here).
const GROK_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <title>Grok</title>
        <path d="M4 4l16 16" />
        <path d="M20 4L4 20" />
        <circle cx="12" cy="12" r="9" />
    </svg>
)

// Google's AI four-point spark — the Gemini/AI Studio brand mark.
const AISTUDIO_ICON = (
    <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>Google AI Studio</title>
        <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
)

// Cognition's mark isn't in the committed icon set — a neutral bot glyph.
const DEVIN_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <title>Devin</title>
        <rect width="18" height="12" x="3" y="8" rx="2" />
        <path d="M12 8V4" />
        <circle cx="12" cy="3" r="1" />
        <line x1="8" x2="8.01" y1="13" y2="13" />
        <line x1="16" x2="16.01" y1="13" y2="13" />
    </svg>
)

const GITHUB_ICON = (
    <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>GitHub</title>
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
)

const TEXT_FALLBACK_ICON = <TextIcon />

const DOWNLOAD_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <title>Download OpenAPI spec</title>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
)

// lucide file-down: a page glyph with a download arrow (neighbor of
// DOWNLOAD_ICON's tray-arrow used by download-spec).
const PDF_ICON = (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <title>Download PDF</title>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M12 18v-6" />
        <path d="m9 15 3 3 3-3" />
    </svg>
)

const VSCODE_ICON = (
    <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>VS Code</title>
        <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
)

/** docs.json contextual.options rendered as menu entries, in config order. */
const DEFAULT_OPTIONS = ["copy", "view", "chatgpt", "claude", "cursor", "t3"]

/** Menu keys that hand the page to an AI product, as the analytics target
 * they report (`devin-desktop` is the `windsurf` entry under its alias).
 * Site-authored custom options report as "custom". */
const AI_TARGETS: Record<
    string,
    Extract<BrowserEvent, { type: "open_in_ai_clicked" }>["target"]
> = {
    chatgpt: "chatgpt",
    claude: "claude",
    cursor: "cursor",
    t3: "t3",
    perplexity: "perplexity",
    grok: "grok",
    aistudio: "aistudio",
    devin: "devin",
    windsurf: "windsurf",
    "devin-desktop": "windsurf",
}

/**
 * "Copy page ▾" split button at the title's right (plan
 * §B3): the left segment copies the page markdown; the chevron opens a menu
 * whose entries follow docs.json contextual.options (default set when
 * absent). Unknown option ids are skipped so new docs.json options degrade
 * gracefully.
 */
export function PageActions(props: {
    markdownUrl: string
    /** contextual.options — id strings and/or custom option objects. */
    options?: readonly unknown[]
    /** Source-of-this-page link on GitHub (repo-bound sites). */
    githubUrl?: string | null
    /** Spec download route — API-reference pages only. */
    specUrl?: string | null
    /** Per-page PDF export route ({page}.pdf) — download-pdf option. */
    pdfUrl?: string | null
    className?: string
}) {
    const pathname = usePathname()
    const strings = useChromeStrings()
    // Which entry the last copy came from; the hook owns when it resets.
    const [copiedKey, setCopiedKey] = useState<string | null>(null)
    const clipboard = useCopyToClipboard(2_000)
    const copied = clipboard.state === "copied" ? copiedKey : null
    // "Copied" only shows once the clipboard write lands. A failed markdown
    // fetch and a rejected write (Safari drops the user activation across
    // the fetch) toast separately, so the reader knows which to retry.
    // `copied` is reported only once the clipboard write lands.
    const copyText = (
        key: string,
        text: string | Promise<string>,
        copied?: BrowserEvent,
    ) => {
        void Promise.resolve(text).then(
            async (value) => {
                setCopiedKey(key)
                if (!(await clipboard.copy(value))) {
                    toast.add({ title: strings.copyFailed, type: "error" })
                    return
                }
                if (!copied) return
                const beacon = JSON.stringify(copied)
                if (!navigator.sendBeacon(withBase("/api/agent/event"), beacon))
                    void fetch(withBase("/api/agent/event"), {
                        method: "POST",
                        body: beacon,
                        keepalive: true,
                    }).catch(() => {})
            },
            () => toast.add({ title: strings.pageLoadFailed, type: "error" }),
        )
    }
    // The raw .md keeps the agent-signals comment and the machine
    // "Related:" preamble (they're FOR agents); human-facing consumers
    // (clipboard copies, $page substitutions) start at the title.
    const fetchPageMarkdown = () =>
        fetch(props.markdownUrl)
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.text()
            })
            .then((text) =>
                text
                    // The optional YAML frontmatter and the "Documentation
                    // Index" preamble open the raw .md for agents too.
                    .replace(/^---\n[\s\S]*?\n---\n\n/, "")
                    .replace(/^(?:>.*\n)+\n/, "")
                    .replace(/^<!--\s*agent-signals:[^>]*-->\s*\n?/m, "")
                    .replace(/^Related:[^\n]*\n?/m, ""),
            )
    // Cmd/Ctrl+C with nothing selected copies the page as markdown. A
    // selection, or focus in anything editable, keeps the
    // browser's own copy. The ref keeps the window listener on the latest
    // render's handlers without re-subscribing every render.
    const shortcut = useRef<() => void>(() => {})
    shortcut.current = () =>
        copyText("copy", fetchPageMarkdown(), {
            type: "page_markdown_copied",
            page_path: pathname,
            action: "shortcut",
        })
    const menuDisabled =
        props.options !== undefined && props.options.length === 0
    useEffect(() => {
        if (menuDisabled) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                !(event.metaKey || event.ctrlKey) ||
                event.shiftKey ||
                event.altKey ||
                event.key.toLowerCase() !== "c"
            )
                return
            const selection = window.getSelection()
            if (selection && !selection.isCollapsed) return
            const target = event.target
            if (
                target instanceof HTMLElement &&
                (target.isContentEditable ||
                    target.closest("input, textarea, select"))
            )
                return
            event.preventDefault()
            shortcut.current()
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [menuDisabled])

    // $page hrefs open a window synchronously (popup blockers) and point it
    // at the resolved URL once the markdown arrives.
    const openWithPageMarkdown = (
        buildTarget: (markdown: string) => string,
    ) => {
        const win = window.open("", "_blank")
        if (win) win.opener = null
        void fetchPageMarkdown()
            .then((markdown) => {
                const target = buildTarget(markdown)
                if (win) win.location.href = target
            })
            .catch(() => {
                win?.close()
                toast.add({ title: strings.pageLoadFailed, type: "error" })
            })
    }

    const items = useMemo(() => {
        const origin =
            typeof window === "undefined" ? "" : window.location.origin
        // `pathname` is the router's: the public URLs carry the base path.
        const pageUrl =
            typeof window === "undefined"
                ? withBase(pathname)
                : String(new URL(withBase(pathname), origin))
        const q = `Read ${pageUrl}, I want to ask questions about it.`
        const mcpUrl = `${origin}${withBase("/api/mcp")}`
        const options = props.options?.length ? props.options : DEFAULT_OPTIONS
        const catalog: Record<
            string,
            | { title: string; sub: string; icon: ReactNode; href: string }
            | { title: string; sub: string; icon: ReactNode; copy: string }
            | { title: string; sub: string; icon: ReactNode; action: true }
            | null
        > = {
            // The primary action repeats as the first menu row.
            copy: {
                title: strings.copyPage,
                sub: strings.copyPageMarkdown,
                icon: COPY_ICON,
                action: true,
            },
            view: {
                title: "View as Markdown",
                sub: "View this page as plain text",
                icon: <TextIcon />,
                href: props.markdownUrl,
            },
            chatgpt: {
                title: strings.openInChatGPT,
                sub: "Ask questions about this page",
                icon: OPENAI_ICON,
                href: `https://chatgpt.com/?${new URLSearchParams({ prompt: q, hints: "search" })}`,
            },
            claude: {
                title: strings.openInClaude,
                sub: "Ask questions about this page",
                icon: ANTHROPIC_ICON,
                href: `https://claude.ai/new?${new URLSearchParams({ q })}`,
            },
            cursor: {
                title: "Connect to Cursor",
                sub: "Ask questions about this page",
                icon: CURSOR_ICON,
                href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: q })}`,
            },
            t3: {
                title: "Open in T3 Chat",
                sub: "Ask questions about this page",
                icon: T3_ICON,
                href: `https://t3.chat/new?${new URLSearchParams({ q, search: "true" })}`,
            },
            perplexity: {
                title: "Open in Perplexity",
                sub: "Ask questions about this page",
                icon: PERPLEXITY_ICON,
                href: `https://www.perplexity.ai/search?${new URLSearchParams({ q })}`,
            },
            grok: {
                title: "Open in Grok",
                sub: "Ask questions about this page",
                icon: GROK_ICON,
                href: `https://grok.com/?${new URLSearchParams({ q })}`,
            },
            aistudio: {
                title: "Open in AI Studio",
                sub: "Ask questions about this page",
                icon: AISTUDIO_ICON,
                href: `https://aistudio.google.com/prompts/new_chat?${new URLSearchParams({ prompt: q })}`,
            },
            devin: {
                title: "Open in Devin",
                sub: "Ask Devin about this page",
                icon: DEVIN_ICON,
                href: `https://app.devin.ai/?${new URLSearchParams({ prompt: q })}`,
            },
            // The docs.json "windsurf" id opens Devin Desktop (Windsurf joined
            // Cognition); the deep link is inert without the app installed.
            windsurf: {
                title: "Open in Devin Desktop",
                sub: "Ask questions about this page",
                icon: DEVIN_ICON,
                href: `devin://cascade?${new URLSearchParams({ prompt: q })}`,
            },
            "devin-mcp": {
                title: "Install MCP in Devin",
                sub: "Connect your AI tools to these docs",
                icon: DEVIN_ICON,
                href: `https://app.devin.ai/settings/mcp-marketplace/setup/custom?config=${encodeURIComponent(
                    btoa(
                        JSON.stringify([
                            { name: "docs", transport: "HTTP", url: mcpUrl },
                        ]),
                    ),
                )}`,
            },
            "download-spec": props.specUrl
                ? {
                      title: "Download OpenAPI spec",
                      sub: "Download the API specification",
                      icon: DOWNLOAD_ICON,
                      href: props.specUrl,
                  }
                : null,
            "download-pdf": props.pdfUrl
                ? {
                      title: "Download PDF",
                      sub: "Download this page as a PDF",
                      icon: PDF_ICON,
                      href: props.pdfUrl,
                  }
                : null,
            github: props.githubUrl
                ? {
                      title: "Open in GitHub",
                      sub: "View the source of this page",
                      icon: GITHUB_ICON,
                      href: props.githubUrl,
                  }
                : null,
            mcp: {
                title: strings.connectMcp,
                sub: "Connect your AI tools to these docs",
                icon: SERVER_ICON,
                copy: mcpUrl,
            },
            vscode: {
                title: "Install MCP in VS Code",
                sub: "Connect your AI tools to these docs",
                icon: VSCODE_ICON,
                href: `vscode:mcp/install?${encodeURIComponent(
                    JSON.stringify({ name: "docs", type: "http", url: mcpUrl }),
                )}`,
            },
        }
        // docs.json option aliases that map onto an existing entry.
        catalog["add-mcp"] = catalog.mcp ?? null
        catalog["devin-desktop"] = catalog.windsurf ?? null
        return options.flatMap((option, index): PageActionItem[] => {
            if (typeof option === "string") {
                const item = catalog[option]
                return item ? [{ key: option, ...item }] : []
            }
            const custom = customOptionSchema.safeParse(option)
            if (!custom.success) return []
            const template = custom.data.href
            // docs.json contract: $page substitutes the page's MARKDOWN
            // CONTENT. In query values URLSearchParams encodes it; in a
            // string template it's percent-encoded here.
            const buildHref = (pageMarkdown: string) => {
                const substitute = (value: string, encodePage: boolean) =>
                    value
                        .replaceAll(
                            "$page",
                            encodePage
                                ? encodeURIComponent(pageMarkdown)
                                : pageMarkdown,
                        )
                        .replaceAll("$path", withBase(pathname))
                        .replaceAll("$mcp", mcpUrl)
                return typeof template === "string"
                    ? substitute(template, true)
                    : `${substitute(template.base, true)}${
                          template.query?.length
                              ? `?${new URLSearchParams(
                                    template.query.map((entry) => [
                                        entry.key,
                                        substitute(entry.value, false),
                                    ]),
                                )}`
                              : ""
                      }`
            }
            // Scheme/host validity can't be changed by percent-encoded
            // content, so an empty-content probe validates the template.
            if (!isAllowedUrl(buildHref(""))) return []
            const usesPageContent =
                typeof template === "string"
                    ? template.includes("$page")
                    : template.base.includes("$page") ||
                      (template.query ?? []).some((entry) =>
                          entry.value.includes("$page"),
                      )
            const src = custom.data.src
            const icon =
                src && /^(\/|https?:\/\/)/i.test(src) ? (
                    // biome-ignore lint/performance/noImgElement: site icon assets are served from the docs asset store, not next/image
                    <img
                        key={src}
                        src={withBase(src)}
                        alt=""
                        className="size-4 rounded-sm object-contain"
                    />
                ) : (
                    (docsIconNode(custom.data.icon, {
                        className: "inline-flex size-4 [&>svg]:size-full",
                    }) ?? TEXT_FALLBACK_ICON)
                )
            return [
                {
                    key: `custom-${index}`,
                    title: custom.data.title,
                    sub: custom.data.description ?? "",
                    icon,
                    ...(usesPageContent
                        ? { resolveHref: buildHref }
                        : { href: buildHref("") }),
                },
            ]
        })
    }, [
        props.markdownUrl,
        props.options,
        props.githubUrl,
        props.specUrl,
        props.pdfUrl,
        pathname,
        strings,
    ])

    // docs.json: an explicit empty options list disables the whole menu
    // (page-level `contextual.options: []`). After the hooks — React rules.
    if (props.options !== undefined && props.options.length === 0) return null

    return (
        <div
            className={cn(
                "inline-flex shrink-0 items-stretch overflow-hidden rounded-lg border text-sm",
                props.className,
            )}
        >
            <button
                type="button"
                aria-label={strings.copyPage}
                onClick={() => {
                    copyText("copy", fetchPageMarkdown(), {
                        type: "page_markdown_copied",
                        page_path: pathname,
                        action: "button",
                    })
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground [&_svg]:size-3.5"
            >
                {COPY_ICON}
                {copied === "copy" ? strings.copied : strings.copyPage}
            </button>
            <Popover>
                <PopoverTrigger
                    aria-label="Page actions"
                    aria-haspopup="menu"
                    className={cn(
                        buttonVariants({ color: "ghost" }),
                        "rounded-none border-s p-1.5 data-[state=open]:bg-fd-accent data-[state=open]:text-fd-accent-foreground",
                    )}
                >
                    <ChevronDownIcon className="size-3.5 text-fd-muted-foreground" />
                </PopoverTrigger>
                <PopoverContent
                    align="end"
                    role="menu"
                    className="flex w-72 flex-col"
                >
                    {items.map((item) => {
                        const aiTarget = item.key.startsWith("custom-")
                            ? "custom"
                            : AI_TARGETS[item.key]
                        // Fired on the click that opens the AI product; the
                        // page itself never rides along, only the target.
                        const reportAiOpen = () => {
                            if (!aiTarget) return
                            const beacon = JSON.stringify({
                                type: "open_in_ai_clicked",
                                page_path: pathname,
                                target: aiTarget,
                            } satisfies BrowserEvent)
                            if (
                                !navigator.sendBeacon(
                                    withBase("/api/agent/event"),
                                    beacon,
                                )
                            )
                                void fetch(withBase("/api/agent/event"), {
                                    method: "POST",
                                    body: beacon,
                                    keepalive: true,
                                }).catch(() => {})
                        }
                        const body = (
                            <>
                                <span className="mt-0.5 shrink-0 [&_svg]:size-4">
                                    {item.icon}
                                </span>
                                <span className="flex min-w-0 flex-col">
                                    <span className="font-medium">
                                        {copied === item.key
                                            ? strings.copied
                                            : item.title}
                                    </span>
                                    <span className="text-fd-muted-foreground text-xs">
                                        {item.sub}
                                    </span>
                                </span>
                            </>
                        )
                        if ("href" in item)
                            return (
                                <a
                                    key={item.key}
                                    role="menuitem"
                                    href={item.href}
                                    rel="noreferrer noopener"
                                    // Every navigation opens a NEW tab —
                                    // including View as Markdown, whose raw
                                    // text would otherwise replace the app
                                    // while the row shows a new-tab icon.
                                    target="_blank"
                                    onClick={reportAiOpen}
                                    className="inline-flex items-start gap-2.5 rounded-lg p-2 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
                                >
                                    {body}
                                    <ExternalLinkIcon className="ms-auto size-3.5 shrink-0 text-fd-muted-foreground" />
                                </a>
                            )
                        if ("resolveHref" in item)
                            return (
                                <button
                                    key={item.key}
                                    role="menuitem"
                                    type="button"
                                    onClick={() => {
                                        openWithPageMarkdown(item.resolveHref)
                                        reportAiOpen()
                                    }}
                                    className="inline-flex items-start gap-2.5 rounded-lg p-2 text-start text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
                                >
                                    {body}
                                    <ExternalLinkIcon className="ms-auto size-3.5 shrink-0 text-fd-muted-foreground" />
                                </button>
                            )
                        return (
                            <button
                                key={item.key}
                                role="menuitem"
                                type="button"
                                onClick={() => {
                                    if ("copy" in item) {
                                        copyText(item.key, item.copy)
                                        return
                                    }
                                    copyText("copy", fetchPageMarkdown(), {
                                        type: "page_markdown_copied",
                                        page_path: pathname,
                                        action: "menu",
                                    })
                                }}
                                className="inline-flex items-start gap-2.5 rounded-lg p-2 text-start text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
                            >
                                {body}
                            </button>
                        )
                    })}
                </PopoverContent>
            </Popover>
        </div>
    )
}
