/**
 * Heading anchors in the form docs.json sites already link to, so a deep
 * link written before a site moved to Margin lands on the same heading.
 *
 * The rule is fitted to anchors read from live sites, not taken from a
 * specification:
 * - quotes are typographic before the slug is made, and are kept:
 *   `agent's` → `agent’s`
 * - whitespace and `. , ; : ! ? ( ) [ ] { } < > ~` and backticks become a
 *   hyphen: `decision.id` → `decision-id`
 * - every other character is kept, including `& @ / $ # _`
 * - hyphen runs collapse and the ends are trimmed: `name - required` →
 *   `name-required`
 * - a repeated heading takes `-2`, `-3`, …
 *
 * `!`, the square, curly and angle brackets and the backtick had no sample;
 * they follow the punctuation they sit beside.
 */

import type { Root } from "mdast"

const usedByDocument = new WeakMap<Root, Set<string>>()

export function headingSlug(root: Root, text: string): string {
    const base =
        text
            .trim()
            .toLowerCase()
            .replace(/(^|[\s([{])"/g, "$1“")
            .replace(/"/g, "”")
            .replace(/(^|[\s([{])'/g, "$1‘")
            .replace(/'/g, "’")
            .replace(/[\s.,;:!?()[\]{}<>~`]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "section"
    const used = usedByDocument.get(root) ?? new Set<string>()
    usedByDocument.set(root, used)
    // Numbered against every anchor handed out, so "Setup", "Setup",
    // "Setup 2" cannot yield `setup-2` twice.
    let slug = base
    for (let repeat = 2; used.has(slug); repeat++) slug = `${base}-${repeat}`
    used.add(slug)
    return slug
}
