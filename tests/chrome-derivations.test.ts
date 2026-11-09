import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { getBreadcrumbItems } from "fumadocs-core/breadcrumb"
import { flattenTree } from "fumadocs-core/page-tree"
import { expect, test, vi } from "vitest"
import { db, schema } from "@/db"
import { orderedPages, pageBreadcrumbs } from "@/lib/agent-content"
import {
    resolveDocsContext,
    serveLayoutConfig,
    treeDerivations,
} from "@/lib/source"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

/** Seed one ready production version and point the site at it. */
async function seedSite(input: {
    config: Record<string, unknown>
    pages?: Array<{ path: string; slugs: string[]; title: string }>
    metas?: Array<{ path: string; data: Record<string, unknown> }>
    repo?: { owner: string; name: string }
}): Promise<{ siteId: string; hostname: string }> {
    const siteId = randomUUID()
    const versionId = randomUUID()
    const slug = `chrome-${siteId}`
    await db.transaction(async (transaction) => {
        await transaction.insert(schema.docsSite).values({
            id: siteId,
            slug,
            name: "Chrome derivations",
            analyticsMode: "off",
            status: "active",
            repoOwner: input.repo?.owner ?? null,
            repoName: input.repo?.name ?? null,
        })
        await transaction.insert(schema.docsContentVersion).values({
            id: versionId,
            siteId: siteId,
            commitSha: "chrome",
            seq: 1,
            status: "ready",
            searchCorpus: new Uint8Array(0),
            config: input.config,
        })
        if (input.pages?.length)
            await transaction.insert(schema.docsPage).values(
                input.pages.map((page) => ({
                    id: randomUUID(),
                    versionId,
                    siteId: siteId,
                    path: page.path,
                    url: `/${page.slugs.join("/")}`,
                    servedUrl: `/${page.slugs.join("/")}`,
                    slugs: page.slugs,
                    title: page.title,
                    frontmatter: {},
                    source: `# ${page.title}\n`,
                    processedMarkdown: `# ${page.title}\n`,
                    structuredData: { headings: [], contents: [] },
                    toc: [],
                    lastModified: new Date("2026-09-01T00:00:00.000Z"),
                })),
            )
        if (input.metas?.length)
            await transaction.insert(schema.docsMeta).values(
                input.metas.map((meta) => ({
                    id: randomUUID(),
                    versionId,
                    path: meta.path,
                    data: meta.data,
                })),
            )
        await transaction
            .update(schema.docsSite)
            .set({ currentVersionId: versionId })
            .where(eq(schema.docsSite.id, siteId))
    })
    return {
        siteId,
        hostname: siteHost(slug),
    }
}

async function dropSite(siteId: string) {
    await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
}

const nestedTree = {
    config: { name: "Nested" },
    pages: [
        { path: "index.mdx", slugs: [], title: "Home" },
        { path: "guide/intro.mdx", slugs: ["guide", "intro"], title: "Intro" },
        {
            path: "guide/deep/advanced.mdx",
            slugs: ["guide", "deep", "advanced"],
            title: "Advanced",
        },
        { path: "reference.mdx", slugs: ["reference"], title: "Reference" },
    ],
    metas: [
        { path: "guide/meta.json", data: { title: "Guide" } },
        { path: "guide/deep/meta.json", data: { title: "Deep Dive" } },
    ],
}

test.skipIf(!hasDocsDb).concurrent(
    "memoized breadcrumbs match fumadocs' tree walk for every page",
    async () => {
        const { siteId, hostname } = await seedSite(nestedTree)
        try {
            const ctx = await resolveDocsContext(requestFor(hostname))
            for (const page of ctx.allPages) {
                expect(pageBreadcrumbs(ctx, page)).toEqual(
                    getBreadcrumbItems(page.url, ctx.source.getPageTree(), {
                        includePage: false,
                    }).map((item) => ({
                        name:
                            typeof item.name === "string"
                                ? item.name
                                : String(item.name),
                        url: item.url,
                    })),
                )
            }
            const advanced = ctx.allPages.find(
                (page) => page.url === "/guide/deep/advanced",
            )
            if (!advanced) throw new Error("advanced page not served")
            expect(
                pageBreadcrumbs(ctx, advanced).map((crumb) => crumb.name),
            ).toEqual(["Guide", "Deep Dive"])
        } finally {
            await dropSite(siteId)
        }
    },
)

test.skipIf(!hasDocsDb).concurrent(
    "page order is sidebar order, built once per loader",
    async () => {
        const { siteId, hostname } = await seedSite(nestedTree)
        try {
            const ctx = await resolveDocsContext(requestFor(hostname))
            const first = orderedPages(ctx)
            expect(first.map((page) => page.url)).toEqual(
                flattenTree(ctx.source.getPageTree().children).map(
                    (item) => item.url,
                ),
            )
            // A second request resolves the same memoized loader and reuses
            // the derivation instead of re-walking the tree.
            const again = await resolveDocsContext(requestFor(hostname))
            expect(again.source).toBe(ctx.source)
            expect(orderedPages(again)).toBe(first)
        } finally {
            await dropSite(siteId)
        }
    },
)

test.skipIf(!hasDocsDb).concurrent(
    "the serialized sidebar tree renders once per loader",
    async () => {
        const { siteId, hostname } = await seedSite(nestedTree)
        try {
            const ctx = await resolveDocsContext(requestFor(hostname))
            const first = treeDerivations(ctx.source).serialized()
            expect(treeDerivations(ctx.source).serialized()).toBe(first)
            expect(await first).toEqual(
                await ctx.source.serializePageTree(ctx.source.getPageTree()),
            )
        } finally {
            await dropSite(siteId)
        }
    },
)

test.skipIf(!hasDocsDb).concurrent(
    "the served layout config carries the publicly linked GitHub repo",
    async () => {
        const { siteId, hostname } = await seedSite({
            config: {
                name: "Repo",
                // Socials win over a github primary; the private source
                // mirror (repoOwner/repoName) never feeds the widget.
                navbar: {
                    primary: {
                        type: "github",
                        href: "https://github.com/acme/widgets",
                    },
                },
                footer: { socials: { github: "https://github.com/acme/sdk" } },
            },
            repo: { owner: "acme-private", name: "docs-mirror" },
        })
        try {
            const config = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname)),
            )
            expect(config?.githubRepo).toEqual({ owner: "acme", repo: "sdk" })
        } finally {
            await dropSite(siteId)
        }
    },
)
