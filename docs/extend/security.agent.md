# Understand the content execution boundary

Author site MDX that can render without access to the documentation server's host capabilities. Use these constraints when writing expressions or snippets and diagnosing ingestion rejection or server fallback output.

## Facts

- Site-authored MDX expressions and supported snippet code are untrusted; site code receives no server filesystem, network clients, environment variables, or application objects.
- Trusted framework code renders data-only page trees on the host without executing site-authored JavaScript.
- Pages with dynamic expressions or JavaScript snippet bindings use an isolated server render path.
- Trusted host extensions belong to a separate trust boundary and do not execute inside the content sandbox.
- Compiled MDX also executes in the visitor's browser after hydration; server isolation is not browser isolation.
- Ingestion checks the MDX syntax tree before rendering.
- Ordinary Markdown, fragments, permitted lowercase HTML, built-in components, and supported snippet bindings can pass ingestion checks.
- Unknown capitalized components and unsupported built-in members emit `component_unknown`; ingestion replaces the unknown component with its children and discards the wrapper's attributes and layout.
- Imports under `/snippets/` are processed before the allow-list; supported imported component bindings can be used in the page.
- Unsupported imports and exports remaining after snippet processing emit `esm_stripped` and are removed; references to removed bindings can fail later.
- Built-in member syntax is limited to `Tree.File`, `Tree.Folder`, `FileTree.File`, `FileTree.Folder`, `Color.Item`, `Color.Row`, and `GitHub.Repo`; snippet-bound components can define their own members.
- An authored `iframe` requires a static string `src` beginning with `https://`.
- Literal URL-bearing JSX attributes and Markdown links, images, and reference definitions are checked for accepted URL schemes.
- Accepted URL schemes are `http`, `https`, `mailto`, `cursor`, `vscode`, and `vscode-insiders`; relative URLs and same-page anchors are accepted. Element-specific restrictions still apply.
- Each isolated page render receives a fresh context; site globals do not persist into another page render.
- Site render execution has a 250 ms wall-clock timeout, not a CPU-time quota.
- The isolate heap cap is 128 MB.
- The HTML output limit is 2,097,152 UTF-16 code units, enforced using JavaScript string length rather than encoded bytes.
- Snapshot sanitization checks a maximum HTML nesting depth of 512 elements; the conservative check can reject markup before full parsing.
- Server rendering does not run React effects.
- Successful isolate output is sanitized before serving: denied elements and their contents are dropped, inline event handlers and `srcdoc` are removed, URL-bearing attributes are checked, and iframes require HTTPS sources.
- The renderer's image-preload link is an exception to the general ban on `link` elements.
- A declined compiled-JavaScript server render uses sanitized HTML derived from stored processed Markdown, never site code executed on the host.
- Fallback output preserves readable Markdown prose, headings, lists, and code; component wrappers become children, with literal titles, labels, or field names retained as lead text where available.
- Fallback rendering removes imports, exports, raw HTML, and expressions other than statically evaluable strings or numbers.
- Readers without JavaScript retain the static fallback article; browser hydration replaces the snapshot with live MDX when JavaScript runs.
- Essential instructions and expected results should be Markdown children rather than generated expressions so fallback output remains useful.
- Code intended for readers to execute belongs inside fenced code blocks rather than executable MDX.

## Not supported

- Site code cannot access server `process`, `require`, `fetch`, timers, DOM, or filesystem APIs inside the render isolate.
- Ingestion rejects spread attributes, attributes beginning with `on` case-insensitively, `srcdoc`, and attributes beginning with `data-rail`.
- Ingestion rejects `script`, `object`, `embed`, `style`, `link`, `meta`, `base`, `frame`, `frameset`, `noscript`, `foreignObject`, `animate`, `set`, `animateMotion`, and `animateTransform` elements. Inline SVG is otherwise permitted.
- Ingestion rejects raw HTML blocks in plain `.md` files and disallowed URL schemes.
- Ingestion rejects computed iframe sources and non-HTTPS iframe sources.
- Policy violations reject the content update; the render fallback does not repair ingestion rejection.
- Fallback output cannot preserve component interactivity or recreate computed content omitted from stored Markdown.
- The 250 ms server execution timeout does not impose a browser execution limit or disable browser MDX execution after server rendering failure.

## Errors

These identifiers describe server render outcomes, not HTTP response status codes. Each declined render uses the stored-Markdown fallback.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `timeout` | Not specified | Site execution exceeds its timeout. | Reduce render-time computation; keep essential prose static. |
| `memory` | Not specified | Site execution causes the isolate to be disposed for exceeding its memory limit. | Reduce render-time allocations. |
| `oversized` | Not specified | HTML exceeds 2,097,152 UTF-16 code units. | Reduce generated markup. |
| `throw` | Not specified | Site execution throws, or sanitization fails, including excessive nesting. | Fix the expression or snippet; reduce nesting when applicable. |
| `unavailable` | Not specified | The isolated runtime cannot load or initialize. | Restore runtime availability; keep readable static content for fallback. |

## Related

[Distinguish trusted host extensions from site content](/extend/extensions)
