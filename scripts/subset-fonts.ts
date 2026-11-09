/**
 * Emits the framework's default webfonts as per-script subsets plus the
 * metric-compatible fallback faces that make `font-display: swap` shift-free.
 *
 *     bun scripts/subset-fonts.ts
 *
 * Inputs (committed, never shipped): scripts/fonts-source/InterVariable.woff2
 * (rsms/inter) and scripts/fonts-source/GeistMonoVariable.woff2 (a verbatim
 * copy of the `geist` package's dist/fonts/geist-mono/GeistMono-Variable.woff2),
 * each next to its SIL OFL 1.1 license text. Outputs (committed, regenerated
 * idempotently — same inputs produce byte-identical files):
 *
 *   src/assets/InterVariable-{latin,latin-ext,cyrillic,greek,vietnamese}.woff2
 *   src/assets/GeistMonoVariable-latin.woff2
 *   src/styles/fonts.css
 *
 * docs/fonts.md covers the licenses and when to rerun this.
 *
 * Why: the unsubsetted Inter file is 352 KB with no `unicode-range`, so every
 * visitor downloaded every script before the swap; Lighthouse attributed
 * ~0.13–0.16 CLS to that swap. Splitting on Google Fonts' standard subset
 * tables (embedded below — the same ranges css2 serves for Inter) lets the
 * browser fetch only the ranges the page uses, and the latin subset is small
 * enough to `<link rel="preload">` from the root route. Variable axes are
 * preserved (no `variationAxes` pinning) so `font-weight: 100 900` keeps
 * working.
 *
 * The fallback faces use fontaine's formula against @capsizecss/metrics data
 * for the system fonts (Arial for Inter, Courier New for Geist Mono):
 * size-adjust matches average glyph width so wrapped line counts agree, and
 * the ascent/descent/line-gap overrides (divided by size-adjust, since they
 * scale with the adjusted em) match line box heights. xWidthAvg for the
 * subset is computed with @capsizecss/unpack — the same frequency-weighted
 * average capsize used for the fallback metrics — rather than OS/2
 * xAvgCharWidth, which averages every glyph in the file and is not comparable
 * to capsize's number.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import arial from "@capsizecss/metrics/arial"
import courierNew from "@capsizecss/metrics/courierNew"
import { fromBuffer } from "@capsizecss/unpack"
import subsetFont from "subset-font"

const sourceDirectory = resolve(import.meta.dir, "fonts-source")
const assetsDirectory = resolve(import.meta.dir, "../src/assets")
const cssPath = resolve(import.meta.dir, "../src/styles/fonts.css")

/**
 * Google Fonts' subset tables as served by css2 for Inter (Chrome UA). Kept
 * verbatim so our `unicode-range` declarations match what browsers already
 * know how to pick between; `latin` is the range the root route preloads.
 */
const GOOGLE_SUBSETS = {
    latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    "latin-ext":
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
    greek: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF",
    vietnamese:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
} as const satisfies Record<string, string>
type GoogleSubset = keyof typeof GOOGLE_SUBSETS

interface FontJob {
    /** CSS family name the app's --font-* tokens reference. */
    family: string
    /** Basename of the source and emitted files (`<stem>-<subset>.woff2`). */
    stem: string
    /** Variable wght axis range declared on every emitted face. */
    weight: string
    subsets: readonly GoogleSubset[]
    fallback: {
        family: string
        local: string
        metrics: {
            ascent: number
            descent: number
            lineGap: number
            unitsPerEm: number
            xWidthAvg: number
        }
    }
}

const JOBS: readonly FontJob[] = [
    {
        family: "InterVariable",
        stem: "InterVariable",
        weight: "100 900",
        subsets: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
        fallback: { family: "InterFallback", local: "Arial", metrics: arial },
    },
    {
        family: "GeistMono",
        stem: "GeistMonoVariable",
        weight: "100 900",
        subsets: ["latin"],
        fallback: {
            family: "GeistMonoFallback",
            local: "Courier New",
            metrics: courierNew,
        },
    },
]

