import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { expect, test, vi } from "vitest"
import { db, schema } from "@/db"
import { resolveDocsContext, serveLayoutConfig } from "@/lib/source"
import { hasDocsDb, requestFor } from "./context"
import { siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

test.skipIf(!hasDocsDb).concurrent(
    "a content flip serves the new version's artifacts after the old ones were memoized",
    async () => {
        const siteId = randomUUID()
        const slug = `artifacts-${siteId}`
        const oldVersionId = randomUUID()
        const newVersionId = randomUUID()
        await db.transaction(async (transaction) => {
            await transaction.insert(schema.docsSite).values({
                id: siteId,
                slug,
                name: "Artifact memo regression",
                analyticsMode: "off",
                status: "active",
            })
            await transaction.insert(schema.docsContentVersion).values([
                {
                    id: oldVersionId,
                    siteId: siteId,
                    commitSha: "old",
                    seq: 1,
                    status: "ready",
                    searchCorpus: new Uint8Array(0),
                    themeCss: ":root{--old:1}",
                },
                {
                    id: newVersionId,
                    siteId: siteId,
                    commitSha: "new",
                    seq: 2,
                    status: "ready",
                    searchCorpus: new Uint8Array(0),
                    themeCss: ":root{--new:1}",
                },
            ])
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: oldVersionId })
                .where(eq(schema.docsSite.id, siteId))
        })
        try {
            const hostname = siteHost(slug)
            const before = await resolveDocsContext(requestFor(hostname))
            expect(before.siteCss).toBe(":root{--old:1}")
            // Publish as the API does: supersede the old version and move
            // the pointer in one transaction.
            await db.transaction(async (transaction) => {
                await transaction
                    .update(schema.docsContentVersion)
                    .set({ status: "superseded" })
                    .where(eq(schema.docsContentVersion.id, oldVersionId))
                await transaction
                    .update(schema.docsSite)
                    .set({ currentVersionId: newVersionId })
                    .where(eq(schema.docsSite.id, siteId))
            })
            const after = await resolveDocsContext(requestFor(hostname))
            expect(after.versionId).toBe(newVersionId)
            expect(after.siteCss).toBe(":root{--new:1}")
        } finally {
            await db
                .delete(schema.docsSite)
                .where(eq(schema.docsSite.id, siteId))
        }
    },
)

const navWithTab = (tab: string) => ({
    language: null,
    tabs: [{ tab }],
    anchors: [],
    dropdowns: [],
    versions: [],
    products: [],
    menu: [],
    global: null,
})

test.skipIf(!hasDocsDb).concurrent(
    "a content flip serves the new version's layout config after the old one was served",
    async () => {
        const siteId = randomUUID()
        const slug = `layout-flip-${siteId}`
        const oldVersionId = randomUUID()
        const newVersionId = randomUUID()
        await db.transaction(async (transaction) => {
            await transaction.insert(schema.docsSite).values({
                id: siteId,
                slug,
                name: "Layout flip",
                analyticsMode: "off",
                status: "active",
            })
            await transaction.insert(schema.docsContentVersion).values([
                {
                    id: oldVersionId,
                    siteId: siteId,
                    commitSha: "old",
                    seq: 1,
                    status: "ready",
                    searchCorpus: new Uint8Array(0),
                    config: { name: "Old", __resolvedNav: navWithTab("Old") },
                },
                {
                    id: newVersionId,
                    siteId: siteId,
                    commitSha: "new",
                    seq: 2,
                    status: "ready",
                    searchCorpus: new Uint8Array(0),
                    config: { name: "New", __resolvedNav: navWithTab("New") },
                },
            ])
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: oldVersionId })
                .where(eq(schema.docsSite.id, siteId))
        })
        try {
            const hostname = siteHost(slug)
            const before = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname)),
            )
            expect(before?.__resolvedNav?.tabs?.[0]?.tab).toBe("Old")
            await db
                .update(schema.docsSite)
                .set({ currentVersionId: newVersionId })
                .where(eq(schema.docsSite.id, siteId))
            const after = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname)),
            )
            expect(after?.name).toBe("New")
            expect(after?.__resolvedNav?.tabs?.[0]?.tab).toBe("New")
        } finally {
            await db
                .delete(schema.docsSite)
                .where(eq(schema.docsSite.id, siteId))
        }
    },
)

