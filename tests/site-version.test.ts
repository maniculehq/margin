/**
 * The version selector an extension hands back, and the site status gate
 * source.ts applies to every selector. The extension here answers from a
 * fixed in-memory site that never expires — the strongest form of an
 * extension cache — so a suspended site going dark proves the gate is read
 * live by source.ts, not trusted from the extension.
 */
import { randomUUID } from "node:crypto"
import { isNotFound, isRedirect } from "@tanstack/react-router"
import { eq } from "drizzle-orm"
import { describe, expect, test, vi } from "vitest"
import { db, schema } from "@/db"
import type { SiteResolution } from "@/extensions/types"
import { resolveSiteVersion } from "@/lib/source"
import { hasDocsDb, requestFor } from "./context"

const resolutions = vi.hoisted(() => new Map<string, SiteResolution>())
vi.mock("#docs-extensions", () => ({
    extensions: {
        resolveSite: async (request: Request) => {
            const resolution = resolutions.get(
                request.headers.get("host") ?? "",
            )
            if (!resolution) throw new Error("no resolution for this host")
            return resolution
        },
        requestPolicy: () => ({
            hstsPreload: false,
            cacheTag: null,
            preview: false,
            shortCircuit: null,
        }),
        telemetry: {},
    },
}))

const CURRENT_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const PINNED_SHA = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const PREVIEW_SHA = "3333333ccccccccccccccccccccccccccccccccc"

/** One active site with a current production version, a superseded
 * production version off the pointer, and a preview. */
async function seedSite() {
    const id = randomUUID()
    const slug = `selector-${id}`
    const versionIds = {
        current: randomUUID(),
        pinned: randomUUID(),
        preview: randomUUID(),
    }
    await db.transaction(async (tx) => {
        await tx.insert(schema.docsSite).values({
            id,
            slug,
            name: "Selector site",
            analyticsMode: "off",
            status: "active",
        })
        await tx.insert(schema.docsContentVersion).values([
            {
                id: versionIds.current,
                siteId: id,
                commitSha: CURRENT_SHA,
                seq: 1,
                status: "ready",
                searchCorpus: new Uint8Array(0),
            },
            {
                id: versionIds.pinned,
                siteId: id,
                commitSha: PINNED_SHA,
                seq: 2,
                // An older production build the pointer has moved past.
                status: "superseded",
                searchCorpus: new Uint8Array(0),
            },
            {
                id: versionIds.preview,
                siteId: id,
                commitSha: PREVIEW_SHA,
                kind: "preview",
                seq: 3,
                status: "ready",
                searchCorpus: new Uint8Array(0),
            },
        ])
        await tx
            .update(schema.docsSite)
            .set({ currentVersionId: versionIds.current })
            .where(eq(schema.docsSite.id, id))
    })
    return {
        id,
        versionIds,
        site: {
            id,
            slug,
            name: "Selector site",
            description: "",
            repo: null,
            analyticsEnabled: true,
            webmcpEnabled: false,
        },
    }
}

const dropSite = (id: string) =>
    db.delete(schema.docsSite).where(eq(schema.docsSite.id, id))

/** A fresh Request per call: heads are memoized per Request object. */
function serve(host: string) {
    return resolveSiteVersion(requestFor(host))
}

