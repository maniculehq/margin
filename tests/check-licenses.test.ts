/**
 * `scripts/check-licenses.ts` against fixture dependency trees: the copied
 * script walks a fixture package.json and its hand-written node_modules, and
 * the tests read the verdicts from its output.
 */
import { execFile } from "node:child_process"
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "..")
const dirs: string[] = []

/** A fixture project: `packages` maps a node_modules-relative directory to
 * the package.json written there; the root depends on `rootDependencies`. */
function fixture(
    rootDependencies: string[],
    packages: Record<string, Record<string, unknown>>,
) {
    const dir = mkdtempSync(join(tmpdir(), "check-licenses-"))
    dirs.push(dir)
    mkdirSync(join(dir, "scripts"))
    for (const file of ["check-licenses.ts", "spdx-ids.json"])
        copyFileSync(join(root, "scripts", file), join(dir, "scripts", file))
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            name: "fixture-root",
            dependencies: Object.fromEntries(
                rootDependencies.map((name) => [name, "*"]),
            ),
        }),
    )
    for (const [path, manifest] of Object.entries(packages)) {
        const packageDir = join(dir, "node_modules", path)
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
            join(packageDir, "package.json"),
            JSON.stringify({ version: "1.0.0", license: "MIT", ...manifest }),
        )
    }
    // The script's own import; not a dependency of the fixture, so not walked.
    symlinkSync(
        realpathSync(join(root, "node_modules", "zod")),
        join(dir, "node_modules", "zod"),
    )
    return dir
}

