/**
 * The framework must stand alone: nothing in this package may reach into the
 * repository around it, name the company that first built it, or ship
 * credentials.
 *
 * Nothing may leave the package, and no PostHog key or Hugeicons Pro
 * reference outside the icon build is ever allowed, so those checks have no
 * allow-list. The remaining lists are reviewed exemptions; the last test
 * fails on any entry that no longer matches, so a list can never hold a
 * stale one.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    realpathSync,
} from "node:fs"
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
} from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const root = resolve(import.meta.dirname, "../..")

// This file spells out every forbidden pattern, so it is never scanned.
const SELF = "tests/conventions/isolation.test.ts"

// Loads the import scan cannot follow, each reviewed to stay inside the
// package: non-literal import()/require() arguments, new URL(…,
// import.meta.url), import.meta.glob and file: URLs. `icons:build` imports
// the Hugeicons Pro package it just unpacked into a temp directory; the
// rest point at the package's own files or are not loads at all. Entries are
// `<file>: <expression, whitespace collapsed>`.
const ALLOWED_DYNAMIC_REFERENCES = new Set<string>([
    "scripts/build-icon-map.ts: import(entry.href)",
    "tests/bundle-budget.test.ts: import()` targets (the PDF renderer, the chat stack, the Ope",
    "tests/bundle-budget.test.ts: import()` targets load on",
    'tests/dev-client-graph.test.ts: new URL("..", import.meta.url)',
    'tests/dev-client-graph.test.ts: new URL("../vite.config.ts", import.meta.url)',
    'tests/env.test.ts: import(${JSON.stringify(fileURLToPath(new URL("../src/env.ts',
    'tests/env.test.ts: import(${JSON.stringify(fileURLToPath(new URL("../vite.confi',
    'tests/env.test.ts: new URL("..", import.meta.url)',
    'tests/env.test.ts: new URL("../src/env.ts", import.meta.url)',
    'tests/env.test.ts: new URL("../vite.config.ts", import.meta.url)',
    'tests/inline-scripts.test.ts: new URL("../src/routes/__root.tsx", import.meta.url)',
    // lightningcss visitor method named `import` (CSS @import rules), not a load.
    "src/ingest/theme.ts: import(rule) {",
    "tests/loader-origin-order.test.ts: `file: name`",
    "vite-plugins.ts: new URL(..., import.meta.url)",
    'vitest.config.ts: new URL("./src", import.meta.url)',
])

// Shrinks to empty before export. Files whose text names the company that
// first built the framework. Standing exceptions are matched below instead:
// the package's own scope and repository as whole identifiers
// (`@maniculehq/margin`, `github.com/maniculehq/margin`,
// `maniculehq/margin`), the maintainer's contact address, the README's
// credit line, and the docs site under HOSTED_DOCS.
const ALLOWED_COMPANY_MENTIONS = new Set<string>([])

// Inline SVG belongs in the generated icon map; these files still draw their
// own. Shrinks as they move onto chrome icons.
const ALLOWED_SVG_LITERALS = new Set<string>([
    "src/components/view-group.tsx",
    "src/routes/$.tsx",
    "src/components/docs-header.tsx",
    "src/components/mdx.tsx",
    "src/components/page-feedback.tsx",
    "src/components/view-options.tsx",
    "tests/assets-route.test.ts",
    "src/components/ai/assistant-dock.tsx",
    "src/components/ai/search.tsx",
    "src/components/github-repo.tsx",
    "src/components/github-widget.tsx",
    "src/components/theme-cycle-button.tsx",
    "src/components/version-switch.tsx",
    "src/lib/docs-icon.tsx",
    "src/lib/favicon.ts",
    "src/styles/app.css",
    // The Images page shows an inline SVG as an authoring example.
    "docs/content/media.agent.md",
    "docs/content/media.mdx",
    "tests/docs-query-counts.test.ts",
    "tests/fixtures/mintlify-verbatim/logo/dark.svg",
    "tests/fixtures/mintlify-verbatim/logo/light.svg",
])

const TEXT_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".css",
    ".md",
    ".mdx",
    ".yaml",
    ".yml",
    ".toml",
    ".grit",
    ".patch",
    ".svg",
    ".txt",
    ".html",
    ".xml",
    ".sql",
    ".sh",
])
const TEXT_NAMES = new Set([
    ".gitignore",
    ".mintignore",
    ".gitkeep",
    ".env.example",
    ".npmrc",
    "bun.lock",
    "CODEOWNERS",
    "LICENSE",
    "NOTICE",
])
const BINARY_EXTENSIONS = new Set([
    ".woff2",
    ".woff",
    ".ttf",
    ".otf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".ico",
    ".wasm",
    ".pdf",
])
const CODE = /\.[cm]?[jt]sx?$/
const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*)(["'`])([^"'`]+)\1/g
const PATH_LITERAL = /(["'`])((?:@manicule\/|\.{1,2}\/)[^"'`\s]*)\1/g
const NON_LITERAL_LOAD =
    /\b(?:import|require)\s*\((?!\s*(?:(["'])[^"'\n]*\1|`[^`$]*`)\s*[,)])/g
const COMPANY = /manicule/i
// The framework's own documentation site, which Manicule hosts and which
// documents hosting on Manicule. Authored content, not framework code: it
// may name the company. Everything outside it stays company-free.
const HOSTED_DOCS = "docs/"
// The one sentence crediting the company, matched as the whole README line.
const CREDIT_LINE = "Originally built by Manicule."
// The package's own npm scope and repository, as whole identifiers only.
const OWN_SCOPE =
    /(?:(?<![\w.-])github\.com\/|(?<![\w./-])@?)maniculehq\/margin(?:\.git)?(?=[/"'`\s)#?&]|$)/gim
// The maintainer's address, named in SECURITY.md and CODE_OF_CONDUCT.md.
// The whole address only: a following dot ends a sentence, never a longer
// domain that merely starts with the address's domain.
const MAINTAINER_EMAIL = /(?<![\w.+-])shreyans@manicule\.dev(?![\w-]|\.[\w-])/gi
const POSTHOG_KEY = /phc_[A-Za-z0-9]{20,}/g

// NUL-delimited so names with any characters arrive exactly as stored.
const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
)
    .split("\0")
    .filter((file) => file !== "" && file !== SELF)
// Ignored by git but shipped in builds: brand and credential rules apply.
const generatedDir = resolve(root, "src/generated")
const generated = existsSync(generatedDir)
    ? readdirSync(generatedDir, { recursive: true, encoding: "utf8" })
          .map((name) => `src/generated/${name}`)
          .filter((file) => !lstatSync(resolve(root, file)).isDirectory())
    : []
const allFiles = [...new Set([...listed, ...generated])].filter((file) =>
    existsSync(resolve(root, file)),
)
const escapes = (path: string) => {
    const fromRoot = relative(realpathSync(root), path)
    return fromRoot.startsWith("..") || isAbsolute(fromRoot)
}
const escapingSymlinks = listed
    .filter((file) => lstatSync(resolve(root, file)).isSymbolicLink())
    .filter((file) => {
        const target = resolve(root, file)
        return !existsSync(target) || escapes(realpathSync(target))
    })
const isText = (file: string) =>
    TEXT_NAMES.has(basename(file)) || TEXT_EXTENSIONS.has(extname(file))
const unclassified = allFiles.filter(
    (file) => !isText(file) && !BINARY_EXTENSIONS.has(extname(file)),
)
const files = allFiles
    .filter(isText)
    .map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }))

const tsconfig = z
    .object({
        compilerOptions: z.object({
            paths: z.record(z.string(), z.array(z.string())).default({}),
        }),
    })
    .parse(JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8")))
const packageImports = z
    .object({ imports: z.record(z.string(), z.string()).default({}) })
    .parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")))

// Every absolute path a specifier may load from; empty for a bare package name.
const candidatePaths = (file: string, specifier: string) => {
    if (specifier.startsWith("."))
        return [resolve(root, dirname(file), specifier)]
    if (specifier.startsWith("/")) return [specifier]
    const subpath = packageImports.imports[specifier]
    if (subpath !== undefined) return [resolve(root, subpath)]
    return Object.entries(tsconfig.compilerOptions.paths).flatMap(
        ([pattern, targets]) => {
            const prefix = pattern.endsWith("*")
                ? pattern.slice(0, -1)
                : pattern
            if (
                pattern.endsWith("*")
                    ? !specifier.startsWith(prefix)
                    : pattern !== specifier
            )
                return []
            return targets.map((target) =>
                resolve(
                    root,
                    target.replace("*", specifier.slice(prefix.length)),
                ),
            )
        },
    )
}

const monorepoReferences = files.flatMap(({ file, text }) => {
    const specifiers = CODE.test(file)
        ? [...text.matchAll(SPECIFIER)]
              .map((match) => match[2] ?? "")
              .filter(
                  (specifier) =>
                      specifier.startsWith("@manicule/") ||
                      candidatePaths(file, specifier).some(escapes),
              )
        : []
    const literals = /\.(?:[cm]?[jt]sx?|json|css)$/.test(file)
        ? [...text.matchAll(PATH_LITERAL)]
              .map((match) => match[2] ?? "")
              .filter(
                  (literal) =>
                      literal.startsWith("@manicule/") ||
                      escapes(resolve(root, dirname(file), literal)),
              )
        : []
    return [...specifiers, ...literals].map((entry) => `${file}: ${entry}`)
})

// The files the TypeScript program really loads, resolved to real paths.
const programFiles = execFileSync(
    resolve(root, "node_modules/.bin/tsc"),
    ["-p", "tsconfig.json", "--listFilesOnly"],
    { cwd: root, encoding: "utf8" },
)
    .split("\n")
    .filter((line) => line !== "")
    .map((path) => realpathSync(path))
const programOutside = programFiles
    .filter(escapes)
    .filter((path) => !path.split("/").includes("node_modules"))
    .map((path) => relative(realpathSync(root), path))

// The argument list of each `new URL(` call, by balanced parentheses.
const newUrlCalls = (text: string) =>
    [...text.matchAll(/\bnew\s+URL\s*\(/g)].map((match) => {
        let depth = 0
        let index = match.index
        do {
            if (text[index] === "(") depth += 1
            if (text[index] === ")") depth -= 1
            index += 1
        } while ((depth > 0 || text[index - 1] !== ")") && index < text.length)
        return text.slice(match.index, index)
    })
const dynamicReferences = files
    .filter(({ file }) => CODE.test(file))
    .flatMap(({ file, text }) =>
        [
            ...[...text.matchAll(NON_LITERAL_LOAD)].map(
                (match) =>
                    text.slice(match.index, match.index + 60).split("\n")[0] ??
                    "",
            ),
            ...newUrlCalls(text).filter((call) =>
                call.includes("import.meta.url"),
            ),
            ...[...text.matchAll(/import\.meta\.glob\b/g)].map(
                ([match]) => match,
            ),
            ...[...text.matchAll(/(["'`])file:[^"'`]*\1/g)].map(
                ([match]) => match,
            ),
        ].map(
            (expression) =>
                `${file}: ${expression.replace(/\s+/g, " ").trim()}`,
        ),
    )

const filesMatching = (pattern: RegExp) =>
    files.filter(({ text }) => pattern.test(text)).map(({ file }) => file)

const companyMentions = files
    .filter(({ file }) => !file.startsWith(HOSTED_DOCS))
    .filter(({ file, text }) =>
        COMPANY.test(
            text
                .split("\n")
                .filter(
                    (line) =>
                        file !== "README.md" || line.trim() !== CREDIT_LINE,
                )
                .join("\n")
                .replace(OWN_SCOPE, "")
                .replace(MAINTAINER_EMAIL, ""),
        ),
    )
    .map(({ file }) => file)
// Hashed so a failure report does not print the key again.
const postHogKeys = files.flatMap(({ file, text }) =>
    [...text.matchAll(POSTHOG_KEY)].map(
        ([key]) =>
            `${file}: sha256:${createHash("sha256").update(key).digest("hex")}`,
    ),
)
// Standing exemptions: the icon build packs the Pro set by name, and its test
// serves a fake package under that name.
const proIconReferences = filesMatching(/@hugeicons-pro/).filter(
    (file) =>
        file !== "scripts/build-icon-map.ts" &&
        file !== "tests/fixtures/hugeicons-pro-fake/package.json",
)
// Standing whole-line exemptions (trimmed): the icon build's root-element
// template and its test's expected markup for a synthetic fixture glyph. The
// rest of both files is scanned like any other.
const SVG_TEMPLATE_LINES = new Set<string>([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a source line, quoted verbatim.
    'scripts/build-icon-map.ts: return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${children}</svg>`',
    'tests/icons/build-icon-map.test.ts: \'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>\',',
])
// The generated map and the Font Awesome brand glyphs hold SVG by design.
const svgLines = files
    .filter(
        ({ file }) =>
            !file.startsWith("src/generated/") &&
            file !== "scripts/icon-fa-glyphs.json",
    )
    .flatMap(({ file, text }) =>
        text
            .split("\n")
            .filter((line) => line.includes("<svg"))
            .map((line) => ({ file, line: `${file}: ${line.trim()}` })),
    )
const svgLiterals = svgLines
    .filter(({ line }) => !SVG_TEMPLATE_LINES.has(line))
    .map(({ file }) => file)

const unlisted = (found: string[], allowed: Set<string>) =>
    [...new Set(found)].filter((entry) => !allowed.has(entry)).sort()

describe("package isolation", () => {
    it("scans the package's own files", () => {
        const scanned = files.map(({ file }) => file)
        expect(scanned).toContain("package.json")
        expect(scanned).toContain("src/env.ts")
        expect(scanned).not.toContain(SELF)
    })

    it("knows whether every file is text or binary", () => {
        expect(unclassified).toEqual([])
    })

    it("references no monorepo package or path outside the package", () => {
        expect([...new Set(monorepoReferences)].sort()).toEqual([])
    })

    it("holds no symlink that leaves the package", () => {
        expect(escapingSymlinks).toEqual([])
    })

    it("compiles no source from outside the package", () => {
        expect(programFiles.some((path) => path.endsWith("/src/env.ts"))).toBe(
            true,
        )
        expect([...new Set(programOutside)].sort()).toEqual([])
    })

    it("loads nothing the import scan cannot follow", () => {
        expect(unlisted(dynamicReferences, ALLOWED_DYNAMIC_REFERENCES)).toEqual(
            [],
        )
    })

    it("names the company that first built it only in allow-listed files", () => {
        expect(unlisted(companyMentions, ALLOWED_COMPANY_MENTIONS)).toEqual([])
    })

    it("ships no PostHog project key or Hugeicons registry token", () => {
        expect(postHogKeys).toEqual([])
        expect(filesMatching(/npm\.hugeicons\.com\/:_authToken/)).toEqual([])
    })

    it("references Hugeicons Pro only from the icon build", () => {
        expect(proIconReferences).toEqual([])
    })

    it("keeps inline SVG in generated icon files", () => {
        expect(unlisted(svgLiterals, ALLOWED_SVG_LITERALS)).toEqual([])
    })

    it("holds no allow-list entry that no longer matches", () => {
        const stale = [
            ...unlisted(
                [...ALLOWED_COMPANY_MENTIONS],
                new Set(companyMentions),
            ),
            ...unlisted([...ALLOWED_SVG_LITERALS], new Set(svgLiterals)),
            ...unlisted(
                [...SVG_TEMPLATE_LINES],
                new Set(svgLines.map(({ line }) => line)),
            ),
            ...unlisted(
                [...ALLOWED_DYNAMIC_REFERENCES],
                new Set(dynamicReferences),
            ),
        ]
        expect(stale).toEqual([])
    })
})
