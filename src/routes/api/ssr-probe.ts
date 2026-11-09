import { createFileRoute } from "@tanstack/react-router"
import { emitEvent } from "@/lib/observability"

/**
 * Deploy gate for the MDX SSR sandbox: proves the isolated-vm native addon
 * loads on this runtime and an isolate evaluates. No database, no site
 * resolution — cheap enough to poll from the sync workflow's hostname probe.
 * A failure answers with a typed code only; the native error text (addon
 * paths, dlopen details) goes to observability, never to the caller.
 */
export const Route = createFileRoute("/api/ssr-probe")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const started = performance.now()
                let body:
                    | {
                          ok: true
                          result: unknown
                          node: string
                          coldMs: number
                      }
                    | {
                          ok: false
                          code:
                              | "isolate_unavailable"
                              | "evaluation_failed"
                              | "timeout"
                          node: string
                      }
                let status = 200
                try {
                    const { default: isolatedVm } = await import("isolated-vm")
                    const isolate = new isolatedVm.Isolate({ memoryLimit: 8 })
                    try {
                        const context = await isolate.createContext()
                        const result = await context.eval("1+1", {
                            timeout: 100,
                        })
                        context.release()
                        body = {
                            ok: true,
                            result,
                            node: process.version,
                            coldMs: Math.round(performance.now() - started),
                        }
                    } finally {
                        isolate.dispose()
                    }
                } catch (error) {
                    status = 503
                    const message =
                        error instanceof Error ? error.message : String(error)
                    const code = /timed out/i.test(message)
                        ? "timeout"
                        : /isolated-vm|ERR_DLOPEN|Cannot find module/i.test(
                                message,
                            )
                          ? "isolate_unavailable"
                          : "evaluation_failed"
                    emitEvent(request, {
                        type: "ssr_probe_failed",
                        code,
                        message: message.slice(0, 500),
                        route: "/api/ssr-probe",
                    })
                    body = { ok: false, code, node: process.version }
                }
                return Response.json(body, {
                    status,
                    headers: { "Cache-Control": "no-store" },
                })
            },
        },
    },
})
