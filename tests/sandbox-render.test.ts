import { describe, expect, test } from "vitest"
import { compileDocs } from "@/ingest/compile"
import {
    renderMdxInSandbox,
    SANDBOX_CACHE_MAX_BYTES,
    SANDBOX_MAX_HTML_BYTES,
    sandboxRenderStats,
} from "@/lib/sandbox-render"

/**
 * Compiled-MDX function bodies in the exact shape executeMdxSync feeds
 * `new Function(...)`: `arguments[0]` is the `opts` scope (jsx runtime +
 * hooks) and the body returns the module namespace.
 */
function compiledPage(paragraphExpression: string): string {
    return [
        "const { jsx: _jsx, jsxs: _jsxs } = arguments[0];",
        "function _createMdxContent(props) {",
        '  const _components = { h2: "h2", p: "p", ...props.components };',
        '  return _jsxs("div", { children: [',
        '    _jsx(_components.h2, { id: "hello", children: "Hello" }),',
        `    _jsx(_components.p, { children: ${paragraphExpression} }),`,
        "  ] });",
        "}",
        "return { default: function MDXContent(props = {}) { return _jsx(_createMdxContent, props); } };",
    ].join("\n")
}

/** A ViewGroup of two Views (the shape remark-view-groups emits), each
 * holding one paragraph naming its view. */
const viewGroupPage = [
    "const { jsx: _jsx, jsxs: _jsxs } = arguments[0];",
    "function _createMdxContent(props) {",
    '  const _components = { p: "p", ...props.components };',
    "  return _jsxs(_components.ViewGroup, { children: [",
    '    _jsx(_components.View, { title: "Python", children: _jsx(_components.p, { children: "python body" }) }),',
    '    _jsx(_components.View, { title: "TypeScript", children: _jsx(_components.p, { children: "typescript body" }) }),',
    "  ] });",
    "}",
    "return { default: function MDXContent(props = {}) { return _jsx(_createMdxContent, props); } };",
].join("\n")

const request = new Request("http://sandbox.test/guide")

test.concurrent("renders a compiled MDX expression to HTML", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: compiledPage('"Body " + ("dyn" + "amic") + " expression"'),
        pageUrl: "/guide",
        cacheKey: "v-render:guide",
        variations: null,
        request,
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.message)
    expect(result.html).toContain("<p>Body dynamic expression</p>")
    expect(result.html).toContain('<h2 id="hello"')
})

test.concurrent("a runaway expression fails as a timeout", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: `while (true) {}\n${compiledPage('"never"')}`,
        pageUrl: "/spin",
        cacheKey: "v-timeout:spin",
        variations: null,
        request,
    })
    expect(result).toMatchObject({ ok: false, reason: "timeout" })
})

test.concurrent("site code sees no host globals", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: compiledPage(
            '[typeof process, typeof require, typeof fetch, typeof setTimeout, typeof window].join(",")',
        ),
        pageUrl: "/globals",
        cacheKey: "v-globals:globals",
        variations: null,
        request,
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.html).toContain(
        "<p>undefined,undefined,undefined,undefined,undefined</p>",
    )
})

test.concurrent("a thrown component error is reported, not rendered", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: compiledPage('(() => { throw new Error("boom") })()'),
        pageUrl: "/throw",
        cacheKey: "v-throw:throw",
        variations: null,
        request,
    })
    expect(result).toMatchObject({ ok: false, reason: "throw" })
    if (result.ok) throw new Error("expected a failure")
    expect(result.message).toContain("boom")
})

test.concurrent("output over the HTML ceiling fails as oversized", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: compiledPage(`"x".repeat(${SANDBOX_MAX_HTML_BYTES + 1})`),
        pageUrl: "/oversized",
        cacheKey: "v-oversized:oversized",
        variations: null,
        request,
    })
    expect(result).toMatchObject({ ok: false, reason: "oversized" })
})

test.concurrent("a ViewGroup snapshot shows the configured default view, not the first authored one", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: viewGroupPage,
        pageUrl: "/views",
        cacheKey: "v-views:views",
        // docs.json variations: TypeScript is the first option, so it is
        // the default even though Python is authored first.
        variations: [
            { id: "ts", label: "TypeScript" },
            { id: "py", label: "Python" },
        ],
        request,
    })
    if (!result.ok) throw new Error(result.message)
    // ViewGroup marks inactive views with `hidden` on the wrapper.
    expect(result.html).toMatch(
        /<div data-view-wrapper=""><div data-view="true"><p>typescript body<\/p>/,
    )
    expect(result.html).toMatch(
        /<div data-view-wrapper="" hidden><div data-view="true"><p>python body<\/p>/,
    )
})

