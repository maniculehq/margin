import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
    vi,
} from "vitest"
import { db, schema } from "@/db"
import { DOCS_SITE_ANALYTICS_MODES } from "@/types/docs"
import { hasDocsDb } from "../context"

/**
 * The default extension reads its settings once, at import. Each case loads a
 * fresh copy under its own environment, which also gives it an empty cache.
 * Keys a case does not name are unset, so the runner's shell cannot leak in.
 */
async function loadDefault(vars: Record<string, string> = {}) {
    vi.resetModules()
    const settings: Record<string, string | undefined> = {
        SITE_SLUG: undefined,
        DOCS_CONTENT_SHA: undefined,
        DOCS_CANONICAL_REDIRECT: undefined,
        VERCEL_ENV: undefined,
        SITE_ORIGIN: "https://docs.test.invalid",
        // src/env.ts requires a branch name on preview deployments.
        VERCEL_GIT_COMMIT_REF: "main",
        ...vars,
    }
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value)
    const { extensions } = await import("@/extensions/default")
    return extensions
}

const request = () => new Request("https://any-host.test.invalid/guide")

afterEach(() => {
    vi.unstubAllEnvs()
})

async function seedSite(
    values: Partial<typeof schema.docsSite.$inferInsert> = {},
) {
    const id = randomUUID()
    const slug = `ext-${id}`
    await db.insert(schema.docsSite).values({
        id,
        slug,
        name: "Extension test site",
        analyticsMode: DOCS_SITE_ANALYTICS_MODES[0],
        status: "active",
        ...values,
    })
    return { id, slug }
}

const deleteSite = (id: string) =>
    db.delete(schema.docsSite).where(eq(schema.docsSite.id, id))

describe.skipIf(!hasDocsDb)("default extension: site lookup", () => {
    // Seeded before every case's own row, so a lookup that ignored SITE_SLUG
    // would find this one first.
    let competitor: { id: string } | undefined
    beforeAll(async () => {
        competitor = await seedSite({ name: "Competing site" })
    })
    afterAll(async () => {
        if (competitor) await deleteSite(competitor.id)
    })

    test("serves the docs_site row named by SITE_SLUG", async () => {
        const { id, slug } = await seedSite({
            description: "Internal handbook",
            repoOwner: "acme",
            repoName: "handbook",
            branch: "docs",
            subdir: "site",
            analyticsMode: "off",
            webmcpEnabled: true,
        })
        try {
            const extensions = await loadDefault({ SITE_SLUG: slug })
            const { site } = await extensions.resolveSite(request())
            expect(site).toEqual({
                id,
                slug,
                name: "Extension test site",
                description: "Internal handbook",
                repo: {
                    owner: "acme",
                    name: "handbook",
                    branch: "docs",
                    subdir: "site",
                },
                analyticsEnabled: false,
                webmcpEnabled: true,
            })
        } finally {
            await deleteSite(id)
        }
    })

    test("reports no repository for a site without one", async () => {
        const { id, slug } = await seedSite()
        try {
            const extensions = await loadDefault({ SITE_SLUG: slug })
            const { site } = await extensions.resolveSite(request())
            expect(site?.id).toBe(id)
            expect(site?.repo).toBeNull()
        } finally {
            await deleteSite(id)
        }
    })

    test("names no site when no row carries SITE_SLUG", async () => {
        const extensions = await loadDefault({
            SITE_SLUG: `missing-${randomUUID()}`,
        })
        const [other] = await db
            .select({ id: schema.docsSite.id })
            .from(schema.docsSite)
            .limit(1)
        expect(other).toBeDefined()
        const { site } = await extensions.resolveSite(request())
        expect(site).toBeNull()
    })

    test("keeps a resolved site for the cache window", async () => {
        const { id, slug } = await seedSite()
        try {
            const extensions = await loadDefault({ SITE_SLUG: slug })
            await extensions.resolveSite(request())
            await db
                .update(schema.docsSite)
                .set({ name: "Renamed" })
                .where(eq(schema.docsSite.id, id))
            const [row] = await db
                .select({ name: schema.docsSite.name })
                .from(schema.docsSite)
                .where(eq(schema.docsSite.id, id))
            expect(row?.name).toBe("Renamed")
            const { site } = await extensions.resolveSite(request())
            expect(site?.name).toBe("Extension test site")
        } finally {
            await deleteSite(id)
        }
    })

    test("remembers a missing site for the cache window", async () => {
        const slug = `late-${randomUUID()}`
        const extensions = await loadDefault({ SITE_SLUG: slug })
        expect((await extensions.resolveSite(request())).site).toBeNull()
        const { id } = await seedSite({ slug })
        try {
            const [row] = await db
                .select({ id: schema.docsSite.id })
                .from(schema.docsSite)
                .where(eq(schema.docsSite.slug, slug))
            expect(row?.id).toBe(id)
            expect((await extensions.resolveSite(request())).site).toBeNull()
        } finally {
            await deleteSite(id)
        }
    })
})

