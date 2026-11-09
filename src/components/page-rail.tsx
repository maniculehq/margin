import type { ReactNode } from "react"
import { HastBody } from "@/components/hast-body"

/** Replaces the TOC rail with the ingest-split examples. `data-rail` widens
 * the desktop column; the page retains inline copies on mobile. */
export function PageRail(props: { hastJson: string; header?: ReactNode }) {
    return (
        <div
            data-rail=""
            className="sticky top-(--fd-docs-row-1) flex h-[calc(var(--fd-docs-height)-var(--fd-docs-row-1))] w-(--fd-toc-width) flex-col gap-4 overflow-y-auto pt-12 pe-4 pb-4 [grid-area:toc] max-xl:hidden [&_figure]:my-0"
        >
            {props.header}
            {/* .prose joins the rail to the same typography/tabs/table
                rules as the page body (app.css scopes them under
                :is(#nd-page, [data-rail]) .prose). */}
            <div className="prose min-w-0">
                <HastBody hastJson={props.hastJson} />
            </div>
        </div>
    )
}
