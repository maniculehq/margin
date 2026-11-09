/** Optional integrations must not be required to serve an ingested site. */
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { GENERATOR_NAME } from "@/lib/shared"

const root = resolve(import.meta.dirname, "../..")
const entry = resolve(root, ".output/server/index.mjs")
const databaseUrl = process.env.DATABASE_URL
const run = promisify(execFile)

describe.skipIf(!existsSync(entry) || !databaseUrl)(
    "zero optional environment",
    () => {
        const children: ChildProcess[] = []
        let sink: Server | undefined
        let sinkRequests = 0
        let sinkUrl = ""
        let origin = ""
        let telemetryOrigin = ""
        let sentrySink: Server | undefined
        let sentrySinkUrl = ""
        let sentryControlOrigin = ""
        const sentryEnvelopes: { path: string; body: string }[] = []

        beforeAll(async () => {
            sink = createServer((_request, response) => {
                sinkRequests += 1
                response.writeHead(200, { "content-type": "application/json" })
                response.end('{"status":"ok"}')
            })
            await new Promise<void>((done) =>
                sink?.listen(0, "127.0.0.1", done),
            )
            const sinkAddress = z
                .object({ port: z.number() })
                .parse(sink.address())
            sinkUrl = `http://127.0.0.1:${sinkAddress.port}`

            sentrySink = createServer(async (request, response) => {
                const chunks: Buffer[] = []
                for await (const chunk of request) chunks.push(chunk)
                sentryEnvelopes.push({
                    path: request.url ?? "",
                    body: Buffer.concat(chunks).toString(),
                })
                response.writeHead(200, { "content-type": "application/json" })
                response.end("{}")
            })
            await new Promise<void>((done) =>
                sentrySink?.listen(0, "127.0.0.1", done),
            )
            const sentryAddress = z
                .object({ port: z.number() })
                .parse(sentrySink.address())
            sentrySinkUrl = `http://127.0.0.1:${sentryAddress.port}`

            const requiredEnv = {
                DATABASE_URL: databaseUrl,
                SITE_ORIGIN: "http://127.0.0.1",
            }
            await run(
                "bun",
                [
                    "scripts/ingest.ts",
                    "--dir",
                    "tests/fixtures/bare",
                    "--sha",
                    `zero-env-${process.pid}-${Date.now()}`,
                ],
                {
                    cwd: root,
                    env: { ...requiredEnv, PATH: process.env.PATH },
                },
            )

            // The first server has exactly the required application env. The
            // second adds only the observation transport: an accidental default
            // PostHog key must send to our counter rather than the public endpoint.
            // A third server proves that the real SDK sends envelopes to the
            // sink when configured. It is stopped before observing the
            // zero-env server so every subsequent envelope is unexpected.
            for (const mode of ["required", "posthog", "sentry-control"]) {
                const probe = createServer()
                await new Promise<void>((done) =>
                    probe.listen(0, "127.0.0.1", done),
                )
                const { port } = z
                    .object({ port: z.number() })
                    .parse(probe.address())
                await new Promise<void>((done) => probe.close(() => done()))
                const baseUrl = `http://127.0.0.1:${port}`
                const child = spawn(process.execPath, [entry], {
                    cwd: root,
                    env: {
                        DATABASE_URL: databaseUrl,
                        SITE_ORIGIN: baseUrl,
                        // Listener settings are transport, not application config.
                        PORT: String(port),
                        HOST: "127.0.0.1",
                        ...(mode === "posthog"
                            ? { POSTHOG_HOST: sinkUrl }
                            : {}),
                        ...(mode === "sentry-control"
                            ? {
                                  SENTRY_DSN: `${sentrySinkUrl.replace("http://", "http://public@")}/1`,
                                  SENTRY_ENVIRONMENT: "test",
                              }
                            : {}),
                    },
                    stdio: "ignore",
                })
                children.push(child)
                const deadline = Date.now() + 30_000
                for (;;) {
                    try {
                        // Listener readiness must not swallow a route regression:
                        // status/content are asserted by the tests themselves.
                        await fetch(`${baseUrl}/llms.txt`)
                        break
                    } catch {
                        // The listener has not started yet.
                    }
                    if (child.exitCode !== null || Date.now() > deadline)
                        throw new Error(
                            "zero-env built server did not become ready",
                        )
                    await new Promise((done) => setTimeout(done, 100))
                }
                if (mode === "posthog") telemetryOrigin = baseUrl
                else if (mode === "sentry-control")
                    sentryControlOrigin = baseUrl
                else origin = baseUrl
            }
        }, 120_000)

        afterAll(async () => {
            await Promise.all(
                children.map(
                    (child) =>
                        new Promise<void>((done) => {
                            if (child.exitCode !== null) return done()
                            const timeout = setTimeout(
                                () => child.kill("SIGKILL"),
                                1_000,
                            )
                            child.once("exit", () => {
                                clearTimeout(timeout)
                                done()
                            })
                            child.kill("SIGTERM")
                        }),
                ),
            )
            await new Promise<void>((done) =>
                sink ? sink.close(() => done()) : done(),
            )
            await new Promise<void>((done) =>
                sentrySink ? sentrySink.close(() => done()) : done(),
            )
        })

        it.each(["/", "/llms.txt"])(
            "serves %s with only the required application env",
            async (path) => {
                const response = await fetch(`${origin}${path}`)
                expect(response.status).toBe(200)
                expect(await response.text()).toContain("Getting Started")
            },
        )

        it("explains that the assistant is not configured", async () => {
            const response = await fetch(`${origin}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ messages: [] }),
            })
            expect(response.status).toBe(503)
            expect(response.headers.get("content-type")).toContain(
                "application/json",
            )
            expect(
                z
                    .object({
                        error: z.literal("assistant_not_configured"),
                        message: z.string(),
                    })
                    .parse(await response.json()).message,
            ).toMatch(/assistant.*not configured/i)
        })

        it("uses the public generator name", async () => {
            const response = await fetch(`${origin}/`)
            expect(response.status).toBe(200)
            const html = await response.text()
            expect(html).toContain(
                `name="generator" content="${GENERATOR_NAME}"`,
            )
        })

        it.each([
            { path: "/", status: 200 },
            { path: "/llms.txt", status: 200 },
            { path: "/api/chat", status: 503 },
        ])(
            "does not attach tracing headers to $path",
            async ({ path, status }) => {
                const response = await fetch(
                    `${origin}${path}`,
                    path === "/api/chat" ? { method: "POST" } : {},
                )
                expect(response.status).toBe(status)
                expect(response.headers.get("sentry-trace")).toBeNull()
                expect(response.headers.get("baggage")).toBeNull()
            },
        )

        it("sends no Sentry envelopes without a DSN after proving SDK capture", async () => {
            // The positive control uses the SDK's full test-environment
            // sampling. The negative check counts every envelope, including
            // client reports from traces dropped by production sampling.
            const init = {
                method: "POST",
                headers: {
                    "sentry-trace":
                        "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
                },
            }
            const control = await fetch(`${sentryControlOrigin}/api/chat`, init)
            expect(control.status).toBe(503)
            await expect
                .poll(
                    () =>
                        sentryEnvelopes.filter(
                            ({ path, body }) =>
                                path.startsWith("/api/1/envelope/") &&
                                /"type":"(?:span|transaction|event)"/.test(
                                    body,
                                ),
                        ).length,
                )
                .toBeGreaterThan(0)
            const sentryControl = children.pop()
            if (!sentryControl) throw new Error("Sentry control server missing")
            await new Promise<void>((done) => {
                const timeout = setTimeout(
                    () => sentryControl.kill("SIGKILL"),
                    1_000,
                )
                sentryControl.once("exit", () => {
                    clearTimeout(timeout)
                    done()
                })
                sentryControl.kill("SIGTERM")
            })
            sentryEnvelopes.length = 0
            const response = await fetch(`${origin}/api/chat`, init)
            expect(response.status).toBe(503)
            // Allow the SDK's deferred span drain and transport to complete.
            await new Promise((done) => setTimeout(done, 2_000))
            expect(sentryEnvelopes).toHaveLength(0)
        })

        it("sends no PostHog telemetry after twenty browser page loads to a proven sink", async () => {
            const beforeControl = sinkRequests
            const control = await fetch(`${sinkUrl}/positive-control`)
            expect(control.status).toBe(200)
            expect(sinkRequests).toBe(beforeControl + 1)
            sinkRequests = 0
            const browser = await chromium.launch({ chromiumSandbox: false })
            try {
                const page = await browser.newPage()
                const statuses: number[] = []
                for (let load = 0; load < 20; load += 1) {
                    const response = await page.goto(`${telemetryOrigin}/`, {
                        waitUntil: "networkidle",
                    })
                    statuses.push(response?.status() ?? 0)
                }
                expect(statuses).toEqual(Array.from({ length: 20 }, () => 200))
                expect(await page.locator("article").innerText()).toContain(
                    "Getting Started",
                )
                await page.waitForTimeout(1_000)
            } finally {
                await browser.close()
            }
            expect(sinkRequests).toBe(0)
        }, 60_000)
    },
)
