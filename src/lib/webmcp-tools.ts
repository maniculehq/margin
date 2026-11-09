import { captureException } from "@sentry/tanstackstart-react"
import type {} from "webmcp-types"
import { object } from "zod/mini"

// Imported only by the tool modules `loadWebmcpTools` (./webmcp) loads, so
// browsers without WebMCP never download it.

// Shared by every WebMCP tool that takes no input. The JSON Schema is spelled
// out (what classic z.toJSONSchema(z.object({})) produced) rather than
// generated, and handlers validate with zod/mini: toJSONSchema and the
// classic API ship a ~400 KB chunk to every page that registers a tool.
export const NO_INPUT_JSON_SCHEMA = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    additionalProperties: false,
}

/** The registered schema is advisory — schema-invalid arguments still reach
 *  execute in Chromium — so handlers re-validate with this. */
export const noInputSchema = object({})

declare global {
    namespace WebMCP {
        interface ModelContext {
            /** Older origin-trial Chromium (150): `registerTool` is
             *  synchronous, ignores `options.signal`, and tools come off
             *  only through this. Missing from webmcp-types. */
            unregisterTool?(name: string): void
        }
    }
}

/** Register a WebMCP tool, and unregister it when `options.signal` aborts
 *  (unmount or navigation). A signal already aborted while the tools chunk
 *  loaded registers nothing. Two API shapes ship:
 *  - Current: `registerTool` returns a promise and the signal unregisters.
 *    An `AbortError` rejection is the signal firing and means nothing.
 *  - Older origin trial (Chrome 150): `registerTool` returns undefined or
 *    throws synchronously and ignores the signal, so the abort calls
 *    `unregisterTool` — otherwise the next mount throws
 *    `InvalidStateError: Duplicate tool name`.
 *  Any other failure is a bug, logged with the tool name and sent to Sentry
 *  when a client is initialised (`captureException` is a no-op otherwise). */
export function registerWebmcpTool<const TInputSchema extends object>(
    tool: WebMCP.ModelContextToolFromSchema<TInputSchema>,
    options: WebMCP.ModelContextRegisterToolOptions & { signal: AbortSignal },
) {
    const modelContext = document.modelContext
    if (!modelContext || options.signal.aborted) return
    const report = (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        console.error("WebMCP: registering a tool failed:", tool.name, error)
        captureException(error, { tags: { webmcpTool: tool.name } })
    }
    try {
        const registration = modelContext.registerTool(tool, options)
        if (registration instanceof Promise) {
            registration.catch(report)
            return
        }
    } catch (error) {
        report(error)
        return
    }
    options.signal.addEventListener(
        "abort",
        () => {
            try {
                modelContext.unregisterTool?.(tool.name)
            } catch (error) {
                report(error)
            }
        },
        { once: true },
    )
}
