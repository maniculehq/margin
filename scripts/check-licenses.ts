/**
 * `bun run check-licenses`: fails when any installed package this framework
 * depends on — directly or transitively, runtime or dev — carries a license
 * outside the allow-list below, declares none, or declares something that is
 * not a valid SPDX expression. Prints one table row per package.
 * `--resolved` prints the dependency graph instead (one tab-separated edge
 * per line: parent, requested name, installed `name@version` or `-`,
 * dependency kind, required/optional), and `--compare <file>` checks this
 * install's graph against one printed that way (CI compares the exported
 * framework with the monorepo).
 *
 * The walk starts at this package's own manifest and follows each
 * package's `dependencies`, `optionalDependencies` and `peerDependencies`
 * through Node's resolution order (the nearest `node_modules/<name>` going
 * up from the dependent package), so it covers exactly the installed
 * closure whether dependencies sit in a local or a hoisted `node_modules`.
 * Optional and peer dependencies that are not installed are skipped (a
 * platform binary for another OS, a peer nothing provides); a missing
 * regular dependency fails the check.
 *
 * License expressions are parsed against the SPDX grammar first: every
 * license and exception ID must be on the SPDX License List
 * (`spdx-ids.json`), operators are upper-case `AND`/`OR`/`WITH`, and
 * anything malformed fails before the policy is consulted. A valid
 * expression passes when `A OR B` has an allowed side, `A AND B` has both,
 * and `A WITH exception` / `A+` when `A` is allowed (an exception only
 * grants permissions).
 *
 * REVIEWED lists the packages that pass despite the policy, each matched on
 * its exact name AND its exact declared license string, so a new package —
 * or a new version that changes its license — fails again until someone
 * reviews it.
 */
