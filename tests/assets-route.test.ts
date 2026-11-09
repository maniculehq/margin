import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, schema } from "@/db"
import { getDocsAsset } from "@/routes/[_]assets/$hash"
import { hasDocsDb, requestFor } from "./context"
import { previewHost, siteHost } from "./site-hosts"

// Seeds many sites side by side: resolve each request's site by host.
vi.mock("#docs-extensions", () => import("./site-hosts"))

describe.skipIf(!hasDocsDb)("docs asset route isolation", () => {
    const siteId = randomUUID()
    const productionVersionId = randomUUID()
    const previewVersionId = randomUUID()
    const hash = "a".repeat(64)
    const previewSha = "abcdef0123456789abcdef0123456789abcdef01"
    // Unique per run so concurrent or aborted runs never collide on the slug.
    const slug = `asset-scope-${siteId.slice(0, 8)}`

    beforeEach(async () => {
        await db.insert(schema.docsSite).values({
            id: siteId,
            slug,
            name: "Asset Scope",
            analyticsMode: "off",
            status: "active",
        })
        await db.insert(schema.docsContentVersion).values([
            {
                id: productionVersionId,
                siteId: siteId,
                commitSha: "production-assets",
                kind: "production",
                seq: 1,
                status: "ready",
                searchCorpus: new Uint8Array(0),
            },
            {
                id: previewVersionId,
                siteId: siteId,
                commitSha: previewSha,
                kind: "preview",
                prNumber: 42,
                seq: 2,
                status: "ready",
                searchCorpus: new Uint8Array(0),
            },
        ])
        await db
            .update(schema.docsSite)
            .set({
                currentVersionId: productionVersionId,
                currentVersionSeq: 1,
            })
            .where(eq(schema.docsSite.id, siteId))
        await db.insert(schema.docsAsset).values([
            {
                id: randomUUID(),
                siteId: siteId,
                versionId: productionVersionId,
                path: "production.svg",
                contentHash: hash,
                mimeType: "image/svg+xml",
                bytes: Buffer.from("<svg><rect /></svg>"),
                byteSize: 19,
            },
            {
                id: randomUUID(),
                siteId: siteId,
                versionId: previewVersionId,
                path: "preview.svg",
                contentHash: hash,
                mimeType: "image/svg+xml",
                bytes: Buffer.from("<svg><circle /></svg>"),
                byteSize: 21,
            },
        ])
    })

    afterEach(async () => {
        await db.delete(schema.docsSite).where(eq(schema.docsSite.id, siteId))
    })

    it("serves only the active version and sandboxes SVG responses", async () => {
        const production = await getDocsAsset({
            request: requestFor(siteHost(slug), `/_assets/${hash}`),
            params: { hash },
        })
        expect(await production.text()).toBe("<svg><rect /></svg>")
        expect(production.headers.get("content-security-policy")).toBe(
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        )

        const preview = await getDocsAsset({
            request: requestFor(
                previewHost(previewSha, slug),
                `/_assets/${hash}`,
            ),
            params: { hash },
        })
        expect(await preview.text()).toBe("<svg><circle /></svg>")
    })
})
