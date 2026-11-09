/**
 * `bun run vercel-build`: the deploy build. Resolves the content version
 * ONCE — DOCS_CONTENT_SHA, else VERCEL_GIT_COMMIT_SHA, else `git rev-parse
 * HEAD`, else `dev-<unix ms>` (the order scripts/ingest.ts uses) — and runs
 * every step with that value as DOCS_CONTENT_SHA, so the ingest writes and
 * the Vite build bakes the same version even without git metadata:
 *
 *   icons:build → db:migrate → vite build → bundle budget → ingest
 *
 * Stops at the first failing step with its exit code: a docs tree that fails
 * validation never deploys. Ingest runs last because a production ingest
 * advances the site's current pointer and collects old versions, protecting
 * the version that pointer named before it. That pointer must only ever name
 * a deployment whose build succeeded: if ingest ran first and the server
 * build then failed, the next build would protect the failed one and could
 * collect the version production still serves. The server build reads no
 * content (prerendering is off), only the DOCS_CONTENT_SHA it bakes.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

let sha = process.env.DOCS_CONTENT_SHA || process.env.VERCEL_GIT_COMMIT_SHA
if (!sha) {
    try {
        sha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
    } catch {
        // Not a git checkout (a source upload): fall through to dev-<ms>.
    }
}
sha ||= `dev-${Date.now()}`
console.log(`[vercel-build] content version ${sha}`)

const env = { ...process.env, DOCS_CONTENT_SHA: sha }
const steps = [
    ["scripts/build-icon-map.ts"],
    ["scripts/db-migrate.ts"],
    ["x", "vite", "build"],
    ["x", "vitest", "run", "tests/bundle-budget.test.ts"],
    ["scripts/ingest.ts"],
]
for (const args of steps) {
    const step = spawnSync(process.execPath, args, {
        cwd: root,
        env,
        stdio: "inherit",
    })
    if (step.status !== 0) {
        console.error(
            `[vercel-build] \`bun ${args.join(" ")}\` failed${step.error ? `: ${step.error.message}` : ""}`,
        )
        process.exit(step.status ?? 1)
    }
}
