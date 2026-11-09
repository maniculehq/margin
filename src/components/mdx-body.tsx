import { executeMdxSync } from "@fumadocs/mdx-remote/client"
import React, {
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
    useTransition,
} from "react"
import { useMDXComponents } from "@/components/mdx"

/**
 * Compiled MDX can execute site code, so `ClientOnly` keeps this fallback out
 * of server rendering with database credentials. Data-only pages use
 * `HastBody`; this path handles MDX expressions and JS/JSX snippets.
 */
export function MdxBody(props: { compiledJs: string; onReady?: () => void }) {
    const components = useMDXComponents()
    const MDX = useMemo(
        () =>
            executeMdxSync(props.compiledJs, {
                // React hooks are ambient inside Mintlify snippet components
                // (`export const Counter = () => { useState(...) }`) — the
                // ingest inlines those modules with `const { useState } =
                // opts;` preludes, so the executor's scope must carry them.
                scope: {
                    opts: {
                        useState,
                        useEffect,
                        useMemo,
                        useCallback,
                        useRef,
                        useReducer,
                        useContext,
                        useId,
                        useTransition,
                        useSyncExternalStore,
                        // Snippets also reference the namespace itself
                        // (`const { useEffect } = React`); an unbound React
                        // global would throw during render and blank the article.
                        React,
                    },
                },
            }).default,
        [props.compiledJs],
    )
    // Fires once the MDX content is committed to the DOM, before paint — the
    // signal the TOC scroll-spy re-observation waits for, and the moment
    // SandboxedBody (routes/$.tsx) removes the server snapshot, so the article
    // never paints twice.
    const { onReady } = props
    useLayoutEffect(() => {
        onReady?.()
    }, [onReady])
    return <MDX components={components} />
}
