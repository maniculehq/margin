import { type ReactNode, useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { withBase } from "@/lib/base-path"
import { useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import type { LayoutConfig } from "@/lib/source"
import { isAllowedUrl } from "@/types/docs-shared"

/**
 * "Was this page helpful?" row between the article and prev/next (parity
 * §C3): thumbs POST to the existing /api/agent/feedback endpoint; edit and
 * issue links derive from the site's repo binding.
 */
export function PageFeedback(props: {
    pageUrl: string
    /** docs.json feedback.thumbsRating — hides the Yes/No row when false. */
    thumbsRating: boolean
    editUrl: string | null
    issueUrl: string | null
}) {
    const strings = useChromeStrings()
    const [voted, setVoted] = useState<"helpful" | "not_helpful" | null>(null)
    const vote = (kind: "helpful" | "not_helpful") => {
        setVoted(kind)
        // Best-effort — the widget thanks optimistically either way.
        void fetch(withBase("/api/agent/feedback"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: props.pageUrl,
                kind,
                source: "page_widget",
            }),
        }).catch(() => {})
    }
    return (
        // Rhythm: a wide clear gap separates the article from the
        // feedback row. A divider would compete with the controls.
        <div
            data-page-feedback=""
            className="mt-16 flex flex-wrap items-center gap-2 text-fd-muted-foreground text-sm"
        >
            {!props.thumbsRating ? null : voted ? (
                <span>{strings.thanksFeedback}</span>
            ) : (
                <>
                    <span>{strings.wasHelpful}</span>
                    <button
                        type="button"
                        onClick={() => vote("helpful")}
                        className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                            className: "gap-1.5 rounded-full bg-fd-background",
                        })}
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
                            <title>Helpful</title>
                            <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
                        </svg>
                        {strings.yes}
                    </button>
                    <button
                        type="button"
                        onClick={() => vote("not_helpful")}
                        className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                            className: "gap-1.5 rounded-full bg-fd-background",
                        })}
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
                            <title>Not helpful</title>
                            <path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
                        </svg>
                        {strings.no}
                    </button>
                </>
            )}
            <span className="ms-auto flex items-center gap-2">
                {props.editUrl ? (
                    <a
                        href={props.editUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                            className: "gap-1.5 rounded-full bg-fd-background",
                        })}
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
                            <title>Suggest edits</title>
                            <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                            <path d="m15 5 4 4" />
                        </svg>
                        {strings.suggestEdits}
                    </a>
                ) : null}
                {props.issueUrl ? (
                    <a
                        href={props.issueUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                            className: "gap-1.5 rounded-full bg-fd-background",
                        })}
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
                            <title>Raise issue</title>
                            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                            <path d="M12 9v4" />
                            <path d="M12 17h.01" />
                        </svg>
                        {strings.raiseIssue}
                    </a>
                ) : null}
            </span>
        </div>
    )
}

// Brand glyphs (simple-icons paths) for the docs.json footer.socials keys.
const SOCIAL_ICONS: Record<string, ReactNode> = {
    x: (
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    ),
    twitter: (
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    ),
    github: (
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    ),
    discord: (
        <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    ),
    youtube: (
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    ),
    linkedin: (
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    ),
    // Simple globe for the docs.json `website` social entry (it
    // rendered as the literal text "website").
    website: (
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm7.938 8h-3.294a15.6 15.6 0 0 0-1.6-4.508A10.03 10.03 0 0 1 19.938 8zM12 2.05c.98 1.18 2.023 3.03 2.593 5.95H9.407c.57-2.92 1.613-4.77 2.593-5.95zM2.462 14a10.06 10.06 0 0 1 0-4h3.823a22.5 22.5 0 0 0 0 4H2.462zm1.6 2h3.294a15.6 15.6 0 0 0 1.6 4.508A10.03 10.03 0 0 1 4.062 16zm3.294-8H4.062a10.03 10.03 0 0 1 4.894-4.508A15.6 15.6 0 0 0 7.356 8zM12 21.95c-.98-1.18-2.023-3.03-2.593-5.95h5.186c-.57 2.92-1.613 4.77-2.593 5.95zM14.85 14h-5.7a20.7 20.7 0 0 1 0-4h5.7a20.7 20.7 0 0 1 0 4zm.194 6.508A15.6 15.6 0 0 0 16.644 16h3.294a10.03 10.03 0 0 1-4.894 4.508zM17.715 14a22.5 22.5 0 0 0 0-4h3.823a10.06 10.06 0 0 1 0 4h-3.823z" />
    ),
}

/**
 * docs.json footer.socials → icon row after prev/next. Accepts
 * both docs.json shapes: a platform→URL record and an entry array.
 */
export function FooterSocials(props: {
    socials: NonNullable<LayoutConfig["footer"]>["socials"]
}) {
    const entries = Array.isArray(props.socials)
        ? props.socials.flatMap((social) =>
              social.type || social.label
                  ? [
                        {
                            type: (social.type ?? social.label ?? "")
                                .toLowerCase()
                                .trim(),
                            href: social.href,
                        },
                    ]
                  : [],
          )
        : Object.entries(props.socials ?? {}).map(([type, href]) => ({
              type: type.toLowerCase().trim(),
              href,
          }))
    const links = entries.filter((entry) => isAllowedUrl(entry.href))
    if (links.length === 0) return null
    return (
        // Left-aligned with open air above the end-of-page controls —
        // no divider (see PageFeedback).
        <div className="mt-10 flex items-center gap-5">
            {links.map((entry) => (
                <a
                    key={entry.href}
                    href={entry.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={entry.type}
                    className={cn(
                        "text-fd-muted-foreground transition-colors hover:text-fd-accent-foreground",
                    )}
                >
                    {/* Unknown platforms get the globe, never raw text. */}
                    <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="size-4.5"
                        role="img"
                        aria-hidden
                    >
                        <title>{entry.type}</title>
                        {SOCIAL_ICONS[entry.type] ?? SOCIAL_ICONS.website}
                    </svg>
                </a>
            ))}
        </div>
    )
}