describe.skipIf(!hasDocsDb)("default extension: resolution", () => {
    test("pins the version the build baked into DOCS_CONTENT_SHA", async () => {
        const extensions = await loadDefault({ DOCS_CONTENT_SHA: "3f9c2ab" })
        const { versionSelector } = await extensions.resolveSite(request())
        expect(versionSelector).toEqual({ kind: "commit", sha: "3f9c2ab" })
    })

    test("follows the current pointer when no SHA is baked", async () => {
        const extensions = await loadDefault()
        const { versionSelector } = await extensions.resolveSite(request())
        expect(versionSelector).toBe("current")
    })

    test("redirects production to the SITE_ORIGIN host", async () => {
        const extensions = await loadDefault({
            VERCEL_ENV: "production",
            SITE_ORIGIN: "https://docs.example.com",
        })
        const resolution = await extensions.resolveSite(request())
        expect(resolution.canonicalHost).toBe("docs.example.com")
        expect(resolution.preview).toBe(false)
        // At the root, absolute URLs keep naming the request's own origin.
        expect(resolution.basePath).toBe("")
        expect(resolution.publicOrigin).toBeNull()
    })

    test("serves under SITE_ORIGIN's path and never redirects to its host", async () => {
        // Behind the owner's proxy the request arrives on another host, so a
        // redirect to SITE_ORIGIN's host would loop through the proxy.
        const extensions = await loadDefault({
            VERCEL_ENV: "production",
            SITE_ORIGIN: "https://example.com/docs/",
        })
        const resolution = await extensions.resolveSite(request())
        expect(resolution.basePath).toBe("/docs")
        expect(resolution.publicOrigin).toBe("https://example.com")
        expect(resolution.canonicalHost).toBeNull()
    })

    test("DOCS_CANONICAL_REDIRECT=0 turns the production redirect off", async () => {
        const extensions = await loadDefault({
            VERCEL_ENV: "production",
            SITE_ORIGIN: "https://docs.example.com",
            DOCS_CANONICAL_REDIRECT: "0",
        })
        const { canonicalHost } = await extensions.resolveSite(request())
        expect(canonicalHost).toBeNull()
    })

    test("previews never redirect and serve as preview", async () => {
        const extensions = await loadDefault({
            VERCEL_ENV: "preview",
            SITE_ORIGIN: "https://docs.example.com",
        })
        const resolution = await extensions.resolveSite(request())
        expect(resolution.preview).toBe(true)
        expect(resolution.canonicalHost).toBeNull()
    })
})

describe("default extension: without a database", () => {
    test("memoizes a failed lookup instead of re-querying", async () => {
        const extensions = await loadDefault({
            DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/docs",
        })
        const first: unknown = await extensions
            .resolveSite(request())
            .catch((error: unknown) => error)
        const second: unknown = await extensions
            .resolveSite(request())
            .catch((error: unknown) => error)
        expect(first).toBeInstanceOf(Error)
        expect(second).toBe(first)
    })

    test("tags purgeable responses with the site slug", async () => {
        const extensions = await loadDefault({ SITE_SLUG: "handbook" })
        expect(extensions.requestPolicy(request())).toEqual({
            hstsPreload: false,
            cacheTag: "site-handbook",
            preview: false,
            shortCircuit: null,
        })
    })

    test("request policy marks preview deployments", async () => {
        const extensions = await loadDefault({ VERCEL_ENV: "preview" })
        expect(extensions.requestPolicy(request()).preview).toBe(true)
    })

    test("refuses a SITE_SLUG that cannot be a cache tag", async () => {
        await expect(loadDefault({ SITE_SLUG: "docs,api" })).rejects.toThrow(
            /SITE_SLUG/,
        )
    })
})
