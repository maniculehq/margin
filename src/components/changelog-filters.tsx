"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/cn"

/** Replaces the TOC rail on changelog pages. Since MDX renders Update
 * sections outside this component's React tree, filtering uses their
 * `data-update-tags` attributes. */
export function ChangelogFilters(props: { tags: string[] }) {
    // The page renders this with key={pageUrl}, so a navigation remounts it
    // with an empty selection and re-queries the new page's sections.
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
    useEffect(() => {
        const sections =
            document.querySelectorAll<HTMLElement>("[data-update-tags]")
        for (const section of sections) {
            // JSON payload, not comma-joined: a tag like "Databases,
            // Storage" must survive as ONE tag (mdx.tsx serializes).
            const raw = section.dataset.updateTags ?? "[]"
            const parsed = (() => {
                try {
                    return JSON.parse(raw)
                } catch {
                    return []
                }
            })()
            const tags = Array.isArray(parsed)
                ? parsed.filter((tag): tag is string => typeof tag === "string")
                : []
            section.hidden =
                selected.size > 0 && !tags.some((tag) => selected.has(tag))
        }
        return () => {
            for (const section of sections) section.hidden = false
        }
    }, [selected])
    if (props.tags.length === 0) return null
    return (
        <div className="sticky top-(--fd-docs-row-1) flex h-[calc(var(--fd-docs-height)-var(--fd-docs-row-1))] w-(--fd-toc-width) flex-col gap-3 pt-12 pe-4 pb-2 [grid-area:toc] max-xl:hidden">
            <p className="font-medium text-fd-muted-foreground text-sm">
                Filters
            </p>
            <div className="flex flex-wrap gap-1.5">
                {props.tags.map((tag) => {
                    const active = selected.has(tag)
                    return (
                        <button
                            key={tag}
                            type="button"
                            aria-pressed={active}
                            onClick={() =>
                                setSelected((previous) => {
                                    const next = new Set(previous)
                                    if (next.has(tag)) next.delete(tag)
                                    else next.add(tag)
                                    return next
                                })
                            }
                            className={cn(
                                "rounded-full border px-2.5 py-1 font-medium text-xs transition-colors",
                                active
                                    ? "border-fd-primary/40 bg-fd-primary/10 text-fd-primary"
                                    : "text-fd-muted-foreground hover:bg-fd-accent/50 hover:text-fd-accent-foreground",
                            )}
                        >
                            {tag}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
