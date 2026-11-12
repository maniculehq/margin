/**
 * Stylesheet hooks that are translated to Margin's markup.
 *
 * Site stylesheets written against docs.json conventions target a common
 * set of hooks (`#navbar`, `.toc-item`, `[data-layout-item="sidebar"]`).
 * Margin emits the component hooks (`.card`,
 * `[data-component-part="card-title"]`) and the page regions it renders
 * itself in the DOM under those names. The hooks below cannot be emitted
 * that way, so the CSS sanitizer rewrites them:
 *
 * - Every ID hook. Heading anchors share the page's ID namespace, so a
 *   `## Sidebar` heading would collide with a real `id="sidebar"`.
 * - Regions the layout library renders (sidebar, table of contents, mobile
 *   header), which take no extra attributes.
 *
 * A hook in this table is not emitted under the same name by the markup
 * Margin renders for every site.
 */

import type { Selector, SelectorComponent } from "lightningcss"

/** ID hook (without `#`) → Margin selector. */
const ID_HOOKS: Record<string, string> = {
    "body-content": "#nd-docs-layout",
    "content-area": "#nd-page",
    content: "#nd-page .mdx-content",
    header: '#nd-page [data-layout-item="page-header"]',
    "page-title": '#nd-page [data-layout-item="page-header"] h1',
    banner: '[data-layout-item="banner"]',
    footer: '[data-layout-item="footer"]',
    pagination: '[data-layout-item="pagination"]',
    navbar: "#docs-band, #nd-subnav",
    "topbar-cta-button": ".navbar-link > a[data-primary]",
    sidebar: "#nd-sidebar",
    "sidebar-content": "#nd-sidebar [data-radix-scroll-area-viewport]",
    "table-of-contents": "#nd-toc",
    "table-of-contents-layout": "#nd-toc",
    "table-of-contents-content": "#nd-toc > div",
    "search-bar-entry": "[data-search-pill]",
    "search-bar-entry-mobile": "#nd-subnav [data-search]",
    "assistant-entry": '[data-layout-item="assistant-entry"]',
    "page-context-menu": "[data-page-context-menu]",
    "page-context-menu-button": "[data-page-context-menu] > button:first-child",
}

/** Class hook (without `.`) → Margin selector. */
const CLASS_HOOKS: Record<string, string> = {
    toc: "#nd-toc",
    "toc-item": "#nd-toc a",
    "sidebar-group-header":
        "#nd-sidebar [data-radix-scroll-area-viewport] p, #nd-sidebar [data-radix-scroll-area-viewport] button",
    "sidebar-title":
        "#nd-sidebar [data-radix-scroll-area-viewport] p, #nd-sidebar [data-radix-scroll-area-viewport] button",
    footer: '[data-layout-item="footer"]',
    steps: ".fd-steps",
    "code-block-copy-button":
        ".code-block-actions > button:not([data-code-action])",
}

/** Attribute hook, as `name=value` → Margin selector. */
const ATTRIBUTE_HOOKS: Record<string, string> = {
    "data-layout-item=topbar": "#docs-band, #nd-subnav",
    "data-layout-item=sidebar": "#nd-sidebar",
    "data-layout-item=content": "#nd-page",
    "data-layout-item=side-panel": "#nd-toc",
    "data-layout-item=toc": "#nd-toc",
    "data-layout-item=search-entry":
        "[data-search-pill], #nd-subnav [data-search]",
    "data-component-name=theme-toggle": "[data-theme-toggle]",
    "data-search-item=trigger": "[data-search-pill]",
}

/**
 * These stylesheets test state by attribute presence (`[data-active]`);
 * Margin's chrome writes `"true"` or `"false"`, so a bare presence selector
 * would match inactive items too.
 */
const PRESENCE_STATES = new Set(["data-active"])

/**
 * An ID selector that matches nothing. Listing it inside `:is()` keeps a
 * translated ID hook at ID specificity whichever branch matches, so the
 * site's rule still outranks Margin's class-based styles as its author
 * expects. A generated heading anchor never contains a colon.
 */
const ID_SPECIFICITY: Selector = [{ type: "id", name: "css:hook" }]

export type CssHookParser = (selectorList: string) => Selector[]

/**
 * Rewrites the hooks in one selector, including those nested in
 * `:is()`, `:not()`, `:has()` and `:where()`. `parse` turns a Margin
 * selector list into the parser's selector tree.
 */
export function translateCssHooks(
    selector: Selector,
    parse: CssHookParser,
): Selector {
    return selector.map((component): SelectorComponent => {
        if (component.type === "id") {
            const target = ID_HOOKS[component.name]
            if (target === undefined) return component
            return {
                type: "pseudo-class",
                kind: "is",
                selectors: [...parse(target), ID_SPECIFICITY],
            }
        }
        if (component.type === "class") {
            const target = CLASS_HOOKS[component.name]
            if (target === undefined) return component
            return {
                type: "pseudo-class",
                kind: "is",
                selectors: parse(target),
            }
        }
        if (component.type === "attribute") {
            if (!component.operation && PRESENCE_STATES.has(component.name))
                return {
                    ...component,
                    operation: { operator: "equal", value: "true" },
                }
            if (component.operation?.operator !== "equal") return component
            const target =
                ATTRIBUTE_HOOKS[
                    `${component.name}=${component.operation.value}`
                ]
            if (target === undefined) return component
            return {
                type: "pseudo-class",
                kind: "is",
                selectors: parse(target),
            }
        }
        if (
            component.type === "pseudo-class" &&
            (component.kind === "is" ||
                component.kind === "where" ||
                component.kind === "not" ||
                component.kind === "has" ||
                component.kind === "any")
        )
            return {
                ...component,
                selectors: component.selectors.map((nested) =>
                    translateCssHooks(nested, parse),
                ),
            }
        return component
    })
}
