/**
 * `bun run icons:build` renders the committed name map into
 * `src/generated/icon-map.ts` from Hugeicons Free, or from Hugeicons Pro
 * fetched from the registry with the token on its requests alone. Each case runs the
 * real script from a scratch copy of `scripts/` so the developer's generated
 * map is never touched and cases can run in parallel.
 */
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")
const scratchDirs: string[] = []
afterEach(() => {
    for (const dir of scratchDirs.splice(0))
        rmSync(dir, { recursive: true, force: true })
})

const iconMapSchema = z.record(
    z.string(),
    z.object({ target: z.string(), tier: z.string(), confidence: z.number() }),
)
const realIconMap = iconMapSchema.parse(
    JSON.parse(readFileSync(join(root, "scripts/icon-map.json"), "utf8")),
)
const realChromeNames = z
    .array(z.string())
    .parse(
        JSON.parse(
            readFileSync(join(root, "scripts/icon-chrome.json"), "utf8"),
        ),
    )

/** A package root holding a copy of `scripts/` with the given map and chrome list. */
function scratchPackage(
    iconMap: z.infer<typeof iconMapSchema>,
    chromeNames: string[],
): string {
    const dir = mkdtempSync(join(tmpdir(), "icons-build-test-"))
    scratchDirs.push(dir)
    mkdirSync(join(dir, "scripts"))
    for (const file of readdirSync(join(root, "scripts")))
        if (/^(build-icon-map\.ts|icon-.*\.json)$/.test(file))
            copyFileSync(
                join(root, "scripts", file),
                join(dir, "scripts", file),
            )
    writeFileSync(join(dir, "scripts/icon-map.json"), JSON.stringify(iconMap))
    writeFileSync(
        join(dir, "scripts/icon-chrome.json"),
        JSON.stringify(chromeNames),
    )
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"))
    return dir
}

/** Runs the copied build; never inherits a developer's own Pro token. */
async function runBuild(dir: string, env: Record<string, string> = {}) {
    const inherited = z
        .record(z.string(), z.string())
        .parse(
            Object.fromEntries(
                Object.entries(process.env).filter(
                    ([key, value]) =>
                        value !== undefined && !key.startsWith("HUGEICONS_"),
                ),
            ),
        )
    const result = await promisify(execFile)(
        "bun",
        [join(dir, "scripts/build-icon-map.ts")],
        { cwd: dir, env: { ...inherited, ...env } },
    ).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error: unknown) => {
            const failure = z
                .object({
                    code: z.number(),
                    stdout: z.string(),
                    stderr: z.string(),
                })
                .parse(error)
            return failure
        },
    )
    const output = join(dir, "src/generated/icon-map.ts")
    return {
        ...result,
        generated: existsSync(output) ? readFileSync(output, "utf8") : null,
    }
}

/** The `DOCS_ICON_SVGS` entries of a generated map, name → SVG markup. */
const glyphs = (generated: string) =>
    z
        .record(z.string(), z.string())
        .parse(
            Object.fromEntries(
                [
                    ...generated
                        .slice(
                            generated.indexOf("export const DOCS_ICON_SVGS"),
                            generated.indexOf(
                                "export const DOCS_ICON_SYNONYMS",
                            ),
                        )
                        .matchAll(
                            /^ {4}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$/gm,
                        ),
                ].map(([, name = "", svg = ""]) => [
                    JSON.parse(name),
                    JSON.parse(svg),
                ]),
            ),
        )

/**
 * A one-package npm registry serving the fake Pro fixture, plus a PATH that
 * holds only bun and a tar wrapper recording whether the token reached tar.
 * `integrity` replaces the packument's honest sha512 digest.
 */
