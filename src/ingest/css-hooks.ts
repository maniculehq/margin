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
const ID_HOOKS = new Map(
    Object.entries({
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
        sidebar: "#nd-sidebar, #nd-sidebar-mobile",
        "sidebar-content":
            ":is(#nd-sidebar, #nd-sidebar-mobile) [data-radix-scroll-area-viewport]",
        "table-of-contents": "#nd-toc",
        "table-of-contents-layout": "#nd-toc",
        "table-of-contents-content": "#nd-toc > div",
        "search-bar-entry": "[data-search-pill]",
        "search-bar-entry-mobile": "#nd-subnav [data-search]",
        "assistant-entry": '[data-layout-item="assistant-entry"]',
        "page-context-menu": "[data-page-context-menu]",
        "page-context-menu-button":
            "[data-page-context-menu] > button:first-child",
    }),
)

const SIDEBAR_LABELS =
    ":is(#nd-sidebar, #nd-sidebar-mobile) [data-radix-scroll-area-viewport] :is(p, button)"

/** Class hook (without `.`) → Margin selector. */
const CLASS_HOOKS = new Map(
    Object.entries({
        toc: "#nd-toc",
        "toc-item": "#nd-toc a",
        "sidebar-group-header": SIDEBAR_LABELS,
        "sidebar-title": SIDEBAR_LABELS,
        footer: '[data-layout-item="footer"]',
        steps: ".fd-steps",
        "code-block-copy-button":
            ".code-block-actions > button:not([data-code-action])",
    }),
)

/** Attribute hook, as `name=value` → Margin selector. */
const ATTRIBUTE_HOOKS = new Map(
    Object.entries({
        "data-layout-item=topbar": "#docs-band, #nd-subnav",
        "data-layout-item=sidebar": "#nd-sidebar, #nd-sidebar-mobile",
        "data-layout-item=content": "#nd-page",
        "data-layout-item=side-panel": "#nd-toc",
        "data-layout-item=toc": "#nd-toc",
        "data-layout-item=search-entry":
            "[data-search-pill], #nd-subnav [data-search]",
        "data-component-name=theme-toggle": "[data-theme-toggle]",
        "data-search-item=trigger": "[data-search-pill]",
    }),
)

/**
 * These stylesheets test state by attribute presence (`[data-active]`);
 * Margin's chrome writes `"true"` or `"false"`, so a bare presence selector
 * would match inactive items too.
 */
const PRESENCE_STATES = new Set(["data-active"])

/**
 * A translated hook keeps the weight its author wrote: the targets sit in
 * `:where()`, which weighs nothing, beside a `:not()` of one selector that
 * matches no element and weighs what the hook did. `#navbar` stays an ID
 * and `.toc` a class, so a site's rules still override each other, and
 * Margin's class-based styles, in the order their author expects. The
 * colon cannot appear in a generated heading anchor.
 */
const HOOK_WEIGHT = {
    id: { type: "id", name: "css:hook" },
    class: { type: "class", name: "css:hook" },
    attribute: { type: "attribute", name: "data-css:hook" },
} satisfies Record<string, SelectorComponent>

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
    const translated = (
        target: string,
        weight: SelectorComponent,
    ): SelectorComponent[] => [
        { type: "pseudo-class", kind: "where", selectors: parse(target) },
        { type: "pseudo-class", kind: "not", selectors: [[weight]] },
    ]
    return selector.flatMap((component): SelectorComponent[] => {
        if (component.type === "id") {
            const target = ID_HOOKS.get(component.name)
            return target === undefined
                ? [component]
                : translated(target, HOOK_WEIGHT.id)
        }
        if (component.type === "class") {
            const target = CLASS_HOOKS.get(component.name)
            return target === undefined
                ? [component]
                : translated(target, HOOK_WEIGHT.class)
        }
        if (component.type === "attribute") {
            if (!component.operation && PRESENCE_STATES.has(component.name))
                return [
                    {
                        ...component,
                        operation: { operator: "equal", value: "true" },
                    },
                ]
            if (component.operation?.operator !== "equal") return [component]
            const target = ATTRIBUTE_HOOKS.get(
                `${component.name}=${component.operation.value}`,
            )
            return target === undefined
                ? [component]
                : translated(target, HOOK_WEIGHT.attribute)
        }
        if (
            component.type === "pseudo-class" &&
            (component.kind === "is" ||
                component.kind === "where" ||
                component.kind === "not" ||
                component.kind === "has" ||
                component.kind === "any")
        )
            return [
                {
                    ...component,
                    selectors: component.selectors.map((nested) =>
                        translateCssHooks(nested, parse),
                    ),
                },
            ]
        return [component]
    })
}
