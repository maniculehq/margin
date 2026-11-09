import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url))

/** The `define` maps of the resolved Vite config, per environment, for one
 * command under a clean environment. */
async function resolvedDefines(
    command: "build" | "serve",
    extraEnv: Record<string, string>,
) {
    const { stdout } = await promisify(execFile)(
        "bun",
        [
            "--no-env-file",
            "-e",
            [
                'import { resolveConfig } from "vite";',
                `const config = await resolveConfig({ configFile: "./vite.config.ts", logLevel: "silent" }, ${JSON.stringify(command)});`,
                "console.log(JSON.stringify(Object.fromEntries(Object.entries(config.environments).map(([name, environment]) => [name, environment.define ?? {}]))));",
                // Serve-mode plugins (the Nitro dev runner) keep handles open.
                "process.exit(0);",
            ].join("\n"),
        ],
        {
            cwd: frameworkRoot,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                SITE_ORIGIN: "https://docs.test.invalid",
                ...extraEnv,
            },
        },
    )
    // Plugins log to stdout while resolving; the JSON is the last line.
    return z
        .record(z.string(), z.record(z.string(), z.string()))
        .parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""))
}

const contentShaCases: {
    label: string
    env: Record<string, string>
    baked: string
}[] = [
    {
        label: "DOCS_CONTENT_SHA over the Vercel commit",
        env: {
            DOCS_CONTENT_SHA: "pinned-content",
            VERCEL_GIT_COMMIT_SHA: "vercel-commit",
        },
        baked: JSON.stringify("pinned-content"),
    },
    {
        label: "the Vercel commit when DOCS_CONTENT_SHA is unset",
        env: { VERCEL_GIT_COMMIT_SHA: "vercel-commit" },
        baked: JSON.stringify("vercel-commit"),
    },
    // scripts/vercel-build.ts always supplies DOCS_CONTENT_SHA; a plain
    // `vite build` with neither serves the `current` pointer.
    { label: "no version without either", env: {}, baked: "undefined" },
]

// Each case resolves the full plugin stack in a fresh process.
describe.concurrent("build-time content version", { timeout: 30_000 }, () => {
    it.for(contentShaCases)(
        "bakes $label into the server bundle",
        async ({ env, baked }) => {
            const defines = await resolvedDefines("build", env)
            // ssr renders pages; nitro bundles the deployed server.
            expect(defines.ssr?.["process.env.DOCS_CONTENT_SHA"]).toBe(baked)
            expect(defines.nitro?.["process.env.DOCS_CONTENT_SHA"]).toBe(baked)
        },
    )

    it("bakes no version into the dev server", async () => {
        const defines = await resolvedDefines("serve", {
            DOCS_CONTENT_SHA: "pinned-content",
        })
        expect(defines.ssr).toBeDefined()
        expect(defines.ssr).not.toHaveProperty("process.env.DOCS_CONTENT_SHA")
    })

    it("inlines SITE_NAME for the client and the server", async () => {
        const defines = await resolvedDefines("build", {
            SITE_NAME: "Acme Docs",
        })
        for (const name of ["client", "ssr", "nitro"]) {
            expect(defines[name]?.["process.env.SITE_NAME"]).toBe(
                JSON.stringify("Acme Docs"),
            )
        }
    })
})