test.skipIf(!hasDocsDb).concurrent(
    "each locale of one version gets its own layout nav",
    async () => {
        const siteId = randomUUID()
        const slug = `layout-locale-${siteId}`
        const versionId = randomUUID()
        await db.transaction(async (transaction) => {
            await transaction.insert(schema.docsSite).values({
                id: siteId,
                slug,
                name: "Layout locales",
                analyticsMode: "off",
                status: "active",
            })
            await transaction.insert(schema.docsContentVersion).values({
                id: versionId,
                siteId: siteId,
                commitSha: "locales",
                seq: 1,
                status: "ready",
                searchCorpus: new Uint8Array(0),
                config: {
                    name: "Locales",
                    __resolvedNav: navWithTab("English"),
                },
                localesManifest: [
                    {
                        locale: "en",
                        default: true,
                        directory: "",
                        nav: navWithTab("English"),
                        versionsManifest: [],
                    },
                    {
                        locale: "fr",
                        default: false,
                        directory: "fr",
                        nav: navWithTab("Français"),
                        versionsManifest: [],
                    },
                ],
            })
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: versionId })
                .where(eq(schema.docsSite.id, siteId))
        })
        try {
            const hostname = siteHost(slug)
            const english = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname), []),
            )
            const french = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname, "/fr"), ["fr"]),
            )
            expect(english?.__resolvedNav?.tabs?.[0]?.tab).toBe("English")
            expect(french?.__resolvedNav?.tabs?.[0]?.tab).toBe("Français")
        } finally {
            await db
                .delete(schema.docsSite)
                .where(eq(schema.docsSite.id, siteId))
        }
    },
)

test.skipIf(!hasDocsDb).concurrent(
    "repeated loader calls for one version share one layout config build",
    async () => {
        const siteId = randomUUID()
        const slug = `layout-reuse-${siteId}`
        const versionId = randomUUID()
        const logoHash = `logo${siteId.replaceAll("-", "")}`
        await db.transaction(async (transaction) => {
            await transaction.insert(schema.docsSite).values({
                id: siteId,
                slug,
                name: "Layout reuse",
                analyticsMode: "off",
                status: "active",
            })
            await transaction.insert(schema.docsContentVersion).values({
                id: versionId,
                siteId: siteId,
                commitSha: "reuse",
                seq: 1,
                status: "ready",
                searchCorpus: new Uint8Array(0),
                config: {
                    name: "Reuse",
                    logo: `/_assets/${logoHash}`,
                    __resolvedNav: navWithTab("Reuse"),
                },
            })
            await transaction.insert(schema.docsAsset).values({
                id: randomUUID(),
                siteId: siteId,
                versionId,
                path: "logo.png",
                contentHash: logoHash,
                mimeType: "image/png",
                byteSize: 1,
                width: 120,
                height: 40,
            })
            await transaction
                .update(schema.docsSite)
                .set({ currentVersionId: versionId })
                .where(eq(schema.docsSite.id, siteId))
        })
        try {
            const hostname = siteHost(slug)
            // Root loader, then page loader: each resolves its own context.
            const first = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname)),
            )
            const second = await serveLayoutConfig(
                await resolveDocsContext(requestFor(hostname)),
            )
            expect(second).toBe(first)
            expect(first?.logo).toMatchObject({ width: 120, height: 40 })
        } finally {
            await db
                .delete(schema.docsAsset)
                .where(eq(schema.docsAsset.siteId, siteId))
            await db
                .delete(schema.docsSite)
                .where(eq(schema.docsSite.id, siteId))
        }
    },
)
