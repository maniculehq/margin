import { createHash } from "node:crypto"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server"
import { z } from "zod"
import { agentConfig } from "./agent.config"
import { MCP_PROMPT_NAMES, MCP_TOOL_NAMES, mcpInstructions } from "./mcp-server"
import type { DocsHead } from "./source"

/** The MCP Server Card media type (SEP-2127, io.modelcontextprotocol/server-card). */
export const SERVER_CARD_TYPE = "application/mcp-server-card+json"

const SERVER_CARD_SCHEMA =
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"

/**
 * The standard server card: identity and how to connect, never the tool
 * list (the spec leaves primitives to live discovery). `name` follows the
 * spec's `<namespace>/<name>` shape with the serving host as the namespace,
 * so every domain names its own server.
 */
export function mcpServerCard(head: DocsHead, origin: string) {
    const host = new URL(origin).host.replace(/[^a-zA-Z0-9.-]/g, "-")
    return {
        $schema: SERVER_CARD_SCHEMA,
        name: `${host}/docs`,
        version: agentConfig.discovery.version,
        title: `${head.identity.name} docs`.slice(0, 100),
        description:
            `Search and read the ${head.identity.name} documentation.`.slice(
                0,
                100,
            ),
        websiteUrl: origin,
        remotes: [
            {
                type: "streamable-http",
                url: `${origin}/api/mcp`,
                supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            },
        ],
    }
}

const toolListSchema = z.object({
    result: z.object({
        tools: z.array(
            z.looseObject({
                name: z.string(),
                title: z.string().optional(),
                description: z.string().optional(),
                inputSchema: z.unknown(),
                outputSchema: z.unknown().optional(),
                annotations: z.unknown().optional(),
            }),
        ),
    }),
})

/**
 * The live `tools/list` answer, asked of the real handler in-process so the
 * cards that embed tool schemas can never drift from what the server serves.
 */
async function liveTools(request: Request, origin: string) {
    const { handleMcp } = await import("@/routes/api/mcp")
    const response = await handleMcp(
        new Request(`${origin}/api/mcp`, {
            method: "POST",
            headers: {
                host: request.headers.get("host") ?? new URL(origin).host,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-06-18",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        }),
    )
    const text = await response.text()
    // The handler may answer as SSE; the JSON-RPC message is the data line.
    const payload =
        text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length) ?? text
    return toolListSchema.parse(JSON.parse(payload)).result.tools
}

/**
 * The card shape Mintlify-hosted sites publish at
 * `/.well-known/mcp/server-card.json`: the standard fields plus capabilities
 * and full tool definitions, for clients built against that earlier draft.
 */
export async function compatServerCard(
    request: Request,
    head: DocsHead,
    origin: string,
) {
    return {
        ...mcpServerCard(head, origin),
        url: `${origin}/api/mcp`,
        transport: "streamable-http",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        authentication: { type: "none" },
        tools: await liveTools(request, origin),
        prompts: MCP_PROMPT_NAMES,
    }
}

/** `/.well-known/mcp.json` and `/.well-known/mcp`: where the server is, in
 * the shape Mintlify sites publish, plus the tool names and instructions. */
export function mcpWellKnown(head: DocsHead, origin: string) {
    const url = `${origin}/api/mcp`
    return {
        name: `${head.identity.name} docs`,
        version: agentConfig.discovery.version,
        transport: "streamable-http",
        url,
        serverCard: `${url}/server-card`,
        servers: [
            {
                name: "public",
                url,
                transport: "streamable-http",
                authentication: "none",
            },
        ],
        tools: MCP_TOOL_NAMES,
        prompts: MCP_PROMPT_NAMES,
        instructions: mcpInstructions(head, origin),
    }
}

const DISCOVERY_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
}

/** The CORS preflight a browser sends before a conditional (If-None-Match)
 * discovery GET — a GET/304's own headers can't authorize it. */
export function discoveryPreflight(): Response {
    return new Response(null, {
        status: 204,
        headers: { ...DISCOVERY_CORS, "Access-Control-Max-Age": "86400" },
    })
}

/** A JSON discovery response: shared cache policy, open CORS (discovery
 * documents are public and fetched cross-origin), a content ETag, and a
 * 304 for a matching If-None-Match. */
export function discoveryJson(
    request: Request,
    body: unknown,
    contentType = "application/json",
): Response {
    const text = JSON.stringify(body, null, 2)
    const etag = `"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`
    const headers = {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Cache-Control": agentConfig.cache.header,
        ...DISCOVERY_CORS,
        ETag: etag,
    }
    if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers })
    return new Response(text, { headers })
}
