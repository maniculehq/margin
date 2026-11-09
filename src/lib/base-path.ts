import type { AsyncLocalStorage } from "node:async_hooks"
import { createIsomorphicFn, createServerOnlyFn } from "@tanstack/react-start"
import { createContext, use } from "react"
import { originFromRequest } from "./shared"

/**
 * A site's base path: "" when it serves at the domain root, or a path such
 * as "/docs" when it serves under a path of its owner's domain, behind their
 * proxy (`SiteResolution.basePath`). Stored content, routes and loaders all
 * speak root-relative paths: server.ts strips the base path from each
 * request before routing, and the router adds it to every href it builds
 * (router.tsx), its own redirects included. Everything else the framework
 * emits goes through this module: in particular every `redirect({ href })`
 * and `Location` header a handler writes names its public target with
 * `withBase`, since nothing downstream can tell an internal path that
 * happens to start with the base path from a public one.
 *
 * - `withBase(path, base?)`: client and server. Prefixes a root-relative
 *   path: "/x" → "/docs/x", "/" → "/docs", "/?q=1" → "/docs?q=1". Anything
 *   else (an absolute or protocol-relative URL, "#frag", "?q", "mailto:…",
 *   a relative "x") comes back unchanged. Apply it once, to internal paths:
 *   under "/docs", "/docs/x" names the internal page /docs/x and becomes
 *   "/docs/docs/x". `base` defaults to `basePath()`; pass one captured
 *   earlier where the request scope may be gone (the router's rewrites).
 * - `basePath()`: client and server. The base path itself. The server reads
 *   the request's scope (below); the browser reads `<html data-base-path>`,
 *   which routes/__root.tsx renders from the same value.
 * - `stripBase(pathname, base)`: pure. "/docs/x" → "/x", "/docs" → "/",
 *   null when the pathname is outside the base path.
 * - `siteUrlFromRequest(request)`: server only. The absolute URL of the
 *   site's root, with no trailing slash: the public origin (else the
 *   request's) plus the base path, e.g. "https://acme.com/docs". Join a path
 *   onto it (`${siteUrlFromRequest(request)}/llms.txt`) for every absolute
 *   URL a response carries. `originFromRequest` stays the bare request
 *   origin, for the CSRF check.
 * - `siteUrlOf(siteUrl, path)`: pure. The absolute URL of an internal path,
 *   spelled the way the router links it: "https://acme.com/docs" + "/x" →
 *   "https://acme.com/docs/x", and the site root is the bare base
 *   ("https://acme.com/docs"; "https://acme.com/" at the domain root). For
 *   URLs that name a page (canonical, hreflang, sitemap); a plain
 *   `${siteUrl}/file` join is fine for any other path.
 * - `withBaseInMarkdown(markdown, base)`: pure. Prefixes the root-relative
 *   link and image destinations of stored markdown (`](/x)`, `[ref]: /x`,
 *   `src="/x"`, `href="/x"`) outside code, fenced code inside blockquotes
 *   and list items included, for the agent surfaces that serve it. Stored
 *   markdown stays unprefixed.
 * - `BasePathContext` / `useBasePath()`: components that also render in the
 *   SSR isolate (src/sandbox/render.tsx), which has no request scope and no
 *   document, read the base path through this context; unprovided, it falls
 *   back to `basePath()`.
 * - `siteScope()`: server only. The AsyncLocalStorage server.ts fills with
 *   the resolved site's `{ basePath, publicOrigin, sharedClientAddress }`
 *   for the request; the public rate limiters read the last. Never a request
 *   header, which a client could set.
 */

export interface SiteScope {
    basePath: string
    publicOrigin: string | null
    /** SiteResolution.sharedClientAddress: per-site rate limits only. */
    sharedClientAddress: boolean
}

// Created on first use on the server. Loaded at run time rather than
// imported: the client build strips every server-only body here, but the SSR
// isolate's bundle (src/sandbox/bundle-plugin.ts) has no TanStack compiler
// and no Node built-ins, and it imports this module through mdx.tsx.
let storage: AsyncLocalStorage<SiteScope> | undefined
export const siteScope = createServerOnlyFn(
    () =>
        (storage ??= new (process.getBuiltinModule(
            "node:async_hooks",
        ).AsyncLocalStorage)<SiteScope>()),
)