import { existsSync, readFileSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"

const ALLOWED = new Set([
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "0BSD",
    "CC0-1.0",
    "OFL-1.1",
    "Unlicense",
    "MPL-2.0",
    "CC-BY-4.0",
])

/** Packages reviewed by hand. `license` is the exact declared string. */
const REVIEWED: Array<{ names: string[]; license: string; reason: string }> = [
    {
        names: ["khroma"],
        license: "(none)",
        reason: "manifest omits the field; its `license` file is MIT",
    },
    {
        names: ["png-js"],
        license: "(none)",
        reason: "manifest omits the field; its LICENSE file is MIT",
    },
    {
        names: ["geist"],
        license: "SIL OPEN FONT LICENSE",
        reason: "non-SPDX spelling; LICENSE.txt is OFL-1.1",
    },
    {
        names: ["pako"],
        license: "(MIT AND Zlib)",
        reason: "Zlib is permissive (OSI-approved); no copyleft",
    },
    {
        names: [
            "glob",
            "lru-cache",
            "minimatch",
            "minipass",
            "path-scurry",
            "@isaacs/nonrecursive-glob-match",
        ],
        license: "BlueOak-1.0.0",
        reason: "Blue Oak Model License: permissive, OSI-approved",
    },
    {
        names: ["argparse"],
        license: "Python-2.0",
        reason: "PSF-style permissive license, OSI-approved",
    },
    {
        // Every platform variant sharp lists in optionalDependencies.
        names: [
            "@img/sharp-libvips-darwin-arm64",
            "@img/sharp-libvips-darwin-x64",
            "@img/sharp-libvips-linux-arm",
            "@img/sharp-libvips-linux-arm64",
            "@img/sharp-libvips-linux-ppc64",
            "@img/sharp-libvips-linux-riscv64",
            "@img/sharp-libvips-linux-s390x",
            "@img/sharp-libvips-linux-x64",
            "@img/sharp-libvips-linuxmusl-arm64",
            "@img/sharp-libvips-linuxmusl-x64",
        ],
        license: "LGPL-3.0-or-later",
        reason: "sharp's prebuilt libvips, dynamically loaded and redistributed unmodified",
    },
    {
        names: ["node-liblzma"],
        license: "LGPL-3.0",
        reason: "optional native binding of just-bash, used unmodified",
    },
    {
        names: ["elkjs"],
        license: "EPL-2.0",
        reason: "mermaid's layout engine; weak file-level copyleft, shipped unmodified",
    },
    {
        names: ["sentry"],
        license: "FSL-1.1-Apache-2.0",
        reason: "Sentry CLI under @sentry/bundler-plugins (declared ID is not SPDX; SPDX spells it FSL-1.1-ALv2): build-time source-map upload only, never shipped",
    },
]

const spdx = z
    .object({
        licenses: z.array(z.string()),
        exceptions: z.array(z.string()),
    })
    .parse(
        JSON.parse(
            readFileSync(join(import.meta.dirname, "spdx-ids.json"), "utf8"),
        ),
    )
// SPDX IDs match case-insensitively; keep the canonical spelling.
const canonical = (ids: string[]) =>
    new Map(ids.map((id) => [id.toLowerCase(), id]))
const SPDX_LICENSES = canonical(spdx.licenses)
const SPDX_EXCEPTIONS = canonical(spdx.exceptions)

export type LicenseVerdict =
    | { valid: false; reason: string }
    | { valid: true; allowed: boolean }

/** Parses an SPDX license expression and applies the allow-list. */
export function evaluateLicense(expression: string): LicenseVerdict {
    const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
    let position = 0
    const fail = (reason: string): never => {
        throw new SyntaxError(reason)
    }
    const take = () => tokens[position++]
    const operator = (token: string | undefined) =>
        token === "AND" || token === "OR" || token === "WITH"

    const simple = (): boolean => {
        const token = take()
        if (token === undefined) fail("expression ends where a license is due")
        if (token === "(") {
            const value = or()
            if (take() !== ")") fail("unbalanced parenthesis")
            return value
        }
        if (token === ")" || operator(token))
            fail(`\`${token}\` where a license ID is due`)
        const id = String(token)
        // A custom reference is valid syntax but never on the allow-list.
        const custom =
            /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/.test(
                id,
            )
        const plus = id.endsWith("+")
        const known = custom
            ? undefined
            : SPDX_LICENSES.get((plus ? id.slice(0, -1) : id).toLowerCase())
        if (!custom && known === undefined)
            fail(`\`${id}\` is not an SPDX license ID`)
        if (tokens[position] === "WITH") {
            position++
            const exception = take()
            if (
                exception === undefined ||
                !SPDX_EXCEPTIONS.has(exception.toLowerCase())
            )
                fail(`\`${exception ?? ""}\` is not an SPDX exception ID`)
        }
        return known !== undefined && ALLOWED.has(known)
    }
    const and = (): boolean => {
        let value = simple()
        while (tokens[position] === "AND") {
            position++
            const right = simple()
            value = value && right
        }
        return value
    }
    const or = (): boolean => {
        let value = and()
        while (tokens[position] === "OR") {
            position++
            const right = and()
            value = value || right
        }
        return value
    }

    try {
        if (tokens.length === 0) fail("empty expression")
        const allowed = or()
        if (position !== tokens.length)
            fail(`unexpected \`${tokens[position]}\``)
        return { valid: true, allowed }
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return { valid: false, reason: error.message }
    }
}

const licenseObject = z.object({ type: z.string() })
const manifestSchema = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    license: z.union([z.string(), licenseObject]).optional(),
    licenses: z.union([z.array(licenseObject), licenseObject]).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    peerDependenciesMeta: z
        .record(z.string(), z.object({ optional: z.boolean().optional() }))
        .optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
})

const KINDS = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
] as const
/** One `--resolved` line: parent, requested name, the installed
 * `name@version` (or `-` when nothing is installed), dependency kind and
 * whether the edge is optional. */
const graphLine = z.tuple([
    z.string().min(1),
    z.string().min(1),
    z.string().regex(/^(?:.+@.+|-)$/),
    z.enum(KINDS),
    z.enum(["required", "optional"]),
])
type Manifest = z.infer<typeof manifestSchema>