async function fakeProRegistry(integrity?: string) {
    // A one-package npm registry serving the fake Pro fixture.
    const fixture = join(root, "tests/fixtures/hugeicons-pro-fake")
    const { name, version } = z
        .object({ name: z.string(), version: z.string() })
        .parse(JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")))
    const work = mkdtempSync(join(tmpdir(), "icons-registry-"))
    scratchDirs.push(work)
    cpSync(fixture, join(work, "pack/package"), { recursive: true })
    execFileSync("tar", ["czf", "fake.tgz", "-C", "pack", "package"], {
        cwd: work,
    })
    const tarball = readFileSync(join(work, "fake.tgz"))
    const authorizations: string[] = []
    const server = createServer((request, response) => {
        authorizations.push(request.headers.authorization ?? "")
        const origin = `http://${request.headers.host}`
        if (request.url === "/fake.tgz") {
            response.end(tarball)
            return
        }
        if (decodeURIComponent(request.url ?? "") !== `/${name}`) {
            response.statusCode = 404
            response.end()
            return
        }
        response.setHeader("content-type", "application/json")
        response.end(
            JSON.stringify({
                name,
                "dist-tags": { latest: version },
                versions: {
                    [version]: {
                        name,
                        version,
                        dist: {
                            tarball: `${origin}/fake.tgz`,
                            shasum: createHash("sha1")
                                .update(tarball)
                                .digest("hex"),
                            integrity:
                                integrity ??
                                `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                        },
                    },
                },
            }),
        )
    })
    await new Promise<void>((listening) =>
        server.listen(0, "127.0.0.1", listening),
    )
    const { port } = z
        .object({ port: z.number() })
        .parse(server.address() satisfies AddressInfo | string | null)
    // PATH holds only bun and a tar wrapper: the build must not need a
    // package manager binary to reach the registry, and the wrapper
    // records whether the token leaked into tar's environment.
    const bin = join(work, "bin")
    mkdirSync(bin)
    const which = (tool: string) =>
        execFileSync("which", [tool], { encoding: "utf8" }).trim()
    symlinkSync(which("bun"), join(bin, "bun"))
    const tarEnv = join(work, "tar-env")
    writeFileSync(
        join(bin, "tar"),
        `#!/bin/sh\nprintf '%s' "\${HUGEICONS_PRO_TOKEN-unset}" > '${tarEnv}'\nexec '${which("tar")}' "$@"\n`,
        { mode: 0o755 },
    )
    expect(existsSync(join(bin, "npm"))).toBe(false)

    return { authorizations, bin, port, server, tarEnv }
}

describe("icons:build", () => {
    it("renders the Free set, resolving every chrome glyph and omitting glyphs the set lacks", async () => {
        const dir = scratchPackage(
            {
                ...realIconMap,
                "not-in-any-set": {
                    target: "NotARealHugeiconsGlyph",
                    tier: "exact",
                    confidence: 1,
                },
            },
            realChromeNames,
        )
        const build = await runBuild(dir)

        expect(build.code).toBe(0)
        expect(build.generated).toContain(
            'ICON_MAP_SOURCE: "pro" | "free" = "free"',
        )
        const rendered = glyphs(build.generated ?? "")
        // Free carries every icon the committed map names, chrome included.
        expect(Object.keys(rendered).sort()).toEqual(
            Object.keys(realIconMap).sort(),
        )
        expect(realChromeNames.every((name) => name in rendered)).toBe(true)
        // Every glyph closes over at least one drawn child element: no empty
        // roots, no attribute-less placeholders.
        expect(
            Object.entries(rendered)
                .filter(
                    ([, svg]) =>
                        !svg.endsWith("/></svg>") ||
                        !/<(?:path|circle|rect|ellipse|line|polyline|polygon) [a-z-]+="[^"]+"/.test(
                            svg,
                        ),
                )
                .map(([name]) => name),
        ).toEqual([])
        expect(build.stdout).toContain(
            `free set, ${Object.keys(realIconMap).length} of ${Object.keys(realIconMap).length + 1} icons rendered, 1 gaps`,
        )
        expect(build.stdout).toContain("gaps (default glyph): not-in-any-set")
        expect("not-in-any-set" in rendered).toBe(false)
    })

    it("fails naming the chrome glyph the set lacks", async () => {
        const dir = scratchPackage(
            {
                ...realIconMap,
                search: {
                    target: "NotARealHugeiconsGlyph",
                    tier: "exact",
                    confidence: 1,
                },
            },
            realChromeNames,
        )
        const build = await runBuild(dir)

        expect(build.code).not.toBe(0)
        expect(build.stderr).toContain(
            "chrome icon glyphs missing from the free set: search (NotARealHugeiconsGlyph)",
        )
        expect(build.generated).toBeNull()
    })

    it("fetches Hugeicons Pro from the registry with no npm on PATH and the token on its requests alone", async () => {
        const registry = await fakeProRegistry()
        const { authorizations, tarEnv } = registry
        const token = "fake-pro-token-7f3a9c"
        const dir = scratchPackage(
            {
                square: {
                    target: "FakeSquareIcon",
                    tier: "exact",
                    confidence: 1,
                },
                ring: {
                    target: "FakeCircleIcon",
                    tier: "exact",
                    confidence: 1,
                },
                "not-in-fake": {
                    target: "NotARealHugeiconsGlyph",
                    tier: "exact",
                    confidence: 1,
                },
            },
            ["square", "ring"],
        )
        const build = await runBuild(dir, {
            HUGEICONS_PRO_TOKEN: token,
            HUGEICONS_PRO_REGISTRY_FOR_TESTS: `http://127.0.0.1:${registry.port}/`,
            PATH: registry.bin,
        }).finally(() => registry.server.close())

        expect(build.code).toBe(0)
        expect(authorizations).toContain(`Bearer ${token}`)
        expect(readFileSync(tarEnv, "utf8")).toBe("unset")
        const generated = build.generated ?? ""
        expect(generated).toContain('ICON_MAP_SOURCE: "pro" | "free" = "pro"')
        const rendered = glyphs(generated)
        expect(rendered.square).toBe(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>',
        )
        expect(Object.keys(rendered).sort()).toEqual(["ring", "square"])
        expect(
            [build.stdout, build.stderr, generated].filter((text) =>
                text.includes(token),
            ),
        ).toEqual([])
    })

    it("refuses a Pro tarball whose bytes do not match the registry's integrity", async () => {
        const registry = await fakeProRegistry(
            `sha512-${createHash("sha512").update("other bytes").digest("base64")}`,
        )
        const dir = scratchPackage(
            {
                square: {
                    target: "FakeSquareIcon",
                    tier: "exact",
                    confidence: 1,
                },
            },
            ["square"],
        )
        const build = await runBuild(dir, {
            HUGEICONS_PRO_TOKEN: "fake-pro-token-7f3a9c",
            HUGEICONS_PRO_REGISTRY_FOR_TESTS: `http://127.0.0.1:${registry.port}/`,
            PATH: registry.bin,
        }).finally(() => registry.server.close())

        // The tarball was served and checked: the failure is the digest.
        expect(registry.authorizations).toContain(
            "Bearer fake-pro-token-7f3a9c",
        )
        expect(build.code).not.toBe(0)
        expect(build.stderr).toContain(
            "tarball failed its sha512 integrity check",
        )
        expect(build.generated).toBeNull()
        // Rejected before extraction: tar never ran.
        expect(existsSync(registry.tarEnv)).toBe(false)
    })
})
