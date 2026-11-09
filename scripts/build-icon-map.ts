/**
 * Renders the committed icon name map into `src/generated/icon-map.ts`, the
 * SVG module the framework reads at build and serve time. The repository
 * holds names only (`icon-map.json`: lucide name → the icon's canonical
 * `<File>Icon` export); the glyphs come from Hugeicons Pro when
 * `HUGEICONS_PRO_TOKEN` is set (fetched from the registry with `fetch`, no
 * package manager involved) and from the MIT-licensed
 * `@hugeicons/core-free-icons` otherwise. Names whose glyph the chosen set
 * lacks are left out, so they render the default icon; the chrome glyphs
 * (`icon-chrome.json`) must resolve in either set.
 *
 * Run with `bun run icons:build`.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { z } from "zod"

const scriptsDir = import.meta.dirname
const outputPath = join(scriptsDir, "../src/generated/icon-map.ts")

const readJson = <T extends z.ZodType>(file: string, schema: T): z.infer<T> =>
    schema.parse(JSON.parse(readFileSync(join(scriptsDir, file), "utf8")))
const stringRecord = z.record(z.string(), z.string())
const iconMap = readJson(
    "icon-map.json",
    z.record(
        z.string(),
        z.object({
            target: z.string(),
            tier: z.string(),
            confidence: z.number(),
        }),
    ),
)
const faSynonyms = readJson("icon-fa-synonyms.json", stringRecord)
const faGlyphs = readJson("icon-fa-glyphs.json", stringRecord)
const chromeNames = readJson("icon-chrome.json", z.array(z.string()))

/** Legacy/Mintlify/FontAwesome-era aliases → canonical lucide name. */
const SYNONYMS: Record<string, string> = {
    gear: "settings",
    cog: "settings",
    "paper-plane": "send",
    envelope: "mail",
    bolt: "zap",
    document: "file-text",
    browser: "app-window",
    window: "app-window",
    "puzzle-piece": "puzzle",
    graph: "chart-line",
    warning: "triangle-alert",
    "exclamation-triangle": "triangle-alert",
    "info-circle": "info",
    "question-circle": "circle-help",
    trash: "trash-2",
    home: "house",
    edit: "pencil",
    close: "x",
    "external-link-alt": "external-link",
}

// ── Load the icon set ────────────────────────────────────────────────────────

