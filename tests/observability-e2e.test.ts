/** Built-server journeys against a real site and a local PostHog sink.
 * Run by `bun run test:e2e`, which ingests the demo fixture. */

import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const SERVER_ENTRY = ".output/server/index.mjs"

const capturedEventSchema = z.looseObject({
    event: z.string(),
    distinct_id: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
})
const batchSchema = z.looseObject({
    batch: z.array(capturedEventSchema).default([]),
})
type CapturedEvent = z.infer<typeof capturedEventSchema>

const CLAUDEBOT_UA =
    "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
const CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
const CHROME_ACCEPT =
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

describe.skipIf(
    !existsSync(SERVER_ENTRY) ||
        !(process.env.DATABASE_URL || process.env.POSTGRES_URL),
)("agent journeys e2e", () => {
    const events: CapturedEvent[] = []
    let sink: Server
    let sinkDelayMs = 0
    let child: ChildProcess
    let baseUrl = ""

    async function waitForEvent(
        predicate: (event: CapturedEvent) => boolean,
        timeoutMs = 10_000,
    ): Promise<CapturedEvent> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const found = events.find(predicate)
            if (found) return found
            await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error(
            `no matching event; saw: ${events.map((e) => `${e.event}:${String(e.properties.$pathname ?? e.properties.tool ?? "?")}`).join(", ")}`,
        )
    }

    beforeAll(async () => {
        await promisify(execFile)(
            "bun",
            [
                "scripts/ingest.ts",
                "--dir",
                "tests/fixtures/demo",
                "--slug",
                "demo",
            ],
            {
                env: {
                    DATABASE_URL:
                        process.env.DATABASE_URL || process.env.POSTGRES_URL,
                    SITE_ORIGIN: "http://127.0.0.1",
                    PATH: process.env.PATH,
                },
            },
        )

        // 1. Fake PostHog: collect every POSTed batch (gzip-aware).
        sink = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on("data", (chunk: Buffer) => chunks.push(chunk))
            req.on("end", () => {
                const raw = Buffer.concat(chunks)
                try {
                    const body =
                        req.headers["content-encoding"] === "gzip"
                            ? gunzipSync(raw)
                            : raw
                    const parsed = batchSchema.safeParse(
                        JSON.parse(body.toString("utf8")),
                    )
                    if (parsed.success) events.push(...parsed.data.batch)
                } catch {
                    // non-batch traffic (e.g. /flags) — ignore
                }
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "application/json" })
                    res.end('{"status":"ok"}')
                }, sinkDelayMs)
            })
        })
        await new Promise<void>((resolve) =>
            sink.listen(0, "127.0.0.1", resolve),
        )
        const sinkAddress = sink.address()
        if (!sinkAddress || typeof sinkAddress === "string")
            throw new Error("sink failed to bind")

        // 2. Reserve a port for the app server.
        const probe = createServer()
        await new Promise<void>((resolve) =>
            probe.listen(0, "127.0.0.1", resolve),
        )
        const probeAddress = probe.address()
        if (!probeAddress || typeof probeAddress === "string")
            throw new Error("port probe failed")
        const appPort = probeAddress.port
        await new Promise<void>((resolve) => probe.close(() => resolve()))

        // 3. Boot the built server pointed at the sink.
        baseUrl = `http://127.0.0.1:${appPort}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                // A developer's DSN must not file local runs as production.
                SENTRY_DSN: "",
                PORT: String(appPort),
                POSTHOG_HOST: `http://127.0.0.1:${sinkAddress.port}`,
                POSTHOG_KEY: "test-key",
                SITE_SLUG: "demo",
                SITE_ORIGIN: baseUrl,
            },
            stdio: "ignore",
        })
        const deadline = Date.now() + 30_000
        for (;;) {
            try {
                const res = await fetch(`${baseUrl}/llms.txt`)
                if (res.ok) break
            } catch {
                // still booting
            }
            if (Date.now() > deadline)
                throw new Error("built server did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
    }, 60_000)

    afterAll(async () => {
        child?.kill("SIGTERM")
        await new Promise<void>((resolve) => sink.close(() => resolve()))
    })

    it("captures a ClaudeBot .md fetch as a site $pageview", async () => {
        const res = await fetch(`${baseUrl}/test.md`, {
            headers: { "user-agent": CLAUDEBOT_UA },
        })
        expect(res.status).toBe(200)

        const event = await waitForEvent(
            (e) =>
                e.event === "$pageview" &&
                e.properties.$pathname === "/test.md",
        )
        expect(event.properties.surface).toBe("docs_md")
        expect(event.properties.traffic_category).toBe("crawler")
        expect(event.properties.traffic_kind).toBe("training")
        expect(event.properties.traffic_id).toBe("claudebot")
        expect(event.properties.traffic_name).toBe("ClaudeBot")
        expect(event.properties.traffic_operator).toBe("Anthropic")
        expect(event.properties.environment).toBe("preview")
        expect(event.properties.site_id).toBe("demo")
        expect(event.properties.status).toBe(200)
        expect(typeof event.properties.duration_ms).toBe("number")
    }, 15_000)

    it("attributes a human click from an AI answer by its referring host only", async () => {
        const res = await fetch(`${baseUrl}/test`, {
            headers: {
                "user-agent": CHROME_UA,
                referer: "https://chatgpt.com/c/abc123?secret=1",
            },
        })
        expect(res.status).toBe(200)

        const event = await waitForEvent(
            (e) =>
                e.event === "$pageview" &&
                e.properties.$pathname === "/test" &&
                e.properties.ai_referral_platform === "openai",
        )
        expect(event.properties.traffic_category).toBe("human")
        expect(event.properties.ai_referral_detection).toBe("referrer")
        expect(event.properties.$referring_domain).toBe("chatgpt.com")
        expect(JSON.stringify(event.properties)).not.toContain("abc123")
    })

    it("keeps distinct_id and $session_id stable across a journey", async () => {
        await fetch(`${baseUrl}/llms-full.txt`, {
            headers: { "user-agent": CLAUDEBOT_UA },
        })
        const first = await waitForEvent(
            (e) => e.properties.$pathname === "/test.md",
        )
        const second = await waitForEvent(
            (e) => e.properties.$pathname === "/llms-full.txt",
        )
        expect(second.distinct_id).toBe(first.distinct_id)
        expect(second.properties.$session_id).toBe(first.properties.$session_id)
    }, 15_000)

    it("records the inline markdown negotiated by the llm middleware", async () => {
        const res = await fetch(`${baseUrl}/test`, {
            headers: { "user-agent": CHROME_UA, accept: "text/markdown" },
            redirect: "manual",
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/markdown")

        const event = await waitForEvent(
            (e) =>
                e.properties.$pathname === "/test" &&
                e.properties.status === 200 &&
                e.properties.markdown_negotiated === true,
        )
        expect(event.properties.surface).toBe("docs_html")
        expect(event.properties.traffic_category).toBe("agent")
        expect(event.properties.traffic_kind).toBe("unidentified")
        expect(event.properties.traffic_signal).toBe("accept")
    }, 15_000)

    it("emits mcp_tool_called alongside the api_request envelope", async () => {
        const rpc = (method: string, params: unknown, id: number) =>
            fetch(`${baseUrl}/api/mcp`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    "user-agent": CLAUDEBOT_UA,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            })
        await rpc(
            "initialize",
            {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "e2e", version: "1" },
            },
            1,
        )
        const callRes = await rpc(
            "tools/call",
            { name: "search_docs", arguments: { query: "hello" } },
            2,
        )
        expect(callRes.ok).toBe(true)

        const toolEvent = await waitForEvent(
            (e) =>
                e.event === "mcp_tool_called" &&
                e.properties.tool === "search_docs",
        )
        expect(toolEvent.properties.ok).toBe(true)
        expect(toolEvent.properties.surface).toBe("mcp")
        expect(toolEvent.properties.args).toBeUndefined() // includeInputs off
        expect(typeof toolEvent.properties.durationMs).toBe("number")

        const envelope = await waitForEvent(
            (e) =>
                e.event === "api_request" &&
                e.properties.$pathname === "/api/mcp",
        )
        expect(envelope.properties.surface).toBe("mcp")
    }, 15_000)

    it("emits agent_feedback_submitted without the message body", async () => {
        const res = await fetch(`${baseUrl}/api/agent/feedback`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": CLAUDEBOT_UA,
            },
            body: JSON.stringify({
                url: "/test",
                kind: "outdated",
                message: "The install step is stale.",
            }),
        })
        expect(res.status).toBe(202)

        const event = await waitForEvent(
            (e) => e.event === "agent_feedback_submitted",
        )
        expect(event.properties.kind).toBe("outdated")
        expect(event.properties.page_url).toBe("/test")
        expect(event.properties.page_exists).toBe(true)
        expect(event.properties.message).toBeUndefined() // includeInputs off
    }, 15_000)

    it("emits docs_searched without the query text", async () => {
        const res = await fetch(`${baseUrl}/api/search?query=install`, {
            headers: { "user-agent": CLAUDEBOT_UA },
        })
        expect(res.ok).toBe(true)

        const event = await waitForEvent((e) => e.event === "docs_searched")
        expect(event.properties.query).toBeUndefined() // includeInputs off
        expect(event.properties.surface).toBe("search")
    }, 15_000)

    it("flags browser traffic on dynamic routes as human", async () => {
        const res = await fetch(`${baseUrl}/llms.txt`, {
            headers: { "user-agent": CHROME_UA, accept: CHROME_ACCEPT },
        })
        expect(res.ok).toBe(true)

        const event = await waitForEvent(
            (e) =>
                e.properties.$pathname === "/llms.txt" &&
                e.properties.$raw_user_agent === CHROME_UA,
        )
        expect(event.properties.traffic_category).toBe("human")
        expect(event.properties.traffic_kind).toBeNull()
    }, 15_000)

    it("never blocks the response on a slow analytics sink", async () => {
        sinkDelayMs = 5_000
        try {
            const started = Date.now()
            const res = await fetch(`${baseUrl}/test.md`, {
                headers: { "user-agent": CLAUDEBOT_UA },
            })
            const elapsed = Date.now() - started
            expect(res.status).toBe(200)
            // The 5s sink delay must not appear in the response time.
            expect(elapsed).toBeLessThan(2_000)
        } finally {
            sinkDelayMs = 0
        }
    }, 15_000)
})
