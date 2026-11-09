import { McpServer } from "@modelcontextprotocol/server"
import { beforeEach, expect, it, vi } from "vitest"

// The MCP SDK reports client-protocol rejections and real server failures to
// the same `onerror`; only the response status separates them. These run the
// real transport so an SDK change in either signal shows up here.
const telemetry = vi.hoisted(() => ({
    capture: vi.fn<(error: unknown) => void>(),
    flush: vi.fn<() => Promise<void>>(),
    waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
    buildServer: vi.fn<() => Promise<unknown>>(),
}))

vi.mock("@sentry/tanstackstart-react", () => ({
    captureException: telemetry.capture,
}))
vi.mock("@vercel/functions", () => ({ waitUntil: telemetry.waitUntil }))
vi.mock("@/instrument-sentry", () => ({ flushTelemetry: telemetry.flush }))
vi.mock("@/lib/agent.config", () => ({ isSurfaceEnabled: () => true }))
vi.mock("@/lib/mcp-server", () => ({ buildMcpServer: telemetry.buildServer }))

import { handleMcp } from "../src/routes/api/mcp"

const listTools = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
})

beforeEach(() => {
    telemetry.capture.mockReset()
    telemetry.waitUntil.mockReset()
    telemetry.flush.mockReset().mockResolvedValue(undefined)
    telemetry.buildServer
        .mockReset()
        .mockImplementation(
            async () => new McpServer({ name: "docs", version: "1" }),
        )
})

it("drops errors for requests the transport rejects with a 4xx", async () => {
    // A modern protocol header without the required `_meta` claim.
    // The SDK reports it to onerror, then answers 400.
    const response = await handleMcp(
        new Request("https://docs.test.invalid/api/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2026-07-28",
            },
            body: listTools,
        }),
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(telemetry.capture).not.toHaveBeenCalled()
    expect(telemetry.waitUntil).not.toHaveBeenCalled()
})

it("captures and flushes server failures answered with a 5xx", async () => {
    telemetry.buildServer.mockRejectedValueOnce(new Error("database down"))
    const response = await handleMcp(
        new Request("https://docs.test.invalid/api/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: listTools,
        }),
    )
    expect(response.status).toBe(500)
    expect(telemetry.capture).toHaveBeenCalledWith(
        expect.objectContaining({ message: "database down" }),
    )
    expect(telemetry.waitUntil).toHaveBeenCalledOnce()
})