const token = process.env.HUGEICONS_PRO_TOKEN
const source = token ? "pro" : "free"
const style = process.env.HUGEICONS_PRO_STYLE ?? "stroke-rounded"
let iconModule: unknown
if (token) {
    // Fetched straight from the registry: no package manager runs, so the
    // token rides only on the request headers to the registry host — never a
    // child process's environment, a log line or a file.
    const registry = new URL(
        process.env.HUGEICONS_PRO_REGISTRY_FOR_TESTS ??
            "https://npm.hugeicons.com/",
    )
    const name = `@hugeicons-pro/core-${style}`
    const authorized = (url: URL) =>
        url.origin === registry.origin
            ? { authorization: `Bearer ${token}` }
            : undefined
    const fetchOk = async (url: URL, headers: Record<string, string>) => {
        const response = await fetch(url, {
            headers: { ...headers, ...authorized(url) },
        })
        if (!response.ok)
            throw new Error(
                `Hugeicons Pro registry answered ${response.status} for ${url.origin}${url.pathname}`,
            )
        return response
    }
    const packument = z
        .object({
            "dist-tags": z.object({ latest: z.string() }),
            versions: z.record(
                z.string(),
                z.object({
                    dist: z.object({
                        tarball: z.url(),
                        integrity: z.string().startsWith("sha512-"),
                    }),
                }),
            ),
        })
        .parse(
            await (
                await fetchOk(new URL(name.replace("/", "%2f"), registry), {
                    accept: "application/vnd.npm.install-v1+json",
                })
            ).json(),
        )
    const latest = packument.versions[packument["dist-tags"].latest]
    if (!latest)
        throw new Error(`Hugeicons Pro registry lists no ${name}@latest`)
    const tarball = new Uint8Array(
        await (await fetchOk(new URL(latest.dist.tarball), {})).arrayBuffer(),
    )
    const digest = createHash("sha512").update(tarball).digest("base64")
    if (`sha512-${digest}` !== latest.dist.integrity)
        throw new Error(`${name} tarball failed its sha512 integrity check`)
    const scratch = mkdtempSync(join(tmpdir(), "icon-map-"))
    try {
        // Gunzip in-process so only `tar` itself must be installed.
        writeFileSync(join(scratch, "package.tar"), gunzipSync(tarball))
        // An explicit env: the token must not reach the child.
        execFileSync("tar", ["xf", "package.tar"], {
            cwd: scratch,
            env: { PATH: process.env.PATH },
        })
        const entry = pathToFileURL(join(scratch, "package/dist/esm/index.js"))
        iconModule = await import(entry.href)
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
} else {
    iconModule = await import("@hugeicons/core-free-icons")
}

// Targets are exact export names: each icon's canonical `<File>Icon` export,
// which both sets share. Bare names are aliases that can point at another
// icon, so nothing here guesses between them.
const iconDataSchema = z.array(
    z.tuple([z.string(), z.record(z.string(), z.string())]),
)
const iconExports = z.record(z.string(), z.unknown()).parse(iconModule)
const iconData = (target: string) => {
    const parsed = iconDataSchema.safeParse(iconExports[target])
    return parsed.success ? parsed.data : null
}

// ── Render ───────────────────────────────────────────────────────────────────

const toSvg = (data: z.infer<typeof iconDataSchema>) => {
    const children = data
        .map(([tag, attrs]) => {
            const attributes = Object.entries(attrs)
                .filter(([key]) => key !== "key")
                .map(
                    ([key, value]) =>
                        `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`,
                )
                .join(" ")
            return `<${tag} ${attributes}/>`
        })
        .join("")
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${children}</svg>`
}

const svgs: Record<string, string> = {}
const gaps: string[] = []
for (const [name, { target }] of Object.entries(iconMap)) {
    const data = iconData(target)
    if (data) svgs[name] = toSvg(data)
    else gaps.push(name)
}

const missingChrome = chromeNames.filter((name) => !(name in svgs))
if (missingChrome.length > 0)
    throw new Error(
        `chrome icon glyphs missing from the ${source} set: ${missingChrome
            .map(
                (name) =>
                    `${name} (${iconMap[name]?.target ?? "not in icon-map.json"})`,
            )
            .join(", ")}`,
    )

// ── Emit ─────────────────────────────────────────────────────────────────────

const entries = (record: Record<string, string>) =>
    Object.entries(record)
        .map(
            ([key, value]) =>
                `    ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
        )
        .join("\n")
const synonyms = Object.fromEntries(
    Object.entries(SYNONYMS).filter(([alias]) => !(alias in iconMap)),
)
mkdirSync(join(scriptsDir, "../src/generated"), { recursive: true })
writeFileSync(
    outputPath,
    `// GENERATED by scripts/build-icon-map.ts — DO NOT EDIT. Regenerate: bun run icons:build
// Source set: ${source === "pro" ? `Hugeicons Pro ${style}` : "Hugeicons Free (@hugeicons/core-free-icons)"}; ${Object.keys(svgs).length} of ${Object.keys(iconMap).length} names rendered.
// DOCS_ICON_FA_SVGS embeds Font Awesome Free glyphs (fontawesome.com),
// licensed CC BY 4.0 — https://fontawesome.com/license/free.

/** Which Hugeicons set rendered this map. */
export const ICON_MAP_SOURCE: "pro" | "free" = ${JSON.stringify(source)}

/** Lucide-vocabulary icon name (kebab) → Hugeicons SVG. Names the set lacks are absent. */
export const DOCS_ICON_SVGS: Record<string, string> = {
${entries(svgs)}
}

/** Legacy/Mintlify/FontAwesome-era aliases → canonical lucide name. */
export const DOCS_ICON_SYNONYMS: Record<string, string> = {
${entries(synonyms)}
}

/** Font Awesome brand glyphs no stroke set depicts, keyed by FA name. */
export const DOCS_ICON_FA_SVGS: Record<string, string> = {
${entries(faGlyphs)}
}

/** FontAwesome icon name/alias → lucide canonical name. */
export const DOCS_ICON_FA_SYNONYMS: Record<string, string> = {
${entries(faSynonyms)}
}
`,
)

console.log(
    `icons:build: ${source} set, ${Object.keys(svgs).length} of ${Object.keys(iconMap).length} icons rendered, ${gaps.length} gaps`,
)
if (gaps.length > 0)
    console.log(`icons:build: gaps (default glyph): ${gaps.join(", ")}`)
