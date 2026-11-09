/**
 * `bun run test:e2e`: the built-server suites against a throwaway database.
 *
 *   0. Build the icon map (a fresh checkout has none; the build needs it).
 *   1. Start a disposable Postgres (`docker compose -p docs-e2e-<pid>` on a
 *      free host port, so it never touches the dev database).
 *   2. Apply the migrations (`scripts/db-migrate.ts`).
 *   3. Ingest every docs fixture under tests/fixtures as its own site
 *      (`scripts/ingest.ts --dir tests/fixtures/<name> --slug <name>`).
 *   4. Build the node-server bundle (`DOCS_EXTENSIONS` passes through, so a
 *      host can run the suites against its own extensions module).
 *   5. Run every `tests/*-e2e.test.ts` suite plus the bundle budget.
 *
 * The database is torn down on every exit path, including SIGINT/SIGTERM/
 * SIGHUP: the signal stops the running step, then teardown runs to the end
 * (a second signal does not interrupt it). tests/browser-e2e.test.ts
 * stays out: it drives real published sites the fixtures do not provide.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import net from "node:net"
import { join, resolve } from "node:path"
import { z } from "zod"

const root = resolve(import.meta.dirname, "..")
const ingestScript = resolve(import.meta.dirname, "ingest.ts")
const fixturesRoot = join(root, "tests", "fixtures")

if (!existsSync(ingestScript)) {
    console.error(
        `[e2e] ${ingestScript} is missing; the fixtures cannot be ingested. The e2e suites need scripts/ingest.ts to seed the database.`,
    )
    process.exit(1)
}

let active: ChildProcess | undefined
let interrupted: NodeJS.Signals | undefined
let tearingDown = false
const handled: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
for (const signal of handled) {
    process.on(signal, () => {
        interrupted ??= signal
        // Teardown always finishes; only the step in flight is stopped.
        if (!tearingDown) active?.kill(signal)
    })
}

/** Runs a command with inherited stdio; resolves to its exit code. */
function run(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    return new Promise((done, fail) => {
        const child = spawn(command, args, { cwd: root, env, stdio: "inherit" })
        active = child
        child.on("exit", () => {
            if (active === child) active = undefined
        })
        child.on("error", (error) => {
            const missing =
                command === "docker" &&
                z.object({ code: z.literal("ENOENT") }).safeParse(error).success
            fail(
                missing
                    ? new Error(
                          "[e2e] Docker is required: install it or start the daemon.",
                          { cause: error },
                      )
                    : error,
            )
        })
        child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)))
    })
}

async function mustRun(
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
) {
    if (interrupted) throw new Error(`[e2e] interrupted by ${interrupted}`)
    const code = await run(command, args, env)
    if (interrupted) throw new Error(`[e2e] interrupted by ${interrupted}`)
    if (code !== 0) {
        throw new Error(`[e2e] \`${command} ${args.join(" ")}\` exited ${code}`)
    }
}

const port = await new Promise<number>((done, fail) => {
    const server = net.createServer()
    server.unref()
    server.on("error", fail)
    server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
            fail(new Error("[e2e] could not allocate a free port"))
            return
        }
        server.close(() => done(address.port))
    })
})

const project = `docs-e2e-${process.pid}`
const env: NodeJS.ProcessEnv = {
    ...process.env,
    POSTGRES_PORT: String(port),
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/docs`,
    // The pooled and direct URLs of the developer's .env must not leak in.
    POSTGRES_URL: "",
    DATABASE_URL_UNPOOLED: "",
    POSTGRES_URL_NON_POOLING: "",
    SITE_ORIGIN: "https://docs.test.invalid",
}
const compose = ["compose", "-p", project]

let exitCode = 1
try {
    await mustRun(process.execPath, ["scripts/build-icon-map.ts"], env)
    await mustRun("docker", [...compose, "up", "-d", "--wait", "postgres"], env)
    await mustRun(process.execPath, ["scripts/db-migrate.ts"], env)

    const fixtures = (await readdir(fixturesRoot, { withFileTypes: true }))
        .filter(
            (entry) =>
                entry.isDirectory() &&
                (existsSync(join(fixturesRoot, entry.name, "docs.json")) ||
                    existsSync(join(fixturesRoot, entry.name, "index.mdx"))),
        )
        .map((entry) => entry.name)
        .sort()
    for (const name of fixtures) {
        await mustRun(
            process.execPath,
            [ingestScript, "--dir", join(fixturesRoot, name), "--slug", name],
            env,
        )
    }

    await mustRun(process.execPath, ["x", "vite", "build"], {
        ...env,
        NODE_ENV: "production",
        NITRO_PRESET: "node-server",
    })
    // The built-server suites skip when the server bundle is absent; a build
    // that moved or omitted it must fail here, not pass on the budget alone.
    const serverEntry = join(root, ".output", "server", "index.mjs")
    if (!existsSync(serverEntry)) {
        throw new Error(`[e2e] the build produced no server at ${serverEntry}`)
    }

    const suites = (await readdir(join(root, "tests")))
        .filter(
            (file) =>
                file.endsWith("-e2e.test.ts") && file !== "browser-e2e.test.ts",
        )
        .sort()
        .map((file) => `tests/${file}`)
    exitCode = await run(
        process.execPath,
        [
            "x",
            "vitest",
            "run",
            ...suites,
            "tests/conventions/zero-env.test.ts",
            "tests/bundle-budget.test.ts",
        ],
        { ...env, BROWSER_E2E: "1" },
    )
    if (interrupted) exitCode = 130
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
} finally {
    tearingDown = true
    await run("docker", [...compose, "down", "-v"], env).catch(() => 1)
}
process.exit(interrupted ? 130 : exitCode)
