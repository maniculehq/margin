/**
 * Icons reach the framework one way: the name map `bun run icons:build`
 * renders from Hugeicons (Free without a token), read server-side or, for the
 * chrome, through the build-time `virtual:chrome-icons` subset. No source may
 * import an icon package directly — a Pro import breaks every token-less
 * build, and `@hugeicons/react` is a second icon runtime the chrome no longer
 * needs. Pro references and inline SVG outside the generated map are
 * policed by `isolation.test.ts`; the client bundle by
 * `bundle-budget.test.ts`.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")

// This file names the forbidden specifiers, so it is never scanned.
const SELF = "tests/conventions/icons.test.ts"

const sources = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
)
    .split("\0")
    .filter(
        (file) =>
            /\.(?:[cm]?[jt]sx?)$/.test(file) &&
            file !== SELF &&
            !file.startsWith("src/generated/"),
    )
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }))

/** Every module specifier a file imports, re-exports or loads dynamically. */
const specifiers = (text: string) =>
    [
        ...text.matchAll(
            /\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g,
        ),
    ].map(([, specifier = ""]) => specifier)

const chromeNames = new Set(
    z
        .array(z.string())
        .parse(
            JSON.parse(
                readFileSync(join(root, "scripts/icon-chrome.json"), "utf8"),
            ),
        ),
)

describe("icon conventions", () => {
    it("scans the package's sources", () => {
        const scanned = sources.map(({ file }) => file)
        expect(scanned).toContain("src/components/mdx.tsx")
        expect(scanned).toContain("scripts/build-icon-map.ts")
    })

    it("imports no Hugeicons React runtime", () => {
        // A hoisted copy can still resolve after the dependency is dropped,
        // so the manifest check below cannot catch a stray import alone.
        expect(
            sources.flatMap(({ file, text }) =>
                specifiers(text)
                    .filter((specifier) =>
                        /^@hugeicons\/react(?:\/|$)/.test(specifier),
                    )
                    .map((specifier) => `${file}: ${specifier}`),
            ),
        ).toEqual([])
    })

    it("depends on no Hugeicons package but the Free set", () => {
        const { dependencies = {}, devDependencies = {} } = z
            .object({
                dependencies: z.record(z.string(), z.string()).optional(),
                devDependencies: z.record(z.string(), z.string()).optional(),
            })
            .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")))
        const hugeicons = Object.keys({
            ...dependencies,
            ...devDependencies,
        }).filter((name) => name.startsWith("@hugeicons"))
        expect(hugeicons).toEqual(["@hugeicons/core-free-icons"])
    })

    it("names only chrome glyphs the build extracts", () => {
        // chromeIcon("…")/chromeIconSvg("…") throw on an unlisted name when
        // the module loads in the browser; catch the typo at test time.
        const used = sources.flatMap(({ file, text }) =>
            [...text.matchAll(/\bchromeIcon(?:Svg)?\(\s*"([^"]+)"\s*\)/g)].map(
                ([, name = ""]) => ({ file, name }),
            ),
        )
        expect(used.length).toBeGreaterThan(0)
        expect(
            used
                .filter(({ name }) => !chromeNames.has(name))
                .map(({ file, name }) => `${file}: ${name}`),
        ).toEqual([])
    })
})
