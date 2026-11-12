import { useTheme } from "next-themes"
import { useEffect, useId, useRef, useState } from "react"

/**
 * Mermaid renderer for ```mermaid fences (converted to <Mermaid chart> at
 * ingest by fumadocs-core's remarkMdxMermaid). The mermaid library is
 * imported lazily so diagram-free pages never pay for the chunk. SSR-safe by
 * construction: the server renders only the empty container div (SSR hast
 * bodies mount this component during SSR); the diagram itself always renders
 * in the browser inside the effect.
 */
export function Mermaid({ chart }: { chart?: string }) {
    const id = useId()
    const containerRef = useRef<HTMLDivElement>(null)
    const { resolvedTheme } = useTheme()
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        const container = containerRef.current
        if (!container || !chart) return
        let cancelled = false
        // Renders run one at a time: they share one mermaid id. At most one
        // render waits behind the running one, and it draws whatever width
        // is latest when it starts — a resize burst during the lazy import
        // or a render never replays the superseded widths.
        let queue = Promise.resolve()
        let renderedWidth = -1
        let pendingWidth: number | null = null
        const draw = (width: number) => {
            renderedWidth = width
            const queued = pendingWidth !== null
            pendingWidth = width
            if (queued) return
            queue = queue.then(async () => {
                const latest = pendingWidth
                pendingWidth = null
                if (cancelled || latest === null) return
                try {
                    const { default: mermaid } = await import("mermaid")
                    mermaid.initialize({
                        startOnLoad: false,
                        securityLevel: "strict",
                        theme: resolvedTheme === "dark" ? "dark" : "default",
                        // Gantt sizes its SVG from the width of mermaid's
                        // scratch render node (appended to <body>, so the
                        // viewport), then useMaxWidth scales it into the
                        // column: labels landed at 5px. Lay it out at the
                        // column's own width instead.
                        gantt: { useWidth: latest || undefined },
                    })
                    const { svg } = await mermaid.render(
                        // useId ids contain characters mermaid rejects in DOM ids.
                        `mermaid-${id.replace(/[^a-zA-Z0-9]/g, "")}`,
                        chart,
                    )
                    if (!cancelled) container.innerHTML = svg
                } catch {
                    if (!cancelled) setFailed(true)
                }
            })
        }
        // Only gantt depends on the container's width. A hidden container
        // (an inactive force-mounted Tab, a closed Accordion) measures 0, so
        // a gantt waits for a real width and re-lays out when it changes.
        if (!/^\s*gantt\b/m.test(chart)) {
            draw(container.clientWidth)
            return () => {
                cancelled = true
            }
        }
        const observer = new ResizeObserver(() => {
            const width = container.clientWidth
            if (width > 0 && width !== renderedWidth) draw(width)
        })
        observer.observe(container)
        return () => {
            cancelled = true
            observer.disconnect()
        }
    }, [chart, id, resolvedTheme])

    if (!chart) return null
    if (failed) {
        // Fall back to the readable source rather than an empty box.
        return (
            <pre className="my-4 overflow-x-auto rounded-xl border bg-fd-card p-4 text-sm">
                <code>{chart}</code>
            </pre>
        )
    }
    return (
        <div
            ref={containerRef}
            data-component-name="mermaid-container"
            className="mermaid my-4 flex justify-center"
        />
    )
}
