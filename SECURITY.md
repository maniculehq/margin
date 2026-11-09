# Security policy

## Trust model

Content authors — anyone who can commit to the documentation source — are
trusted to run JavaScript in visitors' browsers, just as someone committing
to the site's own code is trusted. Operators accepting untrusted contributions
must review MDX, expressions, and snippets like code before publishing them.

The MDX isolate separates executable content from the server and build host;
it does **not** sandbox the visitor's browser from that content. Ingest compiles
authored code without evaluating it, and executable server snapshots run in the
host-free isolate. In the visitor's browser, executable MDX and snippets have
normal browser capabilities, including computed dynamic `import()`, `fetch`,
and DOM access, subject to the browser's normal origin and security policies.

Data-only pages use stored, sanitized HAST and do not evaluate authored
JavaScript. Pages with executable expressions, dynamic attributes, or local
snippet components use the compiled-JavaScript path: isolated server snapshots
and browser execution. Classification affects the whole page, including raw
HTML handling described below. Neither navigation hiding nor an agent-facing
Markdown representation makes an executable HTML page safe to accept without
code review.

## Reporting a vulnerability

Do not post an exploit, credential, or private content in a public issue.
Report vulnerabilities privately through the repository's private
vulnerability reporting (Security → Report a vulnerability) or by email to
**shreyans@manicule.dev**. Expect an acknowledgement within three business
days and a status update at least weekly until the report is resolved.

Include the affected revision, deployment target, minimal reproduction,
expected boundary, observed behavior, and impact. The unreleased branch is the
current supported target; no stable support schedule has been published yet.

## MDX execution boundary

MDX is executable content. Filename filtering alone cannot make it safe.
The deployment standard's [section 4.6](spec/deployment-standard.md#46-mdx--snippet-execution-safety-contract-inv-2--must)
preserves the original security-contract text. Its older admission restrictions
are not a description of the current compiler; section 4.7 and the rules below
describe the implemented behavior. The host-free isolate boundary still applies.

The MDX AST pass admits the framework's built-in components, locally bound
snippet components, and page-local component exports. Unknown components are
unwrapped to their children with a warning. Expression-valued attributes such
as `<Card title={String(42)}>` are accepted, as are flow/text expressions.
Spread attributes and authored `on*` props (including `onClick`), `srcdoc`, and
reserved `data-rail*` props are rejected in MDX. Denied intrinsic elements and
raw HTML nodes in plain Markdown are rejected too. Literal URL-bearing
attributes and Markdown links/images are checked against the URL-scheme
allow-list; computed attributes
are executable content, not statically verified URLs. Inline SVG is allowed
subject to the intrinsic/attribute rules. An authored iframe requires a static
HTTPS `src` and must pass the other attribute checks.

Imports under `/snippets/` can resolve Markdown/MDX fragments or custom
JS/JSX/TS/TSX components. The latter are compiled and bundled into the page;
they are not evaluated by the database-credentialed ingest process. Their
imports resolved at bundling time are limited to other `/snippets/` modules
and the compiler-provided React JSX runtime. That allow-list does not constrain
computed dynamic imports left in executable code: `import(url)` can survive
bundling without a rejection diagnostic and run in the visitor's browser.
The same browser code can use `fetch` and the DOM. Page-local component exports
use the same compilation path. Unsupported imports that the bundler resolves
are stripped or diagnosed; failed modules produce scoped fallbacks. Variable
substitution stays data-only.

The MDX attribute pass does not apply a complete AST restriction to arbitrary
JavaScript inside a compiled snippet. Snippet logic, including browser-side
behavior defined inside a custom component, must be treated as authored code.
MDX expressions and compiled local components execute in the visitor's browser
on the site's own origin and, for server snapshots, inside the host-free isolate.
They are not trusted as host code. For server article snapshots, compiled MDX
runs only inside an `isolated-vm` V8 isolate loaded with the framework's
self-contained render bundle. The isolate receives no host objects: no
`process`, `require`, `fetch`, timers, DOM, filesystem, or network access.
Each render gets a fresh context and a 250 ms execution timeout
(`SANDBOX_RENDER_TIMEOUT_MS`). The isolate is configured with a 128 MB memory
target (`SANDBOX_MEMORY_LIMIT_MB`), not a hard cap: `isolated-vm` describes its
`memoryLimit` as a guideline, and hostile code can use 2–3 times that target
before termination. Output is limited to 2,097,152 UTF-16 code units
(`SANDBOX_MAX_HTML_BYTES`, despite the identifier's name). The check uses
`html.length`, not encoded byte length; 800,000 `漢` characters occupy 2.4 MB
of UTF-8 and pass when the complete HTML remains below the code-unit ceiling.
Renders are serialized; deterministic failures are memoized, including a memory
failure that disposes the isolate. A failure falls back to client rendering
instead of evaluating content in the server process.

The isolate is a second gate behind ingest validation. It does not replace
that validation or protect the browser from code deliberately authored for the
same site. Publish documentation only on an origin where its authors may run
browser code; do not share that origin with privileged authenticated apps.

## Raw HTML and rendering paths

The static HAST classifier strips `dangerouslySetInnerHTML` and handler
properties from the stored data tree. A data-only page containing
`<div dangerouslySetInnerHTML={{__html: "<img src=x onerror=alert(1)>"}} />`
therefore loses that raw-HTML prop on the static path.

Add an executable expression such as `{String(42)}` and the page instead uses
compiled JavaScript. The HAST stripping pass does not rewrite that executable
output. React honors `dangerouslySetInnerHTML` in the isolate, so the host
sanitizes the HTML the isolate returns before it enters the server document.
It applies the ingest rules from the same constants: denied elements are dropped
with their content, `on*` and `srcdoc` attributes removed, URL attributes kept
only with an allowed scheme, and iframes kept only with an `https:` source. The
example's `onerror` attribute is therefore absent from the server snapshot. The
browser render after hydration still executes the compiled page and keeps the
prop. Authored `on*` props being rejected in the MDX AST is not a guarantee
that raw HTML in the live browser render cannot contain event handlers.

## Other boundaries

CSS is parsed and sanitized before serving. SVGs are reduced to passive image
content before hashing; SVG responses carry a restrictive CSP. Remote asset
fetches follow allow-list and safe-resolution rules. Analytics loaders are
framework-owned and accept data-only provider keys; content cannot choose an
arbitrary executable script origin or container.

The default extension serves one configured site. Custom `DOCS_EXTENSIONS`
modules are trusted server code and run with the deployment's privileges; the
MDX isolate does not sandbox them. Live site status and version-readiness gates
still apply when extensions cache resolution results.

Hidden sidebar entries and robots/content signals are not authorization.
Published content and its machine-readable representations are public. Keep
secrets out of the docs tree, `docs.json`, logs, and generated assets. Use a
separate database for tests and verify remote Postgres TLS certificates. A
private CA can be added with `NODE_EXTRA_CA_CERTS` at process startup.

Changes to these boundaries require review against the deployment standard
and a meaningful regression reproduction.
