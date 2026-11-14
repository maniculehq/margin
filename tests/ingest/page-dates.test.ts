/**
 * Page dates read the local clone with `git`; the budget must bound the
 * whole read, so a hung git (a huge repository, a slow network filesystem)
 * can never stall the build. A fake `git` that sleeps stands in for the hang.
 */
import { execFileSync } from "node:child_process"
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

    // A page whose `.agent.md` sibling was edited after it: agents read the
    // sibling, so the page's date is the sibling's commit.
    describe("with an agent rendition edited after its page", () => {
        const repo = mkdtempSync(join(tmpdir(), "page-dates-rendition-"))
        const commit = (file: string, iso: string) => {
            writeFileSync(join(repo, file), `${file} at ${iso}\n`)
            const env = {
                ...process.env,
                GIT_AUTHOR_DATE: iso,
                GIT_COMMITTER_DATE: iso,
            }
            const git = (...args: string[]) =>
                execFileSync(
                    "git",
                    [
                        "-c",
                        "commit.gpgsign=false",
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.com",
                        ...args,
                    ],
                    { cwd: repo, env },
                )
                    .toString()
                    .trim()
            git("add", file)
            git("commit", "-q", "-m", file)
            return git("rev-parse", "HEAD")
        }
        execFileSync("git", ["init", "-q"], { cwd: repo })
        commit("guide.mdx", "2026-01-01T00:00:00Z")
        const pageCommit = commit("guide.agent.md", "2026-02-01T00:00:00Z")
        commit("guide.agent.md", "2026-03-01T00:00:00Z")
        afterAll(() => {
            rmSync(repo, { recursive: true, force: true })
        })

        it("dates the page by its newest commit to either file", async () => {
            const result = await collectPageDates({
                dir: repo,
                paths: ["guide.mdx"],
            })
            expect(result.dates.get("guide.mdx")?.toISOString()).toBe(
                "2026-03-01T00:00:00.000Z",
            )
        })

        it("rereads a page whose sibling alone changed since the served commit", async () => {
            const result = await collectPageDates({
                dir: repo,
                paths: ["guide.mdx"],
                previousSha: pageCommit,
            })
            expect(result.dates.get("guide.mdx")?.toISOString()).toBe(
                "2026-03-01T00:00:00.000Z",
            )
        })
    })
})