/** Expands a `unicode-range` value into the string of code points it names. */
function charactersOf(unicodeRange: string): string {
    let text = ""
    for (const token of unicodeRange.split(",")) {
        const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(token.trim())
        if (!match?.[1]) throw new Error(`Malformed unicode-range: ${token}`)
        const start = Number.parseInt(match[1], 16)
        const end = match[2] ? Number.parseInt(match[2], 16) : start
        for (let codePoint = start; codePoint <= end; codePoint++) {
            // Surrogate halves are not scalar values; none of the tables
            // above touch them, but guard anyway so fromCodePoint can't throw.
            if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
            text += String.fromCodePoint(codePoint)
        }
    }
    return text
}

/** Formats a ratio as a CSS percentage with enough precision to be exact. */
function percent(ratio: number): string {
    return `${(ratio * 100).toFixed(4).replace(/\.?0+$/, "")}%`
}

await mkdir(assetsDirectory, { recursive: true })

const css: string[] = [
    "/*",
    " * GENERATED by scripts/subset-fonts.ts — do not edit; rerun",
    " * `bun scripts/subset-fonts.ts` after changing the sources in",
    " * scripts/fonts-source/. Per-script subsets of the default webfonts plus",
    " * metric-compatible local() fallbacks (fontaine formula) so the swap from",
    " * the fallback to the webfont does not shift layout.",
    " */",
]

for (const job of JOBS) {
    const source = await readFile(resolve(sourceDirectory, `${job.stem}.woff2`))
    let latin: Buffer | null = null
    for (const subset of job.subsets) {
        const buffer = await subsetFont(
            source,
            charactersOf(GOOGLE_SUBSETS[subset]),
            {
                targetFormat: "woff2",
                // Keep the license description and URL name records: the OFL
                // must travel with every served copy of the font.
                preserveNameIds: [13, 14],
            },
        )
        const fileName = `${job.stem}-${subset}.woff2`
        await writeFile(resolve(assetsDirectory, fileName), buffer)
        if (subset === "latin") latin = buffer
        console.log(
            `${fileName.padEnd(36)} ${(buffer.byteLength / 1024).toFixed(1).padStart(7)} KB`,
        )
        css.push(
            "",
            `/* ${subset} */`,
            "@font-face {",
            `    font-family: "${job.family}";`,
            `    src: url("../assets/${fileName}") format("woff2");`,
            `    font-weight: ${job.weight};`,
            "    font-display: swap;",
            // Wrapped the way biome formats declarations past its 80-column
            // line width so the generated file passes `biome check` as is.
            ...(`    unicode-range: ${GOOGLE_SUBSETS[subset]};`.length > 80
                ? ["    unicode-range:", `        ${GOOGLE_SUBSETS[subset]};`]
                : [`    unicode-range: ${GOOGLE_SUBSETS[subset]};`]),
            "}",
        )
    }
    if (!latin) throw new Error(`${job.family}: no latin subset emitted`)

    // Metrics come from the latin subset that actually ships; the subsetter
    // keeps hhea/OS/2 vertical metrics intact, so these equal the source's.
    const web = await fromBuffer(latin)
    const { metrics: fallback } = job.fallback
    const sizeAdjust =
        web.xWidthAvg /
        web.unitsPerEm /
        (fallback.xWidthAvg / fallback.unitsPerEm)
    const ascent = web.ascent / web.unitsPerEm / sizeAdjust
    const descent = Math.abs(web.descent) / web.unitsPerEm / sizeAdjust
    const lineGap = web.lineGap / web.unitsPerEm / sizeAdjust
    css.push(
        "",
        `/* ${job.family} → local ${job.fallback.local}, metric-matched */`,
        "@font-face {",
        `    font-family: "${job.fallback.family}";`,
        `    src: local("${job.fallback.local}");`,
        `    size-adjust: ${percent(sizeAdjust)};`,
        `    ascent-override: ${percent(ascent)};`,
        `    descent-override: ${percent(descent)};`,
        `    line-gap-override: ${percent(lineGap)};`,
        "}",
    )
}

await writeFile(cssPath, `${css.join("\n")}\n`)
console.log(`wrote ${cssPath}`)
