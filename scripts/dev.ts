/**
 * `bun run dev`: builds the icon map, then runs the watch ingest
 * (`scripts/ingest.ts --watch`, which re-ingests DOCS_DIR on every change
 * and advances the `current` pointer) beside `vite dev`.
 *
 * Both children share this process's lifetime: SIGINT/SIGTERM/SIGHUP are
 * forwarded to each, and when either child exits the other is stopped, so
 * no ingest watcher or dev server is left running after the terminal closes
 * or one side crashes. The exit code is the first child's.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const ingestScript = resolve(import.meta.dirname, "ingest.ts")

if (!existsSync(ingestScript)) {
    console.error(
        `[dev] ${ingestScript} is missing; the watch ingest cannot start. Restore scripts/ingest.ts or run \`vite dev\` against an already ingested database.`,
    )
    process.exit(1)
}

const icons = spawnSync(process.execPath, ["scripts/build-icon-map.ts"], {
    cwd: root,
    stdio: "inherit",
})
if (icons.status !== 0) process.exit(icons.status ?? 1)

const children: ChildProcess[] = [
    spawn(process.execPath, [ingestScript, "--watch"], {
        cwd: root,
        stdio: "inherit",
    }),
    spawn(process.execPath, ["x", "vite", "dev"], {
        cwd: root,
        stdio: "inherit",
    }),
]

let exitCode: number | undefined
let killTimer: ReturnType<typeof setTimeout> | undefined

function stopAll(signal: NodeJS.Signals) {
    const running = children.filter(
        (child) => child.exitCode === null && child.signalCode === null,
    )
    for (const child of running) child.kill(signal)
    // A child that ignores the signal must not keep the session alive.
    if (running.length > 0 && !killTimer) {
        killTimer = setTimeout(() => {
            for (const child of running) child.kill("SIGKILL")
        }, 10_000)
        killTimer.unref()
    }
}

const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
for (const signal of forwarded) {
    process.on(signal, () => {
        exitCode ??= 130
        stopAll(signal)
    })
}

await Promise.all(
    children.map(
        (child) =>
            new Promise<void>((done) => {
                child.on("exit", (code, signal) => {
                    exitCode ??= code ?? (signal ? 1 : 0)
                    // One side ended (crash or Ctrl-C): take the other down.
                    stopAll("SIGTERM")
                    done()
                })
                child.on("error", (error) => {
                    console.error(`[dev] ${error.message}`)
                    exitCode ??= 1
                    stopAll("SIGTERM")
                    done()
                })
            }),
    ),
)
process.exit(exitCode ?? 0)