if (import.meta.main) {
    const root = resolve(import.meta.dirname, "..")
    const readManifest = async (path: string): Promise<Manifest> =>
        manifestSchema.parse(JSON.parse(await readFile(path, "utf8")))

    /** The package.json `name` resolves to from `fromDir`, or undefined. */
    const resolvePackage = (name: string, fromDir: string) => {
        for (let dir = fromDir; ; dir = dirname(dir)) {
            const candidate = join(dir, "node_modules", name, "package.json")
            if (existsSync(candidate)) return candidate
            if (dirname(dir) === dir) return undefined
        }
    }

    /** The declared license as one string, or `(none)`. */
    const declaredLicense = (manifest: Manifest) => {
        if (typeof manifest.license === "string") return manifest.license.trim()
        if (manifest.license) return manifest.license.type.trim()
        const list = Array.isArray(manifest.licenses)
            ? manifest.licenses
            : manifest.licenses
              ? [manifest.licenses]
              : []
        // The legacy `licenses` array lists alternatives.
        if (list.length > 0) return list.map(({ type }) => type).join(" OR ")
        return "(none)"
    }

    type Row = {
        name: string
        version: string
        license: string
        ok: boolean
        problem?: string
        review?: string
    }
    const rows = new Map<string, Row>()
    const missing: string[] = []

    const queue: Array<{
        dir: string
        manifest: Manifest
        isRoot: boolean
        key: string
    }> = [
        {
            dir: root,
            manifest: await readManifest(join(root, "package.json")),
            isRoot: true,
            key: "(root)",
        },
    ]
    /** Installed package path → its `name@version`. */
    const visited = new Map<string, string>()
    /** Tab-separated graphLine edges, resolved or not. */
    const graph = new Set<string>()

    while (queue.length > 0) {
        const next = queue.shift()
        if (!next) break
        const { dir, manifest, isRoot, key } = next
        const edges = KINDS.flatMap((kind) =>
            kind === "devDependencies" && !isRoot
                ? []
                : Object.keys(manifest[kind] ?? {}).map((name) => ({
                      name,
                      kind,
                      optional:
                          kind === "optionalDependencies" ||
                          (kind === "peerDependencies" &&
                              manifest.peerDependenciesMeta?.[name]
                                  ?.optional === true),
                  })),
        )
        for (const { name, kind, optional } of edges) {
            const edge = (resolved: string) =>
                graph.add(
                    [
                        key,
                        name,
                        resolved,
                        kind,
                        optional ? "optional" : "required",
                    ].join("\t"),
                )
            const found = resolvePackage(name, dir)
            if (!found) {
                // Peers are the dependent's host's to provide.
                if (!optional && kind !== "peerDependencies")
                    missing.push(
                        `${name} (required by ${manifest.name ?? dir})`,
                    )
                edge("-")
                continue
            }
            const path = await realpath(found)
            const known = visited.get(path)
            if (known !== undefined) {
                edge(known)
                continue
            }
            const dependency = await readManifest(path)
            const license = declaredLicense(dependency)
            const version = dependency.version ?? "?"
            const packageName = dependency.name ?? name
            const verdict: LicenseVerdict =
                license === "(none)"
                    ? { valid: false, reason: "declares no license" }
                    : evaluateLicense(license)
            const review =
                verdict.valid && verdict.allowed
                    ? undefined
                    : REVIEWED.find(
                          (entry) =>
                              entry.license === license &&
                              entry.names.includes(packageName),
                      )?.reason
            visited.set(path, `${packageName}@${version}`)
            edge(`${packageName}@${version}`)
            rows.set(`${packageName}@${version}`, {
                name: packageName,
                version,
                license,
                ok: (verdict.valid && verdict.allowed) || review !== undefined,
                problem: verdict.valid
                    ? verdict.allowed
                        ? undefined
                        : "not allowed"
                    : verdict.reason,
                review,
            })
            queue.push({
                dir: dirname(path),
                manifest: dependency,
                isRoot: false,
                key: `${packageName}@${version}`,
            })
        }
    }

    const sorted = [...rows.values()].sort(
        (a, b) =>
            a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    )

    const compareWith = process.argv[process.argv.indexOf("--compare") + 1]
    if (process.argv.includes("--resolved")) {
        console.log([...graph].sort().join("\n"))
    } else if (process.argv.includes("--compare")) {
        // Every resolved edge must match the reference exactly, in both
        // directions; the only omission allowed is an optional edge the
        // reference resolves and this install leaves unresolved.
        if (compareWith === undefined)
            throw new Error("--compare needs the reference graph file")
        const parse = (lines: string[]) =>
            lines
                .filter((line) => line !== "")
                .map((line) => graphLine.parse(line.split("\t")))
        const reference = parse(
            (await readFile(compareWith, "utf8")).split("\n"),
        )
        const own = parse([...graph])
        const resolvedLines = (edges: typeof own) =>
            new Set(
                edges
                    .filter(([, , resolved]) => resolved !== "-")
                    .map((edge) => edge.join("\t")),
            )
        const referenceResolved = resolvedLines(reference)
        const ownResolved = resolvedLines(own)
        const ownLines = new Set(own.map((edge) => edge.join("\t")))
        const ownParents = new Set(own.map(([parent]) => parent))
        const problems: string[] = []
        if (referenceResolved.size === 0)
            problems.push("the reference graph resolves no edges")
        if (ownResolved.size === 0)
            problems.push("this install resolves no edges")
        for (const line of ownResolved)
            if (!referenceResolved.has(line))
                problems.push(`not in the reference: ${line}`)
        for (const edge of reference) {
            const line = edge.join("\t")
            const [parent, name, resolved, kind, optionality] = edge
            if (resolved === "-" || ownResolved.has(line)) continue
            if (!ownParents.has(parent)) continue
            if (
                optionality === "optional" &&
                ownLines.has([parent, name, "-", kind, optionality].join("\t"))
            ) {
                console.log(
                    `check-licenses: optional edge only the reference resolves: ${line}`,
                )
                continue
            }
            problems.push(`missing from this install: ${line}`)
        }
        if (problems.length > 0) {
            console.error(
                `check-licenses: the dependency graph differs from ${compareWith}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
            )
            process.exitCode = 1
        } else
            console.log(
                `check-licenses: all ${ownResolved.size} resolved edges match ${compareWith}`,
            )
    } else {
        const failures = sorted.filter((row) => !row.ok)
        const counts = new Map<string, number>()
        for (const row of sorted)
            counts.set(row.license, (counts.get(row.license) ?? 0) + 1)
        const summary = [...counts.entries()].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )

        const cell = (value: string) => value.replaceAll("|", "\\|")
        const table = [
            "| Package | Version | License |",
            "| --- | --- | --- |",
            ...sorted.map(
                (row) =>
                    `| ${cell(row.name)} | ${cell(row.version)} | ${cell(row.license)}${row.review ? " (reviewed)" : row.ok ? "" : ` (${row.problem})`} |`,
            ),
        ].join("\n")

        console.log(table)
        console.log(
            `\ncheck-licenses: ${sorted.length} packages; ${summary.map(([license, count]) => `${license} ${count}`).join(", ")}`,
        )

        if (failures.length > 0) {
            console.error(
                `check-licenses: packages without an allowed license:\n${failures.map((row) => `  ${row.name}@${row.version}: ${row.license} (${row.problem})`).join("\n")}`,
            )
        }
        if (failures.length === 0 && missing.length === 0)
            console.log("check-licenses: every license is allowed")
        if (failures.length > 0) process.exitCode = 1
    }

    if (missing.length > 0) {
        console.error(
            `check-licenses: dependencies are not installed (run \`bun install\`):\n${missing.map((entry) => `  ${entry}`).join("\n")}`,
        )
        process.exitCode = 1
    }
}
