/**
 * Entry of the SSR sandbox bundle (built by sandboxRenderBundle in
 * src/sandbox/bundle-plugin.ts into ONE self-contained IIFE and evaluated
 * inside an isolated-vm V8 isolate by src/lib/sandbox-render.ts).
 *
 * Nothing here may reach for a host object: the isolate has no `process`,
 * `require`, `fetch`, timers, DOM, or `URL`. The compiled site MDX runs
 * through the exact scope MdxBody (routes/$.tsx) hands executeMdxSync in the
 * browser, so the server snapshot and the hydrated article are the same
 * component tree.
 */
import { executeMdxSync } from "@fumadocs/mdx-remote/client"
import { FrameworkProvider } from "fumadocs-core/framework"
import type { ComponentProps } from "react"
import * as React from "react"
import {
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
    useTransition,
} from "react"
import { renderToString } from "react-dom/server"
import { ArticleImages, getMDXComponents } from "@/components/mdx"
import {
    type VariationOption,
    VariationsProvider,
} from "@/components/view-group"
import { BasePathContext, withBase } from "@/lib/base-path"
import { ChromeLocaleContext } from "@/lib/chrome-strings"

/**
 * What crosses back to the host. The length check happens here, before the
 * string is copied out of the isolate: a site expression such as
 * `"x".repeat(50_000_000)` stays inside the isolate's heap cap and only the
 * small `oversized` record leaves it.
 */
export type SandboxRenderOutput =
    | { kind: "html"; html: string }
    | { kind: "oversized"; length: number }

declare global {
    var __renderMdx: (
        compiledJs: string,
        pageUrl: string,
        maxHtmlLength: number,
        variations: readonly VariationOption[] | null,
        locale: string | null,
        basePath: string,
    ) => SandboxRenderOutput
}

const components = getMDXComponents()

// The router hooks fumadocs components may call. Navigation is meaningless in
// a string render; the pathname is the page being rendered so active-link
// styling matches what the browser computes after hydration.
const router = { push: () => undefined, refresh: () => undefined }
const params: Record<string, string> = {}

type LinkProps = ComponentProps<"a"> & { prefetch?: boolean }

globalThis.__renderMdx = (
    compiledJs: string,
    pageUrl: string,
    maxHtmlLength: number,
    variations: readonly VariationOption[] | null,
    locale: string | null,
    basePath: string,
): SandboxRenderOutput => {
    const MDX = executeMdxSync(compiledJs, {
        // Mirror of MdxBody's scope: hooks are ambient inside inlined
        // snippet components (`const { useState } = opts;` preludes) and some
        // snippets read them off the React namespace.
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
                React,
            },
        },
    }).default
    // Same VariationsProvider the route wraps the page in: the snapshot
    // must show the configured default view of every ViewGroup, not its
    // first authored one, or hydration would swap views. The provider's
    // localStorage read lives in an effect — effects never run in
    // renderToString — so the server always sees the first option.
    const html = renderToString(
        <FrameworkProvider
            usePathname={() => pageUrl}
            useRouter={() => router}
            useParams={() => params}
            // The browser's links go through the router, which adds the
            // site's base path; there is no router here.
            Link={({ href, prefetch: _prefetch, ...props }: LinkProps) => (
                <a
                    {...props}
                    href={
                        href === undefined
                            ? undefined
                            : withBase(href, basePath)
                    }
                />
            )}
        >
            {/* The root route provides the page's locale and base path to
                the same components in the browser; there is no router or
                request scope here. */}
            <BasePathContext value={basePath}>
                <ChromeLocaleContext value={locale}>
                    <VariationsProvider options={variations}>
                        {/* Same image counter the route wraps DocsBody in:
                        the snapshot's first image is the likely LCP and must
                        load eagerly with high priority, like the hydrated
                        tree. */}
                        <ArticleImages>
                            <MDX components={components} />
                        </ArticleImages>
                    </VariationsProvider>
                </ChromeLocaleContext>
            </BasePathContext>
        </FrameworkProvider>,
    )
    if (html.length > maxHtmlLength)
        return { kind: "oversized", length: html.length }
    return { kind: "html", html }
}
