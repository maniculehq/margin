import { afterEach, beforeEach, expect, it, vi } from "vitest"

const telemetry = vi.hoisted(() => ({
    enabled: true,
    sentry: vi.fn<(timeout: number) => Promise<boolean>>(),
    env: { SENTRY_DSN: "https://test@example.test/1" },
}))

vi.mock("@sentry/tanstackstart-react", () => ({
    init: vi.fn(),
    consoleLoggingIntegration: vi.fn(),
    getClient: () => (telemetry.enabled ? { on: vi.fn() } : undefined),
    flush: telemetry.sentry,
}))
vi.mock("@/env", () => ({
    deploymentEnvironment: "test",
    env: telemetry.env,
}))

import { flushTelemetry, initSentry } from "../src/instrument-sentry"

beforeEach(() => {
    telemetry.enabled = true
    telemetry.sentry.mockReset().mockResolvedValue(true)
    initSentry()
})

afterEach(() => {
    vi.restoreAllMocks()
})

it("reports a rejected Sentry flush without an unhandled rejection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    telemetry.sentry.mockRejectedValueOnce(new Error("provider timeout"))
    await expect(flushTelemetry()).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
        "Sentry telemetry flush failed",
        expect.any(Error),
    )
})

it("reports an incomplete Sentry flush", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    telemetry.sentry.mockResolvedValueOnce(false)
    await flushTelemetry()
    expect(warning).toHaveBeenCalledWith("Sentry telemetry flush timed out")
})

it("does not report a timeout when Sentry is disabled", async () => {
    telemetry.enabled = false
    await flushTelemetry()
    expect(telemetry.sentry).not.toHaveBeenCalled()
})
