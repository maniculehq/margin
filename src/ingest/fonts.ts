import { z } from "zod"
import type { Diagnostic } from "../types/docs"

/**
 * Resolves stored Google Fonts inputs to `font_css` outside `compileDocs`, so
 * fonts can be refreshed without re-ingesting page content.
 */
export const docsFontInputsSchema = z.object({
    /** Google-resolvable families from docs.json font roles (source-less). */
    families: z.array(
        z.object({ family: z.string(), weight: z.number().optional() }),
    ),
    /** fonts.googleapis.com CSS @import URLs from tenant CSS (already capped). */
    imports: z.array(z.string()),
})
export type DocsFontInputs = z.infer<typeof docsFontInputsSchema>

/** Bound on how many tenant-CSS @imports are resolved — enforced at compile. */
export const MAX_FONT_IMPORTS = 8
const MAX_FONT_CSS_BYTES = 1024 * 1024

/**
 * Resolve every configured family (probing css2 variants broadest→narrowest)
 * and tenant-CSS @import through ONE bounded fetch pass. Requests run
 * concurrently against a per-request timeout, and the inlined rules share an
 * aggregate size budget. Families Google doesn't know produce a warn
 * diagnostic and no CSS (the system fallback stack renders); the served
 * rules are immutable per stored font_css, so only the font binaries load
 * from fonts.gstatic.com at visit time.
 */
export async function resolveFontCss(
    inputs: DocsFontInputs,
): Promise<{ css: string; diagnostics: Diagnostic[] }> {
    const diagnostics: Diagnostic[] = []
    const fontRequests: Array<{ urls: string[]; failure: Diagnostic }> = []
    for (const { family, weight } of inputs.families) {
        const axesVariants =
            weight === undefined
                ? [
                      ":wght@100..900",
                      ":wght@400;500;600;700",
                      ":wght@400;700",
                      "",
                  ]
                : [`:wght@${weight}`, ""]
        fontRequests.push({
            urls: axesVariants.map(
                (axes) =>
                    `https://fonts.googleapis.com/css2?family=${family.replaceAll(" ", "+")}${axes}&display=swap`,
            ),
            failure: {
                code: "field_invalid",
                severity: "warn",
                message: `Font family "${family}" was not found on Google Fonts and has no source URL — the system fallback stack will render.`,
                path: "fonts",
            },
        })
    }
    for (const importUrl of inputs.imports.slice(0, MAX_FONT_IMPORTS)) {
        fontRequests.push({
            urls: [importUrl],
            failure: {
                code: "field_invalid",
                severity: "warn",
                message: `A Google Fonts CSS @import could not be resolved and was removed: ${importUrl}`,
                path: "css",
            },
        })
    }
    const fontResults = await Promise.all(
        fontRequests.map(async (request) => {
            for (const url of request.urls) {
                const response = await fetch(url, {
                    headers: {
                        // Pinned modern-Chrome UA: css2 varies its response
                        // by UA and this shape returns woff2 + unicode-range
                        // rules every current browser can consume.
                        "user-agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    },
                    signal: AbortSignal.timeout(10_000),
                }).catch(() => null)
                if (!response?.ok) continue
                const css = await response.text().catch(() => "")
                // font_css ships inside an inline <style>; "<" never appears
                // in a css2 response, so its presence means something is off.
                if (!css || css.length > 512 * 1024 || css.includes("<"))
                    return null
                return css
            }
            return null
        }),
    )
    const blocks: string[] = []
    let fontCssBytes = 0
    for (const [index, resolved] of fontResults.entries()) {
        const request = fontRequests[index]
        if (!request) continue
        if (resolved && fontCssBytes + resolved.length <= MAX_FONT_CSS_BYTES) {
            fontCssBytes += resolved.length
            blocks.push(resolved)
        } else {
            diagnostics.push(request.failure)
        }
    }
    return { css: [...new Set(blocks)].join("\n"), diagnostics }
}