describe.skipIf(!hasDocsDb)("version selectors", () => {
    test.each([
        ["the current pointer", "current", "current"],
        [
            "a baked commit a later build superseded",
            { kind: "commit", sha: PINNED_SHA },
            "pinned",
        ],
        [
            "a preview commit prefix",
            { kind: "preview", shaPrefix: PREVIEW_SHA.slice(0, 7) },
            "preview",
        ],
    ] as const)(
        "%s serves its version until the site is suspended",
        async (_label, versionSelector, expected) => {
            const { id, site, versionIds } = await seedSite()
            const host = `${site.slug}.selector.test`
            resolutions.set(host, {
                site,
                versionSelector,
                preview: false,
                canonicalHost: null,
                basePath: "",
                publicOrigin: null,
            })
            try {
                expect((await serve(host)).versionId).toBe(versionIds[expected])
                await db
                    .update(schema.docsSite)
                    .set({ status: "suspended" })
                    .where(eq(schema.docsSite.id, id))
                expect((await serve(host)).versionId).toBeNull()
            } finally {
                resolutions.delete(host)
                await dropSite(id)
            }
        },
    )

    test("a baked commit serves only its own deployment kind's build", async () => {
        const { id, site, versionIds } = await seedSite()
        const host = `${site.slug}.selector.test`
        const resolveAs = (sha: string, preview: boolean) =>
            resolutions.set(host, {
                site,
                versionSelector: { kind: "commit", sha },
                preview,
                canonicalHost: null,
                basePath: "",
                publicOrigin: null,
            })
        try {
            // PREVIEW_SHA was only ever built as a preview.
            resolveAs(PREVIEW_SHA, true)
            expect((await serve(host)).versionId).toBe(versionIds.preview)
            resolveAs(PREVIEW_SHA, false)
            expect((await serve(host)).versionId).toBeNull()
        } finally {
            resolutions.delete(host)
            await dropSite(id)
        }
    })

    test("a commit built both ways resolves to each deployment's own kind", async () => {
        const { id, site, versionIds } = await seedSite()
        const host = `${site.slug}.selector.test`
        const previewOfCurrent = randomUUID()
        await db.insert(schema.docsContentVersion).values({
            id: previewOfCurrent,
            siteId: id,
            commitSha: CURRENT_SHA,
            kind: "preview",
            seq: 4,
            status: "ready",
            searchCorpus: new Uint8Array(0),
        })
        const resolveAs = (preview: boolean) =>
            resolutions.set(host, {
                site,
                versionSelector: { kind: "commit", sha: CURRENT_SHA },
                preview,
                canonicalHost: null,
                basePath: "",
                publicOrigin: null,
            })
        try {
            resolveAs(false)
            expect((await serve(host)).versionId).toBe(versionIds.current)
            resolveAs(true)
            expect((await serve(host)).versionId).toBe(previewOfCurrent)
        } finally {
            resolutions.delete(host)
            await dropSite(id)
        }
    })

    test("a preview prefix that is not commit hex matches nothing", async () => {
        const { id, site, versionIds } = await seedSite()
        const host = `${site.slug}.selector.test`
        const resolveWith = (shaPrefix: string) =>
            resolutions.set(host, {
                site,
                versionSelector: { kind: "preview", shaPrefix },
                preview: true,
                canonicalHost: null,
                basePath: "",
                publicOrigin: null,
            })
        try {
            resolveWith("3333")
            expect((await serve(host)).versionId).toBe(versionIds.preview)
            // A LIKE wildcard would otherwise match the preview above.
            resolveWith("%")
            expect((await serve(host)).versionId).toBeNull()
        } finally {
            resolutions.delete(host)
            await dropSite(id)
        }
    })

    test("a host naming no site is a 404 in production and empty on previews", async () => {
        const production = `missing-${randomUUID()}.selector.test`
        const preview = `missing-${randomUUID()}.selector.test`
        resolutions.set(production, {
            site: null,
            versionSelector: "current",
            preview: false,
            canonicalHost: null,
            basePath: "",
            publicOrigin: null,
        })
        resolutions.set(preview, {
            site: null,
            versionSelector: "current",
            preview: true,
            canonicalHost: null,
            basePath: "",
            publicOrigin: null,
        })
        try {
            const empty = await serve(preview)
            expect(empty.preview).toBe(true)
            expect(empty.versionId).toBeNull()
            const thrown: unknown = await serve(production).catch(
                (error: unknown) => error,
            )
            expect(isNotFound(thrown)).toBe(true)
        } finally {
            resolutions.delete(production)
            resolutions.delete(preview)
        }
    })

    test("a request off the canonical host is redirected to it", async () => {
        const { id, site, versionIds } = await seedSite()
        const canonical = `${site.slug}.selector.test`
        const alias = `alias-${site.slug}.selector.test`
        for (const host of [canonical, alias])
            resolutions.set(host, {
                site,
                versionSelector: "current",
                preview: false,
                canonicalHost: canonical,
                basePath: "",
                publicOrigin: null,
            })
        try {
            expect((await serve(canonical)).versionId).toBe(versionIds.current)
            const thrown: unknown = await resolveSiteVersion(
                requestFor(alias, "/guide?tab=1"),
            ).catch((error: unknown) => error)
            expect(isRedirect(thrown)).toBe(true)
            expect(
                isRedirect(thrown) ? thrown.options.href : undefined,
                // requestFor issues plain-http requests; the scheme carries over.
            ).toBe(`http://${canonical}/guide?tab=1`)
        } finally {
            resolutions.delete(canonical)
            resolutions.delete(alias)
            await dropSite(id)
        }
    })

    test("a redirect to the canonical host keeps the base path and the public scheme", async () => {
        const { id, site } = await seedSite()
        const canonical = `${site.slug}.selector.test`
        const alias = `alias-${site.slug}.selector.test`
        resolutions.set(alias, {
            site,
            versionSelector: "current",
            preview: false,
            canonicalHost: canonical,
            basePath: "/docs",
            publicOrigin: `https://${canonical}`,
        })
        try {
            // The server entry has already stripped the base path.
            const thrown: unknown = await resolveSiteVersion(
                requestFor(alias, "/guide?tab=1"),
            ).catch((error: unknown) => error)
            expect(isRedirect(thrown)).toBe(true)
            expect(isRedirect(thrown) ? thrown.options.href : undefined).toBe(
                `https://${canonical}/docs/guide?tab=1`,
            )
        } finally {
            resolutions.delete(alias)
            await dropSite(id)
        }
    })
})
