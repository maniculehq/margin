import type { ThemeTokens } from "@/types/docs"

/**
 * Site CSS that locks horizontal overflow on `body`/`html` (a common
 * `body { overflow-x: hidden }`) turns the body into the
 * scroll container, which breaks `position: sticky` on the header band and
 * the sidebar/TOC rails. Strip those declarations from root-element rules
 * and re-express the intent as `html { overflow-x: clip }` — clip hides the
 * horizontal overflow without creating a scroll container.
 */
export function rewriteRootOverflowLock(css: string): string {
    let rewritten = false
    const out = css.replace(
        /(?<=^|[};])(\s*)((?:html|body|:root)(?:\s*,\s*(?:html|body|:root))*)(\s*)\{([^{}]*)\}/g,
        (match, lead: string, selector: string, gap: string, body: string) => {
            const stripped = body.replace(
                /\s*overflow-x\s*:\s*(?:hidden|clip)\s*(?:!important)?\s*;?/gi,
                "",
            )
            if (stripped === body) return match
            rewritten = true
            return `${lead}${selector}${gap}{${stripped}}`
        },
    )
    return rewritten ? `${out}html{overflow-x:clip}` : out
}

/**
 * Render the resolved token data as the inline `:root{…}.dark{…}` block. The
 * already-sanitized site stylesheet follows it from /_theme/<hash>.css
 * (source.ts siteCss), so site rules keep the final cascade say.
 */
export function renderThemeStyle(tokens: ThemeTokens): string {
    const light: string[] = []
    const dark: string[] = []
    for (const [name, value] of Object.entries(tokens)) {
        if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue
        if (typeof value === "string") {
            if (/[<>{};]/.test(value)) continue
            light.push(`${name}:${value}`)
        } else {
            if (/[<>{};]/.test(value.light) || /[<>{};]/.test(value.dark))
                continue
            light.push(`${name}:${value.light}`)
            dark.push(`${name}:${value.dark}`)
        }
    }
    return `:root{${light.join(";")}}.dark{${dark.join(";")}}`
}