export const basePath = createIsomorphicFn()
    .server(() => siteScope().getStore()?.basePath ?? "")
    .client(() => document.documentElement.dataset.basePath ?? "")

export function withBase(path: string, base: string = basePath()): string {
    if (!base || !path.startsWith("/") || path.startsWith("//")) return path
    // The site root is the bare base path: "/docs", not "/docs/".
    return /^\/(?:[?#]|$)/.test(path)
        ? `${base}${path.slice(1)}`
        : `${base}${path}`
}

export function stripBase(pathname: string, base: string): string | null {
    if (!base) return pathname
    if (pathname === base) return "/"
    return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
}

export function siteUrlOf(siteUrl: string, path: string): string {
    const base = new URL(siteUrl).pathname.replace(/\/+$/, "")
    return `${siteUrl.slice(0, siteUrl.length - base.length)}${withBase(path, base)}`
}

export const siteUrlFromRequest = createServerOnlyFn((request: Request) => {
    const scope = siteScope().getStore()
    return `${scope?.publicOrigin ?? originFromRequest(request)}${scope?.basePath ?? ""}`
})

export const BasePathContext = createContext<string | null>(null)

export function useBasePath(): string {
    return use(BasePathContext) ?? basePath()
}

// A destination that starts with one "/" (not "//" or "/\\", which name
// another host), up to where the destination ends.
const ROOT_RELATIVE = String.raw`\/(?![/\\])[^\s)"'>]*`
// Each destination form names its lead and destination groups; inline code
// matches neither and is left alone.
const MARKDOWN_DESTINATION = new RegExp(
    [
        // Inline code.
        "(?<ticks>`+)[\\s\\S]*?\\k<ticks>",
        // [text](/x) and ![alt](/x), angle-bracketed or not.
        String.raw`(?<linkLead>\]\(\s*<?)(?<link>${ROOT_RELATIVE})`,
        // src="/x", href='/x' in inline HTML.
        String.raw`(?<htmlLead>\b(?:src|href)\s*=\s*["'])(?<html>${ROOT_RELATIVE})`,
        // [ref]: /x
        String.raw`(?<refLead>^ {0,3}\[[^\]]+\]:\s*<?)(?<ref>${ROOT_RELATIVE})`,
    ].join("|"),
    "g",
)

// The blockquote markers, list markers and indentation a line's content
// sits behind: a fence opens and closes after them.
const CONTAINER_PREFIX =
    /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/

export function withBaseInMarkdown(markdown: string, base: string): string {
    if (!base) return markdown
    // The open fence, with how many blockquotes deep it opened.
    let fence: { marker: string; quotes: number } | null = null
    return markdown
        .split("\n")
        .map((line) => {
            const container = CONTAINER_PREFIX.exec(line)?.[0] ?? ""
            const quotes = container.split(">").length - 1
            const content = line.slice(container.length)
            const marker = /^(`{3,}|~{3,})/.exec(content)?.[1]
            // A fence ends with the blockquote that holds it (a fence's
            // lines are never lazy continuations).
            if (fence !== null && quotes < fence.quotes) fence = null
            if (fence !== null) {
                // A closing fence: the same character, at least as long,
                // and nothing else on the line.
                if (
                    marker?.[0] === fence.marker[0] &&
                    marker.length >= fence.marker.length &&
                    content.trim() === marker
                )
                    fence = null
                return line
            }
            if (marker) {
                fence = { marker, quotes }
                return line
            }
            let prefixed = ""
            let from = 0
            for (const match of line.matchAll(MARKDOWN_DESTINATION)) {
                const groups = match.groups ?? {}
                const lead =
                    groups.linkLead ?? groups.htmlLead ?? groups.refLead
                const destination = groups.link ?? groups.html ?? groups.ref
                if (lead === undefined || destination === undefined) continue
                prefixed += `${line.slice(from, match.index)}${lead}${withBase(destination, base)}`
                from = match.index + match[0].length
            }
            return `${prefixed}${line.slice(from)}`
        })
        .join("\n")
}
