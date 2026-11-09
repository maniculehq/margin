/** A production host that names no site answers a plain 404 document from
 * the built server, never the 500 a root component reading absent loader
 * data used to throw. Run by `bun run test:e2e`, which builds the server
 * and provisions the database; no fixture is seeded under SITE_SLUG. */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const SERVER_ENTRY = ".output/server/index.mjs"

describe.skipIf(
    !existsSync(SERVER_ENTRY) ||
        !(process.env.DATABASE_URL || process.env.POSTGRES_URL),
)("unknown host", () => {
    let child: ChildProcess
    let baseUrl = ""

    beforeAll(async () => {
        const probe = createServer()
        await new Promise<void>((resolve) =>
            probe.listen(0, "127.0.0.1", resolve),
        )
        const address = probe.address()
        if (!address || typeof address === "string")
            throw new Error("port probe failed")
        const port = address.port
        await new Promise<void>((resolve) => probe.close(() => resolve()))

        baseUrl = `http://127.0.0.1:${port}`
        child = spawn("node", [SERVER_ENTRY], {
            env: {
                ...process.env,
                PORT: String(port),
                // No docs_site row carries this slug, so the built-in
                // extension resolves no site, the way an unattached domain
                // or a deployment URL does on the hosted platform.
                SITE_SLUG: "unclaimed-site",
                SITE_ORIGIN: baseUrl,
                VERCEL_ENV: "production",
                DOCS_CANONICAL_REDIRECT: "0",
                SENTRY_DSN: "",
            },
            stdio: "ignore",
        })
        const deadline = Date.now() + 30_000
        for (;;) {
            try {
                await fetch(`${baseUrl}/robots.txt`)
                break
            } catch {
                // still booting
            }
            if (Date.now() > deadline)
                throw new Error("built server did not become ready")
            await new Promise((r) => setTimeout(r, 250))
        }
    }, 60_000)

    afterAll(() => {
        child?.kill("SIGTERM")
    })

    it("answers the document request with a 404 page", async () => {
        const res = await fetch(`${baseUrl}/`, {
            headers: { accept: "text/html" },
        })
        const body = await res.text()

        expect(res.status).toBe(404)
        expect(res.headers.get("content-type")).toContain("text/html")
        expect(body).toContain("Page not found")
    })
})
