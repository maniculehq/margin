/**
 * Page dates read the local clone with `git`; the budget must bound the
 * whole read, so a hung git (a huge repository, a slow network filesystem)
 * can never stall the build. A fake `git` that sleeps stands in for the hang.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { collectPageDates } from "@/ingest/page-dates"

const fixture = resolve(import.meta.dirname, "../fixtures/acme")
const paths = ["index.mdx", "quickstart.mdx", "webhooks.mdx"]
const fakeBin = mkdtempSync(join(tmpdir(), "page-dates-git-"))
writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nsleep 30\n")
chmodSync(join(fakeBin, "git"), 0o755)

describe("collectPageDates", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })
    afterAll(() => {
        rmSync(fakeBin, { recursive: true, force: true })
    })

    it("dates every committed page from the clone", async () => {
        const result = await collectPageDates({ dir: fixture, paths })
        expect([...result.dates.keys()].sort()).toEqual(paths)
        expect(result.diagnostics).toEqual([])
    })

    it("stops a hung git at the budget and reports partial freshness", async () => {
        vi.stubEnv("PATH", `${fakeBin}:${process.env.PATH ?? ""}`)
        const started = Date.now()
        const result = await collectPageDates({
            dir: fixture,
            paths,
            budgetMs: 500,
        })
        // The fake git sleeps 30 s: only a killed call returns this soon.
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(result.dates.size).toBe(0)
        expect(result.diagnostics).toMatchObject([
            { code: "freshness_partial", severity: "info" },
        ])
    }, 15_000)
})
