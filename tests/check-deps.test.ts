/**
 * `scripts/check-deps.ts` against fixture repositories: the listed packages
 * are named only in comments, strings and command arguments first, then
 * loaded or run for real. Only syntax that loads a module, or a script
 * command that runs a package's binary, may count as a use.
 */
import { execFile, execFileSync } from "node:child_process"
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterAll, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "..")
const LISTED = ["left-pad", "is-odd", "is-even", "fake-tool"]
const dirs: string[] = []

/** Runs the copied check over a fixture repository holding `files`, whose
 * package.json lists LISTED and has `scripts`. `fake-tool` is installed
 * with a `fake-tool-cli` binary. */
async function checkDeps(
    files: Record<string, string>,
    scripts: Record<string, string> = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "check-deps-"))
    dirs.push(dir)
    mkdirSync(join(dir, "scripts"))
    mkdirSync(join(dir, "src"))
    copyFileSync(
        join(root, "scripts/check-deps.ts"),
        join(dir, "scripts/check-deps.ts"),
    )
    // The script's own imports resolve from here; none is listed.
    for (const name of ["zod", "rolldown", "lightningcss"]) {
        mkdirSync(join(dir, "node_modules"), { recursive: true })
        symlinkSync(
            realpathSync(join(root, "node_modules", name)),
            join(dir, "node_modules", name),
        )
    }
    mkdirSync(join(dir, "node_modules/fake-tool"))
    writeFileSync(
        join(dir, "node_modules/fake-tool/package.json"),
        JSON.stringify({
            name: "fake-tool",
            bin: { "fake-tool-cli": "cli.js" },
        }),
    )
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            scripts,
            devDependencies: Object.fromEntries(
                LISTED.map((name) => [name, "1.0.0"]),
            ),
        }),
    )
    for (const [path, text] of Object.entries(files))
        writeFileSync(join(dir, path), text)
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["add", "-A"], { cwd: dir })
    return promisify(execFile)("bun", ["scripts/check-deps.ts"], {
        cwd: dir,
    }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error: unknown) =>
            z
                .object({
                    code: z.number(),
                    stdout: z.string(),
                    stderr: z.string(),
                })
                .parse(error),
    )
}

afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

it("counts real module loads and binaries run as commands", async () => {
    const result = await checkDeps(
        {
            "src/probe.ts": `declare module "left-pad" {}\nexport const load = () => import("is-odd")\n`,
            "src/probe.css": `a {}\n@plugin "is-even";\n`,
            // JSONC: comments and trailing commas are valid tsconfig.
            "tsconfig.json": `{\n  // types\n  "compilerOptions": { "types": [], },\n}\n`,
        },
        { build: "FOO=1 fake-tool-cli --flag && echo done" },
    )
    expect(result.stdout).toContain("every dependency is used")
    expect(result.code).toBe(0)
}, 30_000)

it("ignores packages named only in comments, strings and arguments", async () => {
    const result = await checkDeps(
        {
            "src/probe.ts": [
                `// declare module "left-pad" {}`,
                `/* import x from "is-odd" */`,
                `export const decoy = 'declare module "left-pad" {} import y from "is-odd"; require("is-even")'`,
                "",
            ].join("\n"),
            "src/probe.css": [
                `a{content:"; @plugin 'left-pad';"}`,
                "b{}",
                "/*",
                `;@import "is-even";`,
                "*/",
                "",
            ].join("\n"),
        },
        { probe: "echo left-pad fake-tool-cli" },
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
        "  fake-tool\n  is-even\n  is-odd\n  left-pad\n",
    )
}, 30_000)
