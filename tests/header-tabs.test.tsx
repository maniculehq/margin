import { FrameworkProvider } from "fumadocs-core/framework"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DocsHeader, SidebarChrome } from "@/components/docs-header"
import { layoutConfigSchema } from "@/lib/source"
import type { TabNode } from "@/types/docs"

/** A stored layout config whose resolved navigation is page groups plus the
 * given tabs: `tabs` are content tabs, `global` the global.tabs entries. */
function layoutConfig(nav: { tabs?: TabNode[]; global?: TabNode[] }) {
    return layoutConfigSchema.parse({
        __resolvedNav: {
            language: null,
            tabs: nav.tabs ?? [],
            anchors: [],
            dropdowns: [],
            versions: [],
            products: [],
            menu: [],
            global: nav.global ? { tabs: nav.global } : null,
        },
    })
}

function render(node: ReactNode): string {
    return renderToStaticMarkup(
        <FrameworkProvider
            usePathname={() => "/"}
            useParams={() => ({})}
            useRouter={() => ({ push() {}, refresh() {} })}
        >
            {node}
        </FrameworkProvider>,
    )
}

const SUPPORT: TabNode = { tab: "Support", href: "https://support.example.com" }

describe("header tab row", () => {
    it("shows a lone link-only global tab in the desktop header", () => {
        const html = render(
            <DocsHeader
                logo="Docs"
                config={layoutConfig({ global: [SUPPORT] })}
                activeTabKey={null}
                themeSwitchEnabled={false}
            />,
        )
        expect(html).toContain('aria-label="Documentation tabs"')
        expect(html).toContain('href="https://support.example.com"')
    })

    it("shows a lone link-only global tab in the sidenav chrome", () => {
        const html = render(
            <SidebarChrome
                logo="Docs"
                config={layoutConfig({ global: [SUPPORT] })}
                activeTabKey={null}
                themeSwitchEnabled={false}
            />,
        )
        expect(html).toContain('aria-label="Documentation"')
        expect(html).toContain('href="https://support.example.com"')
    })

    it("shows a lone menu tab, whose dropdown is the only way to its items", () => {
        const html = render(
            <DocsHeader
                logo="Docs"
                config={layoutConfig({
                    tabs: [
                        {
                            tab: "Products",
                            menu: [{ item: "Billing", href: "/billing" }],
                        },
                    ],
                })}
                activeTabKey={null}
                themeSwitchEnabled={false}
            />,
        )
        expect(html).toContain('aria-label="Documentation tabs"')
        expect(html).toContain("Products")
    })

    it("omits the row for a lone content tab holding the whole navigation", () => {
        const config = layoutConfig({
            tabs: [{ tab: "Guides", resolvedHref: "/guides" }],
        })
        const header = render(
            <DocsHeader
                logo="Docs"
                config={config}
                activeTabKey="tabs:0"
                themeSwitchEnabled={false}
            />,
        )
        expect(header).toContain('id="docs-band"')
        expect(header).not.toContain('aria-label="Documentation tabs"')
        const sidebar = render(
            <SidebarChrome
                logo="Docs"
                config={config}
                activeTabKey="tabs:0"
                themeSwitchEnabled={false}
            />,
        )
        expect(sidebar).toContain("data-sidebar-chrome")
        expect(sidebar).not.toContain('aria-label="Documentation"')
    })
})
