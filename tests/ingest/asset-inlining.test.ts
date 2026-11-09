import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest"
import {
    INLINE_ASSET_BYTES,
    INLINE_VERSION_BYTES,
    MAX_ASSET_BYTES,
    type PreparedAsset,
    SMALL_ASSET_BYTES,
    SMALL_ASSET_INLINE_BYTES,
    uploadLargeAssets,
} from "@/ingest/assets"

const namespace = "test-namespace"

function asset(path: string, mimeType: string, size: number): PreparedAsset {
    const bytes = new Uint8Array(size)
    return {
        path,
        contentHash: createHash("sha256").update(path).digest("hex"),
        mimeType,
        byteSize: size,
        bytes,
        blobUrl: null,
        width: null,
        height: null,
    }
}

describe("uploadLargeAssets without a blob store", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("keeps every asset inline, even past the per-asset and per-version caps", async () => {
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
        // Over INLINE_ASSET_BYTES each and over INLINE_VERSION_BYTES in sum:
        // with a store configured all of these would upload.
        const assets = Array.from({ length: 3 }, (_, i) =>
            asset(`videos/${i}.mp4`, "video/mp4", MAX_ASSET_BYTES),
        )
        expect(
            assets.reduce((total, a) => total + a.byteSize, 0),
        ).toBeGreaterThan(INLINE_VERSION_BYTES)
        const output = await uploadLargeAssets(assets, { namespace })
        expect(
            output.map((a) => [a.path, a.bytes?.byteLength, a.blobUrl]),
        ).toEqual(assets.map((a) => [a.path, MAX_ASSET_BYTES, null]))
    })
})

