import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { emitEvent } from "@/lib/observability"
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
    emitEvent(request, {
        ...parsed.data,
        // The page's own surface (docs_html, docs_md, …), not this route's.
        surface: surfaceOf(parsed.data.page_path),
    })
    return new Response(null, { status: 204 })
}

export const Route = createFileRoute("/api/agent/event")({
    server: { handlers: { POST: handleBrowserEvent } },
})
