import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { fromHtml } from "hast-util-from-html"
import { visit } from "unist-util-visit"
import { describe, expect, it } from "vitest"
import { inlineScriptJson } from "@/lib/shared"

/**
 * Every inline analytics snippet the root route emits must parse: a single
 * syntax error (the PostHog stub once lost its `for(`) throws before any
 * other inline script on the page runs and silently disables the vendor.
 * The snippets are template literals in __root.tsx; interpolations are
 * replaced with a string literal before `node --check`.
 */
describe("inline analytics snippets", () => {
    const source = readFileSync(
        new URL("../src/routes/__root.tsx", import.meta.url),
        "utf8",
    )
    // Scan each template literal that starts with a known snippet opener,
    // honouring nested `${…}` (which may contain their own template
    // literals), and replace every interpolation with a string literal so
    // the remainder is plain JavaScript.
    const snippets: string[] = []
    for (const opener of source.matchAll(
        /`(?=!function|window\.dataLayer|\(function\()/g,
    )) {
        let out = ""
        let depth = 0
        let i = (opener.index ?? 0) + 1
        for (; i < source.length; i++) {
            const ch = source[i]
            if (depth === 0) {
                if (ch === "`") break
                if (ch === "$" && source[i + 1] === "{") {
                    depth = 1
                    i += 1
                    // A value position (after `(`, `,`, `:`, `=`, `+`, `[`)
                    // gets a placeholder literal; a spliced fragment (e.g.
                    // an optional `,api_host:…` tail) is simply dropped.
                    out += /[(,:=+[]\s*$/.test(out) ? '"x"' : ""
                    continue
                }
                out += ch
            } else {
                if (ch === "`") {
                    // Nested template literal inside the interpolation.
                    for (i += 1; i < source.length && source[i] !== "`"; i++)
                        if (source[i] === "\\") i++
                } else if (ch === "{") depth++
                else if (ch === "}") depth--
            }
        }
        snippets.push(out)
    }

    it("finds every vendor's snippet", () => {
        // One opener per vendor, in source order: if the scanner stops
        // matching a snippet, the parse rows below silently lose it.
        expect(snippets.map((snippet) => snippet.slice(0, 40))).toEqual([
            expect.stringMatching(/^!function\(t,e\)\{.*e\.__SV/), // PostHog
            expect.stringContaining('var i="analytics"'), // Segment
            expect.stringMatching(/^\(function\(h,o,t,j,a,r\)/), // Hotjar
            expect.stringMatching(/^window\.dataLayer=/), // Google Analytics
            expect.stringMatching(/^\(function\(f,b\)\{if\(!b\.__SV/), // Mixpanel
        ])
    })

    it.each(snippets.map((s, i) => [i, s] as const))(
        "snippet %i parses as JavaScript",
        (_index, snippet) => {
            const dir = mkdtempSync(join(tmpdir(), "inline-script-"))
            const file = join(dir, "snippet.js")
            writeFileSync(file, snippet)
            expect(() =>
                execFileSync(process.execPath, ["--check", file], {
                    stdio: "pipe",
                }),
            ).not.toThrow()
        },
    )
})

describe("inlineScriptJson", () => {
    it.each([
        ["a script end tag", "</script><script>alert(1)</script>"],
        ["an uppercase end tag", "</SCRIPT ><script>alert(1)</script>"],
        ["a comment opener", "<!--"],
        ["a comment opener before a script tag", "<!--<script>"],
        ["a CDATA end", "]]>"],
        ["U+2028", "a\u2028b"],
        ["U+2029", "a\u2029b"],
        ["an entity as text", "&lt;"],
        ["emoji and right-to-left text", "Docs \u{1F4D8} \u202Eمرحبا"],
        ["a heart", "Docs <3"],
        ["a comparison", "a < b"],
    ])("keeps %s as data", (_label, name) => {
        const json = inlineScriptJson({ name })
        // Parsed the way a browser parses the page: the value stays in one
        // script, and the element after it is still an element.
        const tree = fromHtml(
            // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- the test parses this string; it never reaches a browser, and `json` is the serializer output under test
            `<!doctype html><head><script type="application/ld+json">${json}</script><meta name="after"></head>`,
        )
        const scripts: string[] = []
        let metaParsed = false
        visit(tree, "element", (element) => {
            if (element.tagName === "meta") metaParsed = true
            if (element.tagName !== "script") return
            scripts.push(
                element.children
                    .map((child) => (child.type === "text" ? child.value : ""))
                    .join(""),
            )
        })
        expect(scripts.map((text) => JSON.parse(text))).toEqual([{ name }])
        expect(metaParsed).toBe(true)
        // As a JavaScript expression, the way the analytics snippets embed it.
        expect(runInNewContext(`(${json}).name`)).toBe(name)
        // What an XHTML parser or a pre-ES2019 engine would still act on.
        expect(json).not.toMatch(/[<>&\u2028\u2029]/)
    })
})
