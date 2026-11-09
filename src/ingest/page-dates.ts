/**
 * Per-page Git dates for build-time ingest, read from the local clone so
 * sitemap `lastmod` and JSON-LD `dateModified` are not one identical build
 * stamp. Dates are decoration: nothing here throws. Without a usable `.git`
 * (a shallow-less tarball deploy) every page carries the previous version's
 * date forward or the head commit date, which persist already handles.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Diagnostic } from "../types/docs"

const run = promisify(execFile)

/** Wall-clock budget for all `git log` calls of one ingest. */
export const PAGE_DATES_BUDGET_MS = 60_000
const CONCURRENCY = 8

export interface DocsPageDates {
    /** Source path (relative to the docs root) → committer date. */
    dates: Map<string, Date>
    /** `freshness_partial` when some pages fell back to carried dates. */
    diagnostics: Diagnostic[]
}

/**
 * Last-commit date of each page path under `dir`. With `previousSha` (the
 * commit the served version was built from) only paths changed since then
 * are looked up; persist carries every other page's date forward. Bounded
 * by `budgetMs`; paths left unread fall back with a `freshness_partial`
 * info diagnostic.
 */
export async function collectPageDates(input: {
    dir: string
    paths: readonly string[]
    previousSha?: string | null
    budgetMs?: number
}): Promise<DocsPageDates> {
    const dates = new Map<string, Date>()
    // One deadline bounds every git call, the repository probe included:
    // each call is killed when the remaining budget runs out.
    const deadline = Date.now() + (input.budgetMs ?? PAGE_DATES_BUDGET_MS)
    let expired = false
    const git = async (args: string[]) => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            expired = true
            throw new Error("page-dates budget spent")
        }
        try {
            return (
                await run("git", args, {
                    cwd: input.dir,
                    maxBuffer: 64 << 20,
                    timeout: remaining,
                })
            ).stdout
        } catch (error) {
            if (Date.now() >= deadline) expired = true
            throw error
        }
    }
    let wanted = [...input.paths]
    try {
        await git(["rev-parse", "--is-inside-work-tree"])
    } catch {
        // No repository (the build has no history to read) unless the probe
        // itself ran out of budget.
        if (!expired) return { dates, diagnostics: [] }
        wanted = []
    }
    if (input.previousSha && !expired) {
        try {
            const changed = new Set(
                (
                    await git([
                        "diff",
                        "--name-only",
                        "--relative",
                        input.previousSha,
                        "HEAD",
                        "--",
                        ".",
                    ])
                )
                    .split("\n")
                    .filter(Boolean),
            )
            wanted = wanted.filter((path) => changed.has(path))
        } catch {
            // The previous commit is not in this clone (shallow or rewritten
            // history): read every page instead — unless the budget ran out.
            if (expired) wanted = []
        }
    }
    const queue = [...wanted]
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            for (let path = queue.shift(); path; path = queue.shift()) {
                if (expired) return
                try {
                    const iso = (
                        await git(["log", "-1", "--format=%cI", "--", path])
                    ).trim()
                    // Untracked files have no history: leave them to persist.
                    if (iso) dates.set(path, new Date(iso))
                } catch {
                    // A failed or killed read leaves the page to persist.
                }
            }
        }),
    )
    const skipped = input.paths.length - dates.size
    return {
        dates,
        diagnostics:
            expired && skipped > 0
                ? [
                      {
                          code: "freshness_partial",
                          severity: "info",
                          message: `Per-page Git dates are incomplete (the ${Math.round((input.budgetMs ?? PAGE_DATES_BUDGET_MS) / 1000)} s budget ran out); ${skipped} page(s) carry their previous or the head commit date.`,
                      },
                  ]
                : [],
    }
}
