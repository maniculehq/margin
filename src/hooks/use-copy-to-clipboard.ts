import { useCallback, useEffect, useMemo, useRef, useState } from "react"

export type CopyState = "idle" | "copied" | "failed"

/**
 * The one `navigator.clipboard.writeText` call in the framework. `copy`
 * resolves `true` on success so a caller can add its own notice; `state`
 * flips to `copied` or `failed` and back to `idle` `resetMs` after the LAST
 * copy, because the timer lives in a ref and each copy clears it before
 * re-arming. Unmount (or an Activity hide) clears it too. `reset` returns to
 * `idle` at once, for a dialog that reopens or a new value to copy.
 */
export function useCopyToClipboard(resetMs = 2_500) {
    const [state, setState] = useState<CopyState>("idle")
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

    useEffect(
        () => () => {
            clearTimeout(timer.current)
            // A hidden Activity keeps its state but loses the timer; show the
            // resting label when it comes back instead of a stuck "Copied".
            setState("idle")
        },
        [],
    )

    const reset = useCallback(() => {
        clearTimeout(timer.current)
        setState("idle")
    }, [])

    const copy = useCallback(
        async (text: string) => {
            let next: CopyState = "copied"
            try {
                await navigator.clipboard.writeText(text)
            } catch {
                next = "failed"
            }
            clearTimeout(timer.current)
            setState(next)
            timer.current = setTimeout(() => setState("idle"), resetMs)
            return next === "copied"
        },
        [resetMs],
    )

    return useMemo(() => ({ state, copy, reset }), [state, copy, reset])
}
