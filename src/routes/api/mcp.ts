import { createMcpHandler } from "@modelcontextprotocol/server"
import * as Sentry from "@sentry/tanstackstart-react"
import { createFileRoute } from "@tanstack/react-router"
import { waitUntil } from "@vercel/functions"
import { flushTelemetry } from "@/instrument-sentry"
import { isSurfaceEnabled } from "@/lib/agent.config"
import { siteUrlFromRequest } from "@/lib/base-path"
import { discoveryJson, mcpWellKnown } from "@/lib/mcp-discovery"
import { buildMcpServer } from "@/lib/mcp-server"
import { resolveSiteVersion } from "@/lib/source"

// Stateless Streamable-HTTP MCP endpoint. A fresh server + transport per request
// (no session, no shared mutable state) — serverless-friendly and race-free.
export async function handleMcp(request: Request): Promise<Response> {
    if (!isSurfaceEnabled("mcp"))
        return new Response("Not Found", { status: 404 })

    // Resolved before the SDK runs: a host naming no site must 404
    // (start.ts), and the SDK answers anything a tool throws with a 500.
    const head = await resolveSiteVersion(request)

    // A plain GET (a browser, curl, an agent probing the URL it was given)
    // gets the server's description and how to connect, instead of the
    // SDK's bare 405 — only an SSE-capable MCP client asks for the stream.
    if (
        request.method === "GET" &&
        !(request.headers.get("accept") ?? "").includes("text/event-stream")
    ) {
        const siteUrl = siteUrlFromRequest(request)
        return discoveryJson(request, {
            ...mcpWellKnown(head, siteUrl),
            connect: {
                claudeCode: `claude mcp add --transport http ${head.site.slug}-docs ${siteUrl}/api/mcp`,
                codex: `[mcp_servers.${head.site.slug}-docs]\nurl = "${siteUrl}/api/mcp"`,
                cursor: {
                    mcpServers: {
                        [`${head.site.slug}-docs`]: {
                            url: `${siteUrl}/api/mcp`,
                        },
                    },
                },
                vscode: {
                    servers: {
                        [`${head.site.slug}-docs`]: {
                            type: "http",
                            url: `${siteUrl}/api/mcp`,
                        },
                    },
                },
            },
        })
    }

    // The SDK reports every failure to `onerror` as a plain Error — including
    // malformed client requests it then answers with a 4xx (wrong Accept
    // header, missing `_meta` envelope). Only the response status tells them
    // apart, so hold errors raised before the response exists and report them
    // unless the transport rejected the request as a client error. Errors
    // after the response (mid-stream) are always server-side.
    let pending: Error[] | null = []
    const handler = createMcpHandler(() => buildMcpServer(request), {
        // Public docs keep older agents working without server-side sessions.
        legacy: "stateless",
        onerror: (error) => {
            if (pending) {
                pending.push(error)
                return
            }
            Sentry.captureException(error)
            waitUntil(flushTelemetry())
        },
    })
    let status: number | undefined
    try {
        const response = await handler.fetch(request)
        status = response.status
        return response
    } finally {
        const held = pending
        pending = null
        if (status === undefined || status < 400 || status >= 500) {
            for (const error of held) Sentry.captureException(error)
            if (held.length > 0) waitUntil(flushTelemetry())
        }
        await handler.close()
    }
}

export const Route = createFileRoute("/api/mcp")({
    server: {
        handlers: {
            POST: ({ request }) => handleMcp(request),
            GET: ({ request }) => handleMcp(request),
            DELETE: ({ request }) => handleMcp(request),
        },
    },
})
