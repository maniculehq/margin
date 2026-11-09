# Format text and code safely

Write Markdown and MDX that renders in Margin without an ingestion safety failure. Use this reference when authoring page source or correcting a rejected page.

## Do this

Use this complete MDX page as a formatting example. The four-backtick outer fence displays the page source without terminating at the inner code fence.

````mdx
---
title: Format a page
description: Example of headings, nested lists, tables, and labeled code.
---

Use **bold** for a label, *italics* for emphasis, and `docs.json` for a filename.

## Prepare content

1. Prepare the page.
    - Set the frontmatter title.
    - Add a section heading.
2. Preview the result.

| File | Purpose |
| :--- | ---: |
| `docs.json` | Site configuration |
| `.mdx` | Page content |

## Add code

This TypeScript example prints a greeting, with lines 1 and 3 highlighted.

```ts title="message.ts" {1,3} lines
const name = "Margin"
const message = `Hello, ${name}`
console.log(message)
```

Return to [Prepare content](#prepare-content).
````

## Facts

- Heading markers run from `#` through `######`. Start body sections at `##` when frontmatter supplies the page title.
- Unordered lists use `-`; ordered lists use numbered markers. Indent nested items beneath the parent item's text.
- Tables require a header row and separator row. Separator colons select alignment. Escape a literal pipe as `\|`.
- Same-page links use a heading slug, such as `#keep-mdx-safe`.
- Internal documentation links start with `/`, `./`, or `../` and omit `.md` and `.mdx` extensions. A cross-page heading link appends `#heading-slug`.
- External documentation links use `http://`, `https://`, or `mailto:`.
- Code fences accept a language and `title="…"`. Margin uses Shiki for syntax highlighting.
- Fence metadata `{1,3-5}` highlights line 1 and lines 3 through 5. Line numbering starts at 1.
- Fence metadata `lines` displays line numbers; `wrap` soft-wraps long lines; `expandable` collapses long blocks behind a control.
- A language-appropriate trailing comment containing `[!code highlight]` highlights that line.
- Every fence inside a code group needs its own `title="…"`.
- An unknown fence language renders as plain text with an informational `field_invalid` diagnostic.
- Math is off by default. Setting `styling.latex` to `true` in `docs.json` activates LaTeX rendering with KaTeX.
- Inline math uses `$A = \pi r^2$`. Display math puts `$$` on separate lines around the expression.
- Unknown capitalized components unwrap to their children with a `component_unknown` warning.
- Allowed URL schemes are `http:`, `https:`, `mailto:`, `cursor:`, `vscode:`, and `vscode-insiders:`. Fragments and relative paths are admitted.
- URL checks cover Markdown links, images, reference definitions, and literal URL-bearing JSX attributes.
- An iframe requires a static string `src` starting with `https://`.
- MDX supports expression-valued props. Braces delimit expressions; angle brackets can begin JSX.
- Put `limit <= 100`, `<TOKEN>`, and `{ name: string }` in inline code when those strings are prose. Escape literal prose braces as `\{` and `\}`.

## Not supported

- Raw HTML blocks in plain `.md` files are rejected. Permitted HTML-like elements in `.mdx` are parsed as JSX.
- Denied element names are `script`, `object`, `embed`, `style`, `link`, `meta`, `base`, `frame`, `frameset`, `noscript`, `foreignobject`, `animate`, `set`, `animatemotion`, and `animatetransform`.
- Authored attributes beginning with `on`, attributes beginning with `data-rail`, `srcdoc`, and spread attributes are rejected.
- An iframe cannot use an expression-valued `src` or a non-HTTPS `src`.
- URL schemes such as `javascript:`, `data:`, and `file:` are rejected.
- Math rendering does not run without `styling.latex: true`.

## Verify

Preview the page after ingestion. The example page should show a nested list, a two-column table, and a code block titled `message.ts` with line numbers and lines 1 and 3 highlighted.

A denied construct is a hard ingestion failure. Correct the reported page and line before ingesting again; a `component_unknown` warning instead means the unknown wrapper was removed while its children remained.

## Related

- [Code groups](/content/components/steps-tabs)
- [Format text and links](/content/formatting#format-text-and-links)
- [Write math](/content/formatting#write-math)
- [Keep MDX safe](/content/formatting#keep-mdx-safe)