test.concurrent("without variations a ViewGroup shows its first view", async () => {
    const result = await renderMdxInSandbox({
        compiledJs: viewGroupPage,
        pageUrl: "/views-plain",
        cacheKey: "v-views:views-plain",
        variations: null,
        request,
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.html).toMatch(
        /<div data-view-wrapper=""><div data-view="true"><p>python body<\/p>/,
    )
})

/**
 * Markup from a JS snippet module and a page-local export, compiled by the
 * real ingest pipeline and rendered in the real isolate. The ingest AST pass
 * never sees these JSX bodies, so only the server boundary (§4.6) can hold
 * them to the page-MDX rules. Every value is an inert marker.
 */
const snippetMarkup = (async () => {
    const compiled = await compileDocs([
        {
            path: "snippets/markers.jsx",
            kind: "text",
            content: `export const Markers = () => (
  <div>
    <p data-marker="allowed" className="allowed-class" style={{ color: "red" }}>
      <a href="https://example.com/ok" target="_blank">ok link</a>
      <a href="#section">fragment</a>
      <img src="/ok.png" alt="ok" />
    </p>
    <span data-marker="handler" dangerouslySetInnerHTML={{ __html: '<b data-marker="handler-inner" onmouseover="void 0">handler</b>' }} />
    <a data-marker="scheme" href="data:,marker">scheme</a>
    <img data-marker="srcset" src="/ok.png" srcSet="https://example.com/a.png 1x, data:image/png;base64,c3Jjc2V0 2x" alt="srcset" />
    <img data-marker="comma-srcset" src="/ok.png" srcSet="https://images.example/resize,width:640/photo.png 640w, /ok.png 1280w" alt="comma srcset" />
    <span data-marker="denied"><style>{".denied-marker{}"}</style>denied sibling</span>
    <iframe data-marker="srcdoc" src="https://example.com/embed" srcDoc="srcdoc-marker" title="embed" />
    <iframe data-marker="insecure-frame" src="http://example.com/embed" title="embed" />
  </div>
)`,
        },
        {
            path: "index.mdx",
            kind: "text",
            content: [
                // Split so the package-isolation scan does not read the
                // MDX import as a filesystem path of this test file.
                ["import { Markers } from", '"/snippets/markers.jsx"'].join(
                    " ",
                ),
                "",
                `export const Local = () => <span data-marker="local" dangerouslySetInnerHTML={{ __html: '<i data-marker="local-inner" onfocus="void 0">local</i>' }} />`,
                "",
                "<Markers />",
                "",
                "<Local />",
            ].join("\n"),
        },
    ])
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
    const compiledJs = compiled.pages[0]?.compiledJs
    if (!compiledJs) throw new Error("expected an executable page")
    const result = await renderMdxInSandbox({
        compiledJs,
        pageUrl: "/markers",
        cacheKey: "v-sanitize:markers",
        variations: null,
        request,
    })
    if (!result.ok) throw new Error(result.message)
    return result.html
})()

describe.concurrent("server-boundary sanitization of snippet output", () => {
    test("keeps the markup page MDX may produce", async () => {
        const html = await snippetMarkup
        expect(html).toContain(
            '<p data-marker="allowed" class="allowed-class" style="color:red">',
        )
        expect(html).toContain(
            '<a href="https://example.com/ok" target="_blank">ok link</a>',
        )
        expect(html).toContain('<a href="#section">fragment</a>')
        expect(html).toMatch(/<img src="\/ok\.png" alt="ok"\/?>/)
    })

    test("removes event-handler attributes from snippet raw HTML", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="handler-inner"')
        expect(html).toContain(">handler</b>")
        expect(html).not.toContain("onmouseover")
    })

    test("removes event-handler attributes from page-local export raw HTML", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="local-inner"')
        expect(html).toContain(">local</i>")
        expect(html).not.toContain("onfocus")
    })

    test("removes URL attributes with a disallowed scheme", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="scheme"')
        expect(html).toContain(">scheme</a>")
        expect(html).not.toContain("data:,marker")
    })

    test("removes a srcset whose later candidate has a disallowed scheme", async () => {
        const html = await snippetMarkup
        expect(html).toMatch(/<img data-marker="srcset" src="\/ok\.png"/)
        expect(html).not.toContain("c3Jjc2V0")
    })

    test("keeps a srcset whose allowed candidate URLs contain commas", async () => {
        const html = await snippetMarkup
        expect(html).toContain(
            'srcset="https://images.example/resize,width:640/photo.png 640w, /ok.png 1280w"',
        )
    })

    test("a flat SVG with 600 self-closed children renders", async () => {
        // In SVG, "/>" self-closes: siblings are not nesting. (\u003c keeps
        // a literal inline-svg tag out of source; isolation.test.ts.)
        const result = await renderMdxInSandbox({
            compiledJs: [
                "const { jsx: _jsx } = arguments[0];",
                'return { default: () => _jsx("div", { dangerouslySetInnerHTML: { __html: "\\u003csvg viewBox=\\"0 0 10 10\\">" + "<rect width=\\"1\\" height=\\"1\\"/>".repeat(600) + "\\u003c/svg>" } }) };',
            ].join("\n"),
            pageUrl: "/flat-svg",
            cacheKey: "v-sanitize:flat-svg",
            variations: null,
            request,
        })
        if (!result.ok) throw new Error(result.message)
        expect(result.html.match(/<rect /g)).toHaveLength(600)
    })

    test("180 flat tables with unclosed sections, rows and cells render", async () => {
        // </table> closes its open tbody/tr/td, so these tables are siblings.
        const result = await renderMdxInSandbox({
            compiledJs: [
                "const { jsx: _jsx } = arguments[0];",
                'return { default: () => _jsx("div", { dangerouslySetInnerHTML: { __html: "<table><tr><td>x</table>".repeat(180) } }) };',
            ].join("\n"),
            pageUrl: "/flat-tables",
            cacheKey: "v-sanitize:flat-tables",
            variations: null,
            request,
        })
        if (!result.ok) throw new Error(result.message)
        expect(result.html.match(/<table>/g)).toHaveLength(180)
    })

    test.for([
        ["unclosed start tags", '"<div>".repeat(600)'],
        // HTML ignores the slash on a non-void start tag: these all open.
        ["slash-ended non-void tags", '"<div/>".repeat(600)'],
        // End tags with no open element close nothing in the parser.
        ["unmatched end tags", '"</span>".repeat(600) + "<div>".repeat(600)'],
        // Nested tables: the parser opens an implied tbody and tr per level.
        ["nested tables with implied sections", '"<table><td>".repeat(200)'],
        ["nested tables", '"<table><tr><td>".repeat(200)'],
        // Outside a table the parser ignores cell tags, so </td> closes nothing.
        ["cell tags outside a table", '"<td><div></td>".repeat(600)'],
        // An HTML tag inside SVG content ends it: what follows is HTML,
        // where "/>" on a non-void tag opens. (\u003c: isolation.test.ts.)
        [
            "HTML after an SVG breakout tag",
            '"\\u003csvg><g><div/>" + "<x-box/>".repeat(600)',
        ],
        [
            "HTML after a font breakout tag",
            '"\\u003csvg><font color=\\"red\\"/>" + "<x-box/>".repeat(600)',
        ],
        [
            "HTML after a </p> in SVG",
            '"\\u003csvg></p>" + "<x-box/>".repeat(600)',
        ],
        // End tags inside comments, raw-text and RCDATA elements are text:
        // they close nothing.
        ["end tags hidden in comments", '"<div><!-- </div> -->".repeat(600)'],
        [
            "end tags hidden in raw text",
            '"<div><textarea></div></textarea>".repeat(600)',
        ],
        // A self-closed svg root in HTML opens no SVG content.
        [
            "HTML after a self-closed svg",
            '"\\u003csvg/>" + "<x-box/>".repeat(600)',
        ],
    ])(
        "markup nested past the depth bound declines: %s",
        async ([label, markup]) => {
            const result = await renderMdxInSandbox({
                compiledJs: [
                    "const { jsx: _jsx } = arguments[0];",
                    `return { default: () => _jsx("div", { dangerouslySetInnerHTML: { __html: ${markup} } }) };`,
                ].join("\n"),
                pageUrl: "/deep",
                cacheKey: `v-sanitize:deep:${label}`,
                variations: null,
                request,
            })
            expect(result).toMatchObject({
                ok: false,
                reason: "throw",
                message: expect.stringContaining("nests deeper than 512"),
            })
        },
    )

    test("drops denied elements with their content", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="denied"')
        expect(html).toContain("denied sibling</span>")
        expect(html).not.toContain("<style")
        expect(html).not.toContain("denied-marker")
    })

    test("removes srcdoc from an https iframe", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="srcdoc"')
        expect(html).toContain('src="https://example.com/embed"')
        expect(html).not.toContain("srcdoc-marker")
    })

    test("drops an iframe whose src is not https", async () => {
        const html = await snippetMarkup
        expect(html).toContain('data-marker="srcdoc"')
        expect(html).not.toContain("insecure-frame")
    })
})