describe("uploadLargeAssets small-asset inlining", () => {
    it("keeps a 5KB svg inline while an over-budget version uploads the rest", async () => {
        const perMid = 1024 * 1024
        const midCount = Math.ceil(INLINE_VERSION_BYTES / perMid) + 1
        const assets = [
            asset("logo.svg", "image/svg+xml", 5 * 1024),
            asset("hero.png", "image/png", 2 * 1024 * 1024),
            ...Array.from({ length: midCount }, (_, i) =>
                asset(`shots/${i}.png`, "image/png", perMid),
            ),
        ]
        const uploaded: string[] = []
        const output = await uploadLargeAssets(assets, {
            namespace,
            uploader: async (pathname) => {
                uploaded.push(pathname)
                return { url: `https://blob.test/${pathname}` }
            },
        })
        const byPath = new Map(output.map((a) => [a.path, a]))
        const logo = byPath.get("logo.svg")
        expect(logo?.bytes).not.toBeNull()
        expect(logo?.blobUrl).toBeNull()
        expect(logo?.byteSize).toBeLessThanOrEqual(SMALL_ASSET_BYTES)
        const hero = byPath.get("hero.png")
        expect(hero?.bytes).toBeNull()
        expect(hero?.blobUrl).toMatch(/^https:\/\/blob\.test\/docs-assets\//)
        // Budget tripped: every mid-size asset uploads too.
        for (let i = 0; i < midCount; i += 1)
            expect(byPath.get(`shots/${i}.png`)?.bytes).toBeNull()
        expect(uploaded).toHaveLength(midCount + 1)
    })

    it("keeps mid-size assets inline while the non-small set is under budget", async () => {
        const output = await uploadLargeAssets(
            [
                asset("logo.svg", "image/svg+xml", 5 * 1024),
                asset("shot.png", "image/png", 512 * 1024),
            ],
            {
                namespace,
                uploader: async () => {
                    throw new Error("nothing should upload")
                },
            },
        )
        expect(
            output.every((a) => a.bytes !== null && a.blobUrl === null),
        ).toBe(true)
    })

    it("bounds the small-asset exemption by an aggregate allowance", async () => {
        // Thousands of tiny files must not stay inline unbounded: once the
        // allowance is spent the remaining small assets rejoin the ordinary
        // budget, which this over-budget version has already blown.
        const perSmall = 32 * 1024
        const smallCount = Math.ceil(SMALL_ASSET_INLINE_BYTES / perSmall) + 4
        const assets = [
            ...Array.from({ length: smallCount }, (_, i) =>
                asset(`icons/${i}.svg`, "image/svg+xml", perSmall),
            ),
            asset("hero.png", "image/png", INLINE_VERSION_BYTES + 1),
        ]
        const output = await uploadLargeAssets(assets, {
            namespace,
            uploader: async (pathname) => ({
                url: `https://blob.test/${pathname}`,
            }),
        })
        const inlineSmall = output.filter(
            (entry) => entry.path.startsWith("icons/") && entry.bytes !== null,
        )
        const inlineBytes = inlineSmall.reduce(
            (total, entry) => total + entry.byteSize,
            0,
        )
        expect(inlineBytes).toBeLessThanOrEqual(SMALL_ASSET_INLINE_BYTES)
        expect(inlineSmall.length).toBeLessThan(smallCount)
        // Source order decides who keeps the exemption: the first icons.
        expect(
            output.find((entry) => entry.path === "icons/0.svg")?.bytes,
        ).not.toBeNull()
        expect(
            output.find((entry) => entry.path === `icons/${smallCount - 1}.svg`)
                ?.bytes,
        ).toBeNull()
    })
})

function sharedHashAsset(path: string, hash: string): PreparedAsset {
    return {
        ...asset(path, "image/png", INLINE_ASSET_BYTES + 1),
        contentHash: hash,
    }
}

describe("uploadLargeAssets upload waves", () => {
    it("puts a byte-identical pair once and gives both rows its URL", async () => {
        const hash = "a".repeat(64)
        const uploaded: string[] = []
        const output = await uploadLargeAssets(
            [
                sharedHashAsset("images/one.png", hash),
                sharedHashAsset("copies/two.png", hash),
            ],
            {
                namespace,
                uploader: async (pathname) => {
                    uploaded.push(pathname)
                    return { url: `https://blob.test/${pathname}` }
                },
            },
        )
        expect(uploaded).toEqual([`docs-assets/${namespace}/${hash}.png`])
        expect(output.map((entry) => entry.blobUrl)).toEqual([
            `https://blob.test/docs-assets/${namespace}/${hash}.png`,
            `https://blob.test/docs-assets/${namespace}/${hash}.png`,
        ])
    })

    it("keeps at most eight puts in flight", async () => {
        let inFlight = 0
        let peak = 0
        const output = await uploadLargeAssets(
            Array.from({ length: 20 }, (_, i) =>
                asset(`shots/${i}.png`, "image/png", INLINE_ASSET_BYTES + 1),
            ),
            {
                namespace,
                uploader: async (pathname) => {
                    inFlight += 1
                    peak = Math.max(peak, inFlight)
                    await new Promise((resolve) => setTimeout(resolve, 5))
                    inFlight -= 1
                    return { url: `https://blob.test/${pathname}` }
                },
            },
        )
        expect(peak).toBe(8)
        expect(output.every((entry) => entry.blobUrl !== null)).toBe(true)
    })

    it("rejects with the failed put once its wave settles", async () => {
        const failure = new Error("blob store unavailable")
        const started: string[] = []
        const settled: string[] = []
        const result = uploadLargeAssets(
            Array.from({ length: 10 }, (_, i) =>
                asset(`shots/${i}.png`, "image/png", INLINE_ASSET_BYTES + 1),
            ),
            {
                namespace,
                uploader: async (pathname) => {
                    started.push(pathname)
                    await new Promise((resolve) => setTimeout(resolve, 5))
                    settled.push(pathname)
                    if (started.indexOf(pathname) === 2) throw failure
                    return { url: `https://blob.test/${pathname}` }
                },
            },
        )
        await expect(result).rejects.toBe(failure)
        // The first wave ran to completion; the second never started.
        expect(started).toHaveLength(8)
        expect(settled).toHaveLength(8)
    })
})

describe("uploadLargeAssets dedupeExisting", () => {
    let server: Server
    const probes: string[] = []
    const existing = "b".repeat(64)

    beforeAll(async () => {
        // Local stand-in for the Blob API so the real SDK classifies the
        // responses: 200 for a stored pathname, not_found for the rest.
        server = createServer((request, response) => {
            const pathname =
                new URL(
                    request.url ?? "/",
                    "http://localhost",
                ).searchParams.get("url") ?? ""
            probes.push(pathname)
            response.setHeader("content-type", "application/json")
            if (pathname.startsWith(`docs-assets/${namespace}/${existing}`)) {
                response.end(
                    JSON.stringify({
                        url: `https://store.test/${pathname}`,
                        downloadUrl: `https://store.test/${pathname}?download=1`,
                        pathname,
                        size: 1,
                        contentType: "image/png",
                        contentDisposition: "inline",
                        cacheControl: "public",
                        uploadedAt: new Date(0).toISOString(),
                        etag: "etag",
                    }),
                )
                return
            }
            response.statusCode = 404
            response.end(
                JSON.stringify({
                    error: { code: "not_found", message: "not found" },
                }),
            )
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const address = server.address()
        if (address === null || typeof address === "string")
            throw new Error("blob stub did not bind a port")
        vi.stubEnv("VERCEL_BLOB_API_URL", `http://127.0.0.1:${address.port}`)
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret")
        vi.stubEnv("VERCEL_OIDC_TOKEN", "")
    })

    afterAll(async () => {
        vi.unstubAllEnvs()
        await new Promise((resolve) => server.close(resolve))
    })

    it("probes only the upload set and puts just the missing hashes", async () => {
        const missing = "c".repeat(64)
        const uploaded: string[] = []
        const output = await uploadLargeAssets(
            [
                asset("logo.svg", "image/svg+xml", 5 * 1024),
                sharedHashAsset("stored.png", existing),
                sharedHashAsset("fresh.png", missing),
            ],
            {
                namespace,
                dedupeExisting: true,
                uploader: async (pathname) => {
                    uploaded.push(pathname)
                    return { url: `https://blob.test/${pathname}` }
                },
            },
        )
        expect(probes.sort()).toEqual([
            `docs-assets/${namespace}/${existing}.png`,
            `docs-assets/${namespace}/${missing}.png`,
        ])
        expect(uploaded).toEqual([`docs-assets/${namespace}/${missing}.png`])
        expect(
            output.find((entry) => entry.path === "stored.png"),
        ).toMatchObject({
            bytes: null,
            blobUrl: `https://store.test/docs-assets/${namespace}/${existing}.png`,
        })
    })
})
