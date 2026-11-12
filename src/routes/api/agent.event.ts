import { createHash } from "node:crypto"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { extensions } from "#docs-extensions"
import type { PageViewVerdict } from "@/extensions/types"
import { agentConfig } from "@/lib/agent.config"
import { emitEvent, posthogClient } from "@/lib/observability"
import { resolveSiteVersion } from "@/lib/source"
import { surfaceOf } from "@/types/telemetry"

/** A same-site docs path: one leading slash, no scheme, no protocol-relative
 * "//", no backslash (a URL separator that can change the host), no query or
 * fragment. Senders strip `?`/`#` before posting. */
const docsPath = z
    .string()
    .max(2_000)
    .regex(/^\/(?!\/)[^\\\s?#]*$/)

/** Every browser interaction the reader-side channel accepts. Each member is
 * strict: an unknown event name or an extra prop is rejected, so nothing but
 * these allowlisted, input-free props reaches PostHog. `page_path` is the
 * docs page the interaction happened on (the request's own path is always
 * this route). */
export const browserEventSchema = z.discriminatedUnion("type", [
    // A reader's page view: once per page load and per in-site navigation
    // (routes/__root.tsx). On the first page of a visit it also carries the
    // referrer's host (only the host, as every server event keeps) and the
    // page's utm_source, which together name the AI product whose answer
    // sent the reader; both are null afterwards.
    z.strictObject({
        type: z.literal("docs_page_viewed"),
        page_path: docsPath,
        // One id per view, made in the browser: a report sent twice (the
        // beacon a slow first attempt falls back to) records one event.
        view_id: z.uuid(),
        referrer_host: z
            .string()
            .regex(/^[a-z0-9.-]{1,253}$/)
            .nullable(),
        utm_source: z
            .string()
            .regex(/^[a-z0-9._-]{1,64}$/)
            .nullable(),
    }),
    z.strictObject({
        type: z.literal("docs_search_result_clicked"),
        page_path: docsPath,
        result_position: z.int().min(1).max(500),
        result_count: z.int().min(1).max(500),
        result_type: z.enum(["page", "heading", "text"]),
        target_path: docsPath,
    }),
    z.strictObject({
        type: z.literal("open_in_ai_clicked"),
        page_path: docsPath,
        // The page-actions menu's AI destinations (view-options.tsx);
        // "custom" is any docs.json contextual option the site authored.
        target: z.enum([
            "chatgpt",
            "claude",
            "cursor",
            "t3",
            "perplexity",
            "grok",
            "aistudio",
            "devin",
            "windsurf",
            "custom",
        ]),
    }),
    z.strictObject({
        type: z.literal("page_markdown_copied"),
        page_path: docsPath,
        // The split button's left segment, the menu's Copy page row, or
        // Cmd/Ctrl+C with nothing selected.
        action: z.enum(["button", "menu", "shortcut"]),
    }),
    z.strictObject({
        type: z.literal("code_copied"),
        page_path: docsPath,
        // Shiki's language id when the block carries a language-* class;
        // null when the compiled block names no language.
        language: z
            .string()
            .regex(/^[a-z0-9][a-z0-9+#._-]{0,31}$/)
            .nullable(),
        in_code_group: z.boolean(),
    }),
    z.strictObject({
        type: z.literal("chat_citation_clicked"),
        page_path: docsPath,
        hit_position: z.int().min(1).max(100),
    }),
    z.strictObject({
        type: z.literal("webmcp_tool_called"),
        page_path: docsPath,
        tool: z.enum([
            "search_docs",
            "get_current_page_context",
            "open_documentation",
            "read_page",
            "get_site_overview",
            "read_skill",
        ]),
        ok: z.boolean(),
    }),
])

export type BrowserEvent = z.infer<typeof browserEventSchema>

/** Bodies are a few hundred bytes; anything larger is not ours. */
const MAX_BODY_BYTES = 4_096

/**
 * Reader-interaction channel. Pages send with `navigator.sendBeacon`
 * (text/plain body) or a keepalive fetch; both are same-origin, so a request
 * the browser marks cross-site is refused. Site resolution is the serving
 * path's own (an unknown production host 404s before anything is emitted),
 * and emitEvent applies the same identity, environment, and extension telemetry as
 * every server event. Answers 204 with no body either way the event lands.
 */
export async function handleBrowserEvent({
    request,
}: {
    request: Request
}): Promise<Response> {
    const fetchSite = request.headers.get("sec-fetch-site")
    if (fetchSite !== null && fetchSite !== "same-origin")
        return new Response("Forbidden", { status: 403 })
    // Refused on the declared length when there is one, and read with a
    // running byte count otherwise, so an oversized body is never buffered.
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
        return new Response("Payload Too Large", { status: 413 })
    const chunks: Uint8Array[] = []
    let received = 0
    const reader = request.body?.getReader()
    for (;;) {
        const chunk = await reader?.read()
        if (!chunk || chunk.done) break
        received += chunk.value.byteLength
        if (received > MAX_BODY_BYTES) {
            await reader?.cancel()
            return new Response("Payload Too Large", { status: 413 })
        }
        chunks.push(chunk.value)
    }
    const raw = new TextDecoder().decode(Buffer.concat(chunks))
    let body: unknown = null
    try {
        body = JSON.parse(raw)
    } catch {
        // Not JSON — fails the schema below like any other bad body.
    }
    const parsed = browserEventSchema.safeParse(body)
    if (!parsed.success)
        return Response.json(
            { error: "invalid", issues: parsed.error.issues },
            { status: 400 },
        )
    await resolveSiteVersion(request)
    if (parsed.data.type !== "docs_page_viewed") {
        emitEvent(request, {
            ...parsed.data,
            // The page's own surface (docs_html, docs_md, …), not this route's.
            surface: surfaceOf(parsed.data.page_path),
        })
        return new Response(null, { status: 204 })
    }
    // A page view is recorded as the page's own request: the page's path,
    // referrer and utm_source on this request's headers, so it carries the
    // site, path and classification a server read of the page would. The
    // extension's check reads the report as it arrived; it can only label
    // the event, and a slow or failing check records `skipped`.
    const { page_path, referrer_host, utm_source, view_id } = parsed.data
    const skipped: PageViewVerdict = { verdict: "skipped" }
    let timer: ReturnType<typeof setTimeout> | undefined
    const check =
        agentConfig.observability.enabled && extensions.pageViewCheck
            ? await Promise.race([
                  extensions
                      .resolveSite(request)
                      .catch(() => null)
                      .then((resolution) =>
                          extensions.pageViewCheck?.verify(
                              // This route has read the body, so the check
                              // gets a copy that still carries it.
                              new Request(request.url, {
                                  method: request.method,
                                  headers: request.headers,
                                  body: raw,
                              }),
                              resolution,
                              posthogClient(),
                          ),
                      )
                      .catch(() => skipped),
                  new Promise<PageViewVerdict>((resolve) => {
                      timer = setTimeout(() => resolve(skipped), 1_000)
                  }),
              ]).finally(() => clearTimeout(timer))
            : skipped
    const page = new URL(page_path, request.url)
    if (utm_source) page.searchParams.set("utm_source", utm_source)
    const headers = new Headers(request.headers)
    if (referrer_host) headers.set("referer", `https://${referrer_host}/`)
    else headers.delete("referer")
    // The event's id follows from the view's, so every attempt at one view
    // lands on one PostHog event, and a client can name no other event's id.
    const digest = createHash("sha1")
        .update(`docs_page_viewed:${view_id}`)
        .digest()
    digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
    digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
    const hex = digest.subarray(0, 16).toString("hex")
    emitEvent(new Request(page, { headers }), {
        ...check?.properties,
        uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        type: "docs_page_viewed",
        view_verdict: check?.verdict ?? "skipped",
    })
    return new Response(null, { status: 204 })
}

export const Route = createFileRoute("/api/agent/event")({
    server: { handlers: { POST: handleBrowserEvent } },
})
