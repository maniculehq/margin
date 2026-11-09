# Customize CSS and layout

Load sanitized site CSS and configure layout dimension tokens in `docs.json`. Use this when theme settings do not cover a styling change.

## Do this

Create `styles.css` beside the existing `docs.json` in the docs root:

```css
:root {
  --color-fd-primary: #7c3aed;
}

.dark {
  --color-fd-primary: #a78bfa;
}

.prose {
  line-height: 1.75;
}
```

Merge this fragment into the existing `docs.json`, preserving unrelated fields. Omit `x-margin.css` to discover stylesheets automatically; these dimension values are examples, not defaults.

```json
{
  "x-margin": {
    "layout": {
      "contentWidth": "1440px",
      "sidebarWidth": "18rem",
      "tocWidth": "16rem",
      "headerHeight": "4rem",
      "tabMode": "top"
    }
  }
}
```

Rebuild or deploy the docs, inspect build diagnostics, and check the published page in both appearances.

## Facts

- Margin discovers all admitted `.css` files under the docs root, including subdirectories, in lexicographic path order.
- `.mintignore` and `.docsignore` exclusions prevent stylesheet admission. Local directory reads skip hidden files and directories apart from supported special files, and do not descend into `node_modules`.
- `x-margin.css` accepts a string path, an array of string paths, or `null`.
- `x-margin.css` paths use `/` separators and must exactly match admitted paths relative to the docs root, such as `styles/overrides.css`.
- Explicit `x-margin.css` paths append files after discovery in configured order. Already discovered files are appended again.
- `x-margin.css: null` disables all site-stylesheet injection, including discovery. Omitting `x-margin.css` restores discovery. An empty array leaves discovery enabled.
- `x-margin.css: null` does not disable framework CSS or generated theme tokens.
- Sanitized site CSS loads after generated theme tokens and can override tokens through the CSS cascade.
- `x-margin.layout.contentWidth` emits `--fd-layout-width`, the overall layout width cap rather than only the article text width.
- `x-margin.layout.sidebarWidth` emits `--fd-sidebar-width` for the sidebar column.
- `x-margin.layout.tocWidth` emits `--fd-toc-width` for the table-of-contents column.
- `x-margin.layout.headerHeight` emits `--fd-header-height`.
- Layout dimensions are strings accepting nonnegative numbers with `px`, `rem`, `em`, `vh`, `vw`, `%`, or `ch`, or `calc(...)` without semicolons, braces, or angle brackets.
- Omitted layout dimensions emit no override; preset, page mode, and responsive layout determine effective defaults.
- Column width settings do not force hidden mobile sidebars or TOCs to appear.
- `x-margin.layout.tabMode` accepts exactly `top` and `auto`; resolved configuration currently defaults to `auto`.
- The authored CSS budget is 262,144 UTF-8 bytes (256 KiB) per content version; explicitly appended files count again. Files exceeding the remaining budget are skipped.
- HTTPS `fonts.googleapis.com` imports are extracted for font resolution; other `@import` rules are removed.
- Local CSS asset references are rewritten to served assets when found. External assets require allowed HTTP or HTTPS hosts; `fonts.googleapis.com` and `fonts.gstatic.com` are allowed by default, and additional hosts use `x-margin.assets.allowExternal`.
- Global layout declarations on simple `:root`, `html`, or `body` selectors are moved to `#nd-docs-layout`; complex global layout rules that cannot be safely scoped are dropped.
- Custom properties remain on original selectors, including `:root` and `.dark`, for inheritance by portal-mounted controls.

## Not supported

- An explicit `x-margin.css` path does not replace discovery or fetch a remote stylesheet.
- Layout dimensions do not accept unitless numbers, negative values, or keywords such as `auto`.
- CSS sanitization removes `behavior`, `-moz-binding`, `expression(...)`, disallowed URLs, and declarations containing a literal `<`.
- An `@font-face` rule with a disallowed source URL is removed.
- CSS cannot install site-authored layout engines, replace framework components with arbitrary executable variants, or load arbitrary external scripts.
- Framework theme presets and page modes do not accept site-authored host code.

## Errors

Diagnostics are build warnings, not HTTP responses.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable | Configured stylesheet missing or dimension invalid | Use an exact admitted docs-root-relative path or an accepted dimension string. |
| `css_oversize` | Not applicable | CSS file exceeds remaining 262,144-byte budget | Reduce authored CSS, including explicitly appended copies. |
| `css_sanitized` | Not applicable | Unsafe CSS removed, syntax recovered, or unparseable CSS skipped | Correct syntax and use permitted declarations, selectors, and asset URLs. |
| `asset_missing` | Not applicable | Local CSS asset reference was not ingested | Include the referenced asset in the admitted docs files and rebuild. |

## Verify

In the published page's browser console, inspect the primary token:

```js
getComputedStyle(document.documentElement)
  .getPropertyValue("--color-fd-primary")
  .trim()
```

The example stylesheet returns `#7c3aed` in light appearance and `#a78bfa` in dark appearance. Inspect article line spacing and build diagnostics if CSS changes do not appear.
