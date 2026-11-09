"use client"

import { useLocation } from "@tanstack/react-router"
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react"

/**
 * Shared open-state for the API playground: the endpoint bar
 * under the H1 (routes/$.tsx DocContent) opens the same modal the
 * lazily-loaded console (components/api-page.tsx TryIt) renders. Context,
 * not DOM events — the console mounts client-side after hydration and both
 * surfaces need the current state to render their button/dialog
 * affordances. `endpoint` names the operation the bar controls, so other
 * operations on a composed page keep their own trigger.
 */
const ApiPlaygroundContext = createContext<{
    open: boolean
    setOpen: (open: boolean) => void
    endpoint: { method: string; path: string } | null
} | null>(null)

export function ApiPlaygroundProvider(props: {
    endpoint: { method: string; path: string } | null
    children: ReactNode
}) {
    // Client navigation between API pages REUSES this provider, so the
    // state is owned by the pathname it was set on: another page reads as
    // closed until its own deep link or button opens it.
    const pathname = useLocation({ select: (location) => location.pathname })
    const searchStr = useLocation({
        select: (location) => location.searchStr,
    })
    const [state, setState] = useState({ pathname, open: false })
    const open = state.pathname === pathname && state.open
    const setOpen = useCallback(
        (next: boolean) => setState({ pathname, open: next }),
        [pathname],
    )
    // Deep link: `?playground=open` lands with the modal open —
    // on first load and on every navigation. Read after hydration: the
    // server render never shows the dialog.
    useEffect(() => {
        setState({
            pathname,
            open: new URLSearchParams(searchStr).get("playground") === "open",
        })
    }, [pathname, searchStr])
    const endpoint = props.endpoint
    const value = useMemo(
        () => ({ open, setOpen, endpoint }),
        [open, setOpen, endpoint],
    )
    return (
        <ApiPlaygroundContext.Provider value={value}>
            {props.children}
        </ApiPlaygroundContext.Provider>
    )
}

/** Null outside a provider — TryIt falls back to local state. */
export function useApiPlayground() {
    return useContext(ApiPlaygroundContext)
}
