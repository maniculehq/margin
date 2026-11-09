import { createFileRoute } from "@tanstack/react-router"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import { withBase } from "@/lib/base-path"
import { resolveSiteVersion } from "@/lib/source"

/**
 * A miss is version-scoped, not immutable like a hit: the next publish can
 * add the hash. Shared policy lets the CDN absorb repeated probes while
 * cacheTagMiddleware tags it for the publish purge.
 */
const notFoundInit = {
    status: 404,
    headers: { "Cache-Control": agentConfig.cache.header },
}

/**
 * On-demand responsive variants (`?w=<width>&f=<format>`): the page emits a
 * srcset over these widths (components/mdx.tsx assetSrcSet) so a 3000px
 * screenshot is served resized to the column it fills. Widths are a fixed
 * enum so the CDN caches a bounded set per asset; the response is immutable
 * like the original (the hash pins the bytes). Only raster sources resize —
 * SVG/GIF and non-images pass through untouched.
 */
const variantSchema = z
    .object({
        w: z.enum(["640", "960", "1440", "1920"]).optional(),
        f: z.enum(["webp", "avif", "png", "jpeg"]).optional(),
    })
    .strict()
const RESIZABLE = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/avif",
    "image/gif",
])
/** Animated inputs keep every frame (and an animation-capable output). */
const ANIMATABLE = new Set(["image/webp", "image/gif"])

/**
 * Bound concurrent transforms: each one decodes a full raster into memory,
 * and previews (uncached) or a burst of first views could otherwise stack
 * dozens of Sharp pipelines on one instance.
 */
const MAX_TRANSFORMS = 4
let activeTransforms = 0
const transformQueue: (() => void)[] = []
async function withTransformSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeTransforms >= MAX_TRANSFORMS)
        await new Promise<void>((resolve) => transformQueue.push(resolve))
    activeTransforms += 1
    try {
        return await work()
    } finally {
        activeTransforms -= 1
        transformQueue.shift()?.()
    }
}

async function resized(
    bytes: Uint8Array,
    mimeType: string,
    variant: z.infer<typeof variantSchema>,
): Promise<{ body: Uint8Array; type: string } | null> {
    if (!RESIZABLE.has(mimeType)) return null
    try {
        return await (async () => {
            // Loaded on demand: sharp's import loads the libvips native
            // library, which only resized variants (not the original bytes
            // or any other route) need.
            const { default: sharp } = await import("sharp")
            // Only genuinely multi-frame sources are treated as animated;
            // a static WebP/GIF honours the requested `f=` like any raster.
            const animated =
                ANIMATABLE.has(mimeType) &&
                ((await sharp(bytes).metadata()).pages ?? 1) > 1
            // rotate() with no angle applies the EXIF orientation, so
            // resized candidates match how browsers show the original.
            let pipeline = sharp(bytes, { animated }).rotate()
            if (variant.w)
                pipeline = pipeline.resize({
                    width: Number(variant.w),
                    withoutEnlargement: true,
                })
            const native =
                mimeType === "image/png"
                    ? "png"
                    : mimeType === "image/webp"
                      ? "webp"
                      : mimeType === "image/avif"
                        ? "avif"
                        : mimeType === "image/gif"
                          ? "gif"
                          : "jpeg"
            // Animated sources only re-encode to animation-capable formats.
            const requested = variant.f ?? native
            const format =
                animated && requested !== "webp" && requested !== "gif"
                    ? native
                    : requested
            pipeline = pipeline.toFormat(format, { quality: 82 })
            const body = new Uint8Array(await pipeline.toBuffer())
            return { body, type: `image/${format}` }
        })()
    } catch {
        return null
    }
}

export async function getDocsAsset(input: {
    request: Request
    params: { hash: string }
}): Promise<Response> {
    const ctx = await resolveSiteVersion(input.request)
    if (!ctx.versionId) return new Response("Not Found", notFoundInit)
    // Every query key must be a known variant parameter, once — otherwise
    // `?w=640&nonce=…` would mint unbounded cache keys and transforms.
    const search = new URL(input.request.url).searchParams
    const keys = [...search.keys()]
    const variantParse = variantSchema.safeParse(
        Object.fromEntries(search.entries()),
    )
    if (!variantParse.success || keys.length !== new Set(keys).size)
        return new Response("Bad Request", { status: 400 })
    const variant = variantParse.data
    const wantsVariant = variant.w !== undefined || variant.f !== undefined
    const rows = await db
        .select({
            bytes: schema.docsAsset.bytes,
            blobUrl: schema.docsAsset.blobUrl,
            mimeType: schema.docsAsset.mimeType,
            byteSize: schema.docsAsset.byteSize,
        })
        .from(schema.docsAsset)
        .where(
            and(
                eq(schema.docsAsset.siteId, ctx.site.id),
                eq(schema.docsAsset.versionId, ctx.versionId),
                eq(schema.docsAsset.contentHash, input.params.hash),
            ),
        )
        .limit(1)
    const asset = rows[0]
    if (!asset) return new Response("Not Found", notFoundInit)
    if (wantsVariant && RESIZABLE.has(asset.mimeType)) {
        // The slot covers the source download too: a burst of variant
        // requests must not materialise dozens of 20 MB sources while
        // waiting for Sharp.
        const result = await withTransformSlot(async () => {
            const source = asset.bytes
                ? new Uint8Array(asset.bytes)
                : asset.blobUrl
                  ? await fetch(asset.blobUrl, {
                        signal: AbortSignal.timeout(10_000),
                    })
                        .then((blob) =>
                            blob.ok ? blob.arrayBuffer() : Promise.reject(),
                        )
                        .then((buffer) => new Uint8Array(buffer))
                        .catch(() => null)
                  : null
            return source
                ? await resized(source, asset.mimeType, variant)
                : null
        })
        if (result)
            return new Response(new Uint8Array(result.body), {
                headers: {
                    "Content-Type": result.type,
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "X-Content-Type-Options": "nosniff",
                },
            })
        // The variant could not be built (blob timeout, decode failure):
        // never let the original be cached immutably under the variant URL —
        // send the client to the canonical asset with a retryable status.
        return new Response(null, {
            status: 302,
            headers: {
                Location: withBase(new URL(input.request.url).pathname),
                "Cache-Control": "no-store",
            },
        })
    }
    if (asset.bytes) {
        const headers: Record<string, string> = {
            "Content-Type": asset.mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
        }
        if (asset.mimeType === "image/svg+xml")
            headers["Content-Security-Policy"] =
                "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return new Response(new Uint8Array(asset.bytes), { headers })
    }
    if (asset.blobUrl) {
        const headers: Record<string, string> = {
            "Content-Type": asset.mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
        }
        // Small blob-backed rows (≤256 KiB: logos, icons, OG fonts) proxy
        // from our own blob store so the browser gets bytes on the first
        // hop — a 302 to the blob host costs a second connection per image.
        // Larger media keeps the redirect; a stalled blob CDN falls back to
        // it as well.
        if (asset.byteSize <= 262_144) {
            const blob = await fetch(asset.blobUrl, {
                signal: AbortSignal.timeout(10_000),
            }).catch(() => null)
            if (blob?.ok && blob.body) {
                if (asset.mimeType === "image/svg+xml")
                    headers["Content-Security-Policy"] =
                        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
                return new Response(blob.body, { headers })
            }
        }
        return new Response(null, {
            status: 302,
            headers: {
                Location: asset.blobUrl,
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        })
    }
    return new Response("Not Found", notFoundInit)
}

export const Route = createFileRoute("/_assets/$hash")({
    server: {
        handlers: {
            GET: getDocsAsset,
        },
    },
})