async function check(dir: string, args: string[] = []) {
    return promisify(execFile)(
        "bun",
        [join(dir, "scripts/check-licenses.ts"), ...args],
        { cwd: dir },
    ).then(
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

describe("license verdicts", () => {
    /** Fixture package name → the license string it declares. */
    const DECLARED: Record<string, string> = {
        "fixture-mit": "MIT",
        "fixture-dual": "(MIT OR GPL-3.0-only)",
        "fixture-llvm": "Apache-2.0 WITH LLVM-exception",
        "fixture-custom-or": "MIT OR LicenseRef-foo WITH LLVM-exception",
        "fixture-gpl": "GPL-3.0-only",
        "fixture-custom": "LicenseRef-foo WITH LLVM-exception",
        "fixture-with-and": "MIT WITH AND",
        "fixture-bogus-exception": "MIT WITH BogusException",
        "fixture-typo": "MIT OR M1T",
        "fixture-lowercase-operator": "MIT and ISC",
        "@img/sharp-libvips-linux-x64": "LGPL-3.0-or-later",
        "@img/sharp-libvips-arbitrary-unreviewed": "LGPL-3.0-or-later",
    }
    let result = { code: 0, stdout: "", stderr: "" }
    beforeAll(async () => {
        result = await check(
            fixture(
                Object.keys(DECLARED),
                Object.fromEntries(
                    Object.entries(DECLARED).map(([name, license]) => [
                        name,
                        { name, license },
                    ]),
                ),
            ),
        )
    }, 30_000)

    /** The `name@1.0.0: <license> (<problem>)` failure line, if any. */
    const failure = (name: string) =>
        result.stderr
            .split("\n")
            .find((line) => line.trim().startsWith(`${name}@1.0.0:`))
            ?.trim()

    it("walks every fixture package and fails the run", () => {
        for (const name of Object.keys(DECLARED))
            expect(result.stdout).toContain(`| ${name} | 1.0.0 |`)
        expect(result.code).toBe(1)
    })

    it.each([
        "fixture-mit",
        "fixture-dual",
        "fixture-llvm",
        "fixture-custom-or",
    ])("passes %s, a valid expression with an allowed branch", (name) => {
        expect(result.stdout).toContain(
            `| ${name} | 1.0.0 | ${DECLARED[name]} |`,
        )
        expect(failure(name)).toBeUndefined()
    })

    it.each(["fixture-gpl", "fixture-custom"])(
        "fails %s, a valid expression outside the allow-list, as not allowed",
        (name) => {
            expect(failure(name)).toBe(
                `${name}@1.0.0: ${DECLARED[name]} (not allowed)`,
            )
        },
    )

    it.each([
        ["fixture-with-and", "`AND` is not an SPDX exception ID"],
        [
            "fixture-bogus-exception",
            "`BogusException` is not an SPDX exception ID",
        ],
        ["fixture-typo", "`M1T` is not an SPDX license ID"],
        ["fixture-lowercase-operator", "unexpected `and`"],
    ])("rejects the malformed expression of %s", (name, problem) => {
        expect(failure(name)).toBe(
            `${name}@1.0.0: ${DECLARED[name]} (${problem})`,
        )
    })

    it("accepts a reviewed exception only under its exact package name", () => {
        expect(result.stdout).toContain(
            "| @img/sharp-libvips-linux-x64 | 1.0.0 | LGPL-3.0-or-later (reviewed) |",
        )
        expect(failure("@img/sharp-libvips-linux-x64")).toBeUndefined()
        expect(failure("@img/sharp-libvips-arbitrary-unreviewed")).toBe(
            "@img/sharp-libvips-arbitrary-unreviewed@1.0.0: LGPL-3.0-or-later (not allowed)",
        )
    })
})

describe("graph comparison", () => {
    // Two installed copies of `shared@1.0.0` resolve `leaf` to different
    // versions, so one parent name carries two edges to one dependency
    // name. `host` has an optional and a required peer.
    const graphFixture = () =>
        fixture(["a", "b", "host"], {
            a: { name: "a", dependencies: { shared: "1.0.0" } },
            "a/node_modules/shared": {
                name: "shared",
                dependencies: { leaf: "*" },
            },
            "a/node_modules/shared/node_modules/leaf": {
                name: "leaf",
                version: "2.0.0",
            },
            b: { name: "b", dependencies: { shared: "1.0.0" } },
            "b/node_modules/shared": {
                name: "shared",
                dependencies: { leaf: "*" },
            },
            leaf: { name: "leaf" },
            host: {
                name: "host",
                peerDependencies: { "optional-peer": "*", "strict-peer": "*" },
                peerDependenciesMeta: { "optional-peer": { optional: true } },
            },
            "optional-peer": { name: "optional-peer" },
            "strict-peer": { name: "strict-peer" },
        })
    let reference = ""
    beforeAll(async () => {
        reference = (await check(graphFixture(), ["--resolved"])).stdout
    }, 30_000)

    /** Compares a fresh fixture, minus `removed` packages, with `graph`. */
    const compare = async (graph: string, removed: string[] = []) => {
        const dir = graphFixture()
        for (const name of removed)
            rmSync(join(dir, "node_modules", name), { recursive: true })
        const file = join(dir, "reference.txt")
        writeFileSync(file, graph)
        return check(dir, ["--compare", file])
    }

    it("prints both resolutions of the duplicated edge", () => {
        expect(reference).toContain("shared@1.0.0\tleaf\tleaf@1.0.0\t")
        expect(reference).toContain("shared@1.0.0\tleaf\tleaf@2.0.0\t")
    })

    it("matches its own graph", async () => {
        const result = await compare(reference)
        expect(result.stdout).toMatch(/all \d+ resolved edges match/)
        expect(result.code).toBe(0)
    })

    it("fails when one of two same-named edges resolves differently", async () => {
        const result = await compare(
            reference.replace("\tleaf@2.0.0\t", "\tleaf@3.0.0\t"),
        )
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(
            "not in the reference: shared@1.0.0\tleaf\tleaf@2.0.0\t",
        )
        expect(result.stderr).toContain(
            "missing from this install: shared@1.0.0\tleaf\tleaf@3.0.0\t",
        )
    })

    it("fails against an empty reference", async () => {
        const result = await compare("")
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("the reference graph resolves no edges")
    })

    it("allows an optional edge only the reference resolves", async () => {
        const result = await compare(reference, ["optional-peer"])
        expect(result.stdout).toContain(
            "optional edge only the reference resolves: host@1.0.0\toptional-peer",
        )
        expect(result.code).toBe(0)
    })

    it("fails when a required edge is missing from the install", async () => {
        const result = await compare(reference, ["strict-peer"])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(
            "missing from this install: host@1.0.0\tstrict-peer\tstrict-peer@1.0.0\tpeerDependencies\trequired",
        )
    })

    it("rejects a malformed reference line", async () => {
        const result = await compare(
            `${reference}host@1.0.0\tleaf\tleaf@1.0.0\tdependencies\n`,
        )
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("ZodError")
    })
})