describe.concurrent("framework deployment environment", () => {
    it.for(["preview"])(
        "keeps server classification for %s deployments",
        async (deployment) => {
            const { stdout } = await promisify(execFile)(
                "bun",
                [
                    "--no-env-file",
                    "-e",
                    [
                        `const { deploymentEnvironment } = await import(${JSON.stringify(fileURLToPath(new URL("../src/env.ts", import.meta.url)))});`,
                        "console.log(deploymentEnvironment);",
                    ].join("\n"),
                ],
                {
                    env: {
                        PATH: process.env.PATH,
                        NODE_ENV: "production",
                        SITE_ORIGIN: "https://docs.test.invalid",
                        VERCEL_ENV: deployment,
                        VERCEL_GIT_COMMIT_REF: "docs-testing/env",
                    },
                },
            )
            expect(stdout.trim()).toBe(deployment)
        },
    )

    it.for([
        "DATABASE_URL",
        "SENTRY_AUTH_TOKEN",
        "VERCEL_AUTOMATION_BYPASS_SECRET",
    ])("keeps %s inaccessible to client imports", async (secret) => {
        const { stdout } = await promisify(execFile)(
            "bun",
            [
                "--no-env-file",
                "-e",
                [
                    'import assert from "node:assert/strict";',
                    "globalThis.window = {};",
                    `const { env } = await import(${JSON.stringify(fileURLToPath(new URL("../src/env.ts", import.meta.url)))});`,
                    `assert.throws(() => env[${JSON.stringify(secret)}], /Attempted to access a server-side environment variable/);`,
                    'console.log("protected");',
                ].join("\n"),
            ],
            {
                env: {
                    PATH: process.env.PATH,
                    NODE_ENV: "production",
                    SITE_ORIGIN: "https://docs.test.invalid",
                    VERCEL_ENV: "preview",
                    [secret]: "framework-test-secret-must-not-ship",
                },
            },
        )
        expect(stdout.trim()).toBe("protected")
    })

    it.for(["client", "server"])(
        "rejects invalid deployment classification on the %s",
        async (runtime) => {
            await expect(
                promisify(execFile)(
                    "bun",
                    [
                        "--no-env-file",
                        "-e",
                        [
                            runtime === "client"
                                ? "globalThis.window = {};"
                                : "",
                            `await import(${JSON.stringify(fileURLToPath(new URL("../src/env.ts", import.meta.url)))});`,
                        ].join("\n"),
                    ],
                    {
                        env: {
                            PATH: process.env.PATH,
                            NODE_ENV: "production",
                            SITE_ORIGIN: "https://docs.test.invalid",
                            VERCEL_ENV: "invalid-deployment",
                        },
                    },
                ),
            ).rejects.toThrow("Invalid environment variables")
        },
    )

    it.for(["preview", undefined])(
        "bundles the real client environment with %s classification and no server secrets",
        async (deployment) => {
            const { stdout } = await promisify(execFile)(
                "bun",
                [
                    "--no-env-file",
                    "-e",
                    [
                        'import assert from "node:assert/strict";',
                        'import { mkdtemp, readFile, rm } from "node:fs/promises";',
                        'import { tmpdir } from "node:os";',
                        'import { join } from "node:path";',
                        'import { runInNewContext } from "node:vm";',
                        'import { build } from "vite";',
                        `const { default: config } = await import(${JSON.stringify(fileURLToPath(new URL("../vite.config.ts", import.meta.url)))});`,
                        'const directory = await mkdtemp(join(tmpdir(), "framework-env-"));',
                        "try {",
                        "await build({",
                        "configFile: false, envFile: false, logLevel: 'silent',",
                        "define: config.environments?.client?.define,",
                        "resolve: { tsconfigPaths: false },",
                        "build: { outDir: directory, emptyOutDir: true, minify: false,",
                        `rollupOptions: { input: ${JSON.stringify(fileURLToPath(new URL("../src/env.ts", import.meta.url)))}, preserveEntrySignatures: "strict", output: { format: "iife", name: "frameworkEnv", entryFileNames: "env.js" } } },`,
                        "});",
                        'const code = await readFile(join(directory, "env.js"), "utf8");',
                        'assert.ok(!code.includes("framework-test-secret-must-not-ship"));',
                        // URL is a web global the bundle needs for zod's .url() checks; a bare VM context lacks it.
                        'const result = runInNewContext(code + "\\nframeworkEnv.deploymentEnvironment;", { window: {}, console, URL });',
                        "console.log(result);",
                        "} finally { await rm(directory, { recursive: true, force: true }); }",
                    ].join("\n"),
                ],
                {
                    cwd: fileURLToPath(new URL("..", import.meta.url)),
                    env: {
                        PATH: process.env.PATH,
                        NODE_ENV: "production",
                        SITE_ORIGIN: "https://docs.test.invalid",
                        VERCEL_ENV: deployment,
                        VERCEL_GIT_COMMIT_REF: "docs-testing/env",
                        SENTRY_AUTH_TOKEN:
                            "framework-test-secret-must-not-ship",
                        VERCEL_AUTOMATION_BYPASS_SECRET:
                            "framework-test-secret-must-not-ship",
                    },
                },
            )
            expect(stdout.trim()).toBe(deployment ?? "production")
        },
    )
})