// These read the module-wide evaluation counter and memo footprint, so they
// run after the concurrent batch above has settled and one at a time.
describe("memoization", () => {
    test("a deterministic failure is memoized, not re-evaluated", async () => {
        const input = {
            compiledJs: compiledPage('(() => { throw new Error("again") })()'),
            pageUrl: "/throw-twice",
            cacheKey: "v-memo:throw-twice",
            variations: null,
            request,
        }
        const first = await renderMdxInSandbox(input)
        const { evaluations } = sandboxRenderStats()
        const second = await renderMdxInSandbox(input)
        expect(first).toMatchObject({ ok: false, reason: "throw" })
        expect(second).toEqual(first)
        expect(sandboxRenderStats().evaluations).toBe(evaluations)
    })

    test("an oversized result is memoized as a failure, not as HTML", async () => {
        const input = {
            compiledJs: compiledPage(
                `"y".repeat(${SANDBOX_MAX_HTML_BYTES + 1})`,
            ),
            pageUrl: "/oversized-memo",
            cacheKey: "v-memo:oversized",
            variations: null,
            request,
        }
        const before = sandboxRenderStats()
        await renderMdxInSandbox(input)
        const after = sandboxRenderStats()
        const second = await renderMdxInSandbox(input)
        expect(second).toMatchObject({ ok: false, reason: "oversized" })
        expect(sandboxRenderStats().evaluations).toBe(after.evaluations)
        // The 2 MB body never entered the memo; only a small failure record did.
        expect(after.cacheBytes - before.cacheBytes).toBeLessThan(256)
    })

    test("concurrent misses for one key evaluate once and count once", async () => {
        const input = {
            compiledJs: compiledPage('"z".repeat(300)'),
            pageUrl: "/coalesce",
            cacheKey: "v-memo:coalesce",
            variations: null,
            request,
        }
        const before = sandboxRenderStats()
        const [first, second] = await Promise.all([
            renderMdxInSandbox(input),
            renderMdxInSandbox(input),
        ])
        if (!first.ok) throw new Error(first.message)
        expect(second).toBe(first)
        const after = sandboxRenderStats()
        expect(after.evaluations).toBe(before.evaluations + 1)
        expect(after.cacheEntries).toBe(before.cacheEntries + 1)
        expect(after.cacheBytes - before.cacheBytes).toBe(
            Buffer.byteLength(first.html, "utf8"),
        )
    })

    test("the byte budget evicts the least recently read HTML", async () => {
        // ~2 MB per page (just under the HTML ceiling): one more page than
        // the 64 MB budget holds.
        const large = (index: number) => ({
            compiledJs: compiledPage(`"${index % 10}".repeat(2_000_000)`),
            pageUrl: `/large-${index}`,
            cacheKey: `v-budget:large-${index}`,
            variations: null,
            request,
        })
        const count = Math.floor(SANDBOX_CACHE_MAX_BYTES / 2_000_000) + 1
        expect(await renderMdxInSandbox(large(0))).toMatchObject({ ok: true })
        expect(await renderMdxInSandbox(large(1))).toMatchObject({ ok: true })
        for (let index = 2; index < count; index++) {
            // Page 0 is read between every insert, so page 1 is the oldest.
            await renderMdxInSandbox(large(0))
            expect(await renderMdxInSandbox(large(index))).toMatchObject({
                ok: true,
            })
        }
        const stats = sandboxRenderStats()
        expect(stats.cacheBytes).toBeLessThanOrEqual(SANDBOX_CACHE_MAX_BYTES)
        await renderMdxInSandbox(large(0))
        await renderMdxInSandbox(large(count - 1))
        expect(sandboxRenderStats().evaluations).toBe(stats.evaluations)
        await renderMdxInSandbox(large(1))
        expect(sandboxRenderStats().evaluations).toBe(stats.evaluations + 1)
    }, 60_000)
})
