import * as Sentry from "@sentry/tanstackstart-react"
import { createFileRoute } from "@tanstack/react-router"
import { and, eq, inArray } from "drizzle-orm"
import { LRUCache } from "lru-cache"
import { z } from "zod"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import { buildOgPayload, luminanceAppearance } from "@/lib/og"
import { resolveDocsContext, resolvePage } from "@/lib/source"
import type { ResolvedTabGroup } from "@/types/docs"
import geistBoldDataUri from "../../../../node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf?inline"
import geistRegularDataUri from "../../../../node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf?inline"

// resvg's wasm must instantiate exactly once per isolate — a second initWasm
// throws. Kicked off lazily on the first OG request, shared afterwards. The
// bytes come from the build-time virtual module (see resvgWasmBase64 in
// vite-plugins.ts for why no other delivery mechanism survives the Vercel
// function bundling).
let resvgReady: Promise<typeof import("@resvg/resvg-wasm")> | null = null
function loadResvg() {
    resvgReady ??= (async () => {
        const [module, { default: wasmBase64 }] = await Promise.all([
            import("@resvg/resvg-wasm"),
            import("virtual:resvg-wasm-base64"),
        ])
        await module.initWasm(Buffer.from(wasmBase64, "base64"))
        return module
    })()
    return resvgReady
}

/**
 * Derived card palette per (version, background hash): versions are
 * immutable, so one luminance measurement per background is enough for the
 * instance's lifetime.
 */
const backgroundAppearance = new LRUCache<string, "light" | "dark">({
    max: 256,
})

// The bundled Geist faces, decoded once per isolate rather than per card.
const GEIST_REGULAR = Buffer.from(
    geistRegularDataUri.slice(geistRegularDataUri.indexOf(",") + 1),
    "base64",
)
const GEIST_BOLD = Buffer.from(
    geistBoldDataUri.slice(geistBoldDataUri.indexOf(",") + 1),
    "base64",
)

type OgAsset = { mimeType: string; bytes: Buffer }

/**
 * Resolved card assets (background, custom fonts, logos) per (version, content
 * hash). Versions are immutable and every card of a version shares them, so
 * only a version's first card reads docs_asset or fetches a blob. Bounded by
 * bytes: a custom font pair plus a raster background is a few MB.
 */
const ogAssets = new LRUCache<string, OgAsset>({
    maxSize: 32 * 1024 * 1024,
    sizeCalculation: (asset) => Math.max(1, asset.bytes.byteLength),
})

/** Exported for the statement/fetch budget test (tests/docs-query-counts.test.ts). */
export async function getDocsOgImage(input: {
    request: Request
    params: { _splat?: string }
}): Promise<Response> {
    const { request, params } = input
    try {
        const slugs = (params._splat ?? "").split("/").filter(Boolean)
        const ctx = await resolveDocsContext(request)
        const activeVersion = ctx.activeVersion(slugs)
        const source = ctx.versionSources.get(activeVersion ?? "") ?? ctx.source
        const page = await resolvePage(ctx, source, slugs)
        if (!page)
            return new Response("Not Found", {
                status: 404,
                headers: {
                    "Cache-Control": agentConfig.cache.header,
                },
            })

        // Same nearest-authored-group walk as the page eyebrow in
        // routes/$.tsx — the card shows the
        // division ("Start here") above the title.
        const resolvedNav = ctx.config?.__resolvedNav
        const activeTab =
            [
                ...(resolvedNav?.tabs ?? []),
                ...(resolvedNav?.global?.tabs ?? []),
            ].find((tab) =>
                tab.resolvedPages?.includes(page.data.sourcePath),
            ) ?? null
        const findGroup = (
            groups: ResolvedTabGroup[],
            inherited: string | null,
        ): string | null => {
            for (const group of groups) {
                const title = group.title ?? inherited
                for (const entry of group.entries) {
                    if ("page" in entry && entry.page === page.data.sourcePath)
                        return title
                    if ("group" in entry) {
                        const nested = findGroup([entry.group], title)
                        if (nested) return nested
                    }
                }
            }
            return null
        }
        const siteName = ctx.identity.name
        // docs.json thumbnails.* rides the stored ogDefaults.
        // Per-field parses: a typo'd appearance must not discard
        // a valid background (a whole-object catch drops both).
        const ogRecord = z
            .record(z.string(), z.unknown())
            .catch({})
            .parse(ctx.seo.ogDefaults)
        const ogAppearance = z
            .enum(["light", "dark"])
            .optional()
            .catch(undefined)
            .parse(ogRecord.appearance)
        const ogBackground = z
            .string()
            .optional()
            .catch(undefined)
            .parse(ogRecord.background)
        // thumbnails.fonts resolved at ingest into stored
        // /_assets ttf rows (pipeline v19+) — hashes only,
        // never remote URLs.
        const ogFonts = z
            .object({
                family: z.string(),
                regular: z.string().optional(),
                bold: z.string().optional(),
            })
            .optional()
            .catch(undefined)
            .parse(ogRecord.fonts)
        // Every candidate asset of the card — background, the
        // custom font pair and BOTH logo variants (the variant is
        // picked after the palette resolves) — by content hash.
        const assetHash = (url: string | undefined) =>
            url ? /^\/_assets\/([a-f\d]{64})/i.exec(url)?.[1] : undefined
        const configuredLogo = ctx.config?.logo
        const backgroundHash = assetHash(ogBackground)
        const regularFontHash = assetHash(ogFonts?.regular)
        const boldFontHash = assetHash(ogFonts?.bold)
        const lightLogoHash = assetHash(
            typeof configuredLogo === "string"
                ? configuredLogo
                : configuredLogo?.light,
        )
        const darkLogoHash = assetHash(
            typeof configuredLogo === "string"
                ? configuredLogo
                : (configuredLogo?.dark ?? configuredLogo?.light),
        )
        const versionId = ctx.versionId
        const wantedHashes = [
            ...new Set(
                [
                    backgroundHash,
                    regularFontHash,
                    boldFontHash,
                    lightLogoHash,
                    darkLogoHash,
                ].flatMap((hash) => (hash ? [hash] : [])),
            ),
        ]
        // Resolve the assets while satori/resvg load: memo hits
        // first, then ONE version-scoped select for the misses
        // (a hash from THIS version's config must resolve to
        // THIS version's row, never a preview's leftovers) and
        // every blob fetch in parallel.
        const resolveAssets = async () => {
            const resolved = new Map<string, OgAsset>()
            if (!versionId) return resolved
            const missing: string[] = []
            for (const hash of wantedHashes) {
                const cached = ogAssets.get(`${versionId}:${hash}`)
                if (cached) resolved.set(hash, cached)
                else missing.push(hash)
            }
            if (missing.length === 0) return resolved
            const rows = await db
                .select({
                    contentHash: schema.docsAsset.contentHash,
                    bytes: schema.docsAsset.bytes,
                    blobUrl: schema.docsAsset.blobUrl,
                    mimeType: schema.docsAsset.mimeType,
                })
                .from(schema.docsAsset)
                .where(
                    and(
                        eq(schema.docsAsset.siteId, ctx.site.id),
                        eq(schema.docsAsset.versionId, versionId),
                        inArray(schema.docsAsset.contentHash, missing),
                    ),
                )
            await Promise.all(
                missing.map(async (hash) => {
                    const row = rows.find((entry) => entry.contentHash === hash)
                    // Inline bytes, or our own public blob store
                    // (never an author-supplied URL) behind the same bound
                    // as the ingest fetches: a stalled or aborted
                    // blob CDN degrades the card (Geist, gradient,
                    // text site name) instead of 500ing it.
                    const bytes = row?.bytes
                        ? Buffer.from(row.bytes)
                        : row?.blobUrl
                          ? await fetch(row.blobUrl, {
                                signal: AbortSignal.timeout(10_000),
                            })
                                .then((response) =>
                                    response.ok ? response.arrayBuffer() : null,
                                )
                                .then((body) =>
                                    body ? Buffer.from(body) : null,
                                )
                                .catch(() => null)
                          : null
                    if (!row || !bytes) return
                    const asset = { mimeType: row.mimeType, bytes }
                    // Misses and failures are never memoized: the
                    // next card retries them.
                    ogAssets.set(`${versionId}:${hash}`, asset)
                    resolved.set(hash, asset)
                }),
            )
            return resolved
        }
        const [assets, satoriModule, resvgModule, reactModule] =
            await Promise.all([
                resolveAssets(),
                import("satori"),
                loadResvg(),
                import("react"),
            ])
        const customRegular = regularFontHash
            ? (assets.get(regularFontHash)?.bytes ?? null)
            : null
        const customBold =
            customRegular && boldFontHash
                ? (assets.get(boldFontHash)?.bytes ?? null)
                : null
        const customFamily = customRegular ? ogFonts?.family : null
        const backgroundAsset = backgroundHash
            ? assets.get(backgroundHash)
            : undefined
        // Stored assets become data URIs; Satori never fetches
        // author-supplied URLs. Ingest rewrites allowed externals to asset
        // rows, so a remaining remote URL is stale and omitted.
        const backgroundDataUri = backgroundAsset
            ? `data:${backgroundAsset.mimeType};base64,${backgroundAsset.bytes.toString("base64")}`
            : null
        // thumbnails.appearance wins; otherwise measure the
        // background: a dark SVG with no appearance flag used to
        // get #18181b text. Rasters
        // skip measurement (no cheap decoder here) and fall to
        // appearance.default, as does a site with no background.
        const derivedAppearance = await (async (): Promise<
            "light" | "dark" | undefined
        > => {
            if (ogAppearance || !backgroundAsset || !backgroundHash)
                return undefined
            const cacheKey = `${ctx.versionId}:${backgroundHash}`
            const cached = backgroundAppearance.get(cacheKey)
            if (cached) return cached
            if (backgroundAsset.mimeType !== "image/svg+xml") return undefined
            try {
                const { Resvg } = await loadResvg()
                const measured = luminanceAppearance(
                    new Resvg(backgroundAsset.bytes.toString("utf8"), {
                        fitTo: { mode: "width", value: 60 },
                        font: { loadSystemFonts: false },
                    }).render().pixels,
                )
                backgroundAppearance.set(cacheKey, measured)
                return measured
            } catch {
                // An unparseable background renders as-is; the
                // palette falls back rather than 500ing the card.
                return undefined
            }
        })()
        const cardAppearance =
            ogAppearance ??
            derivedAppearance ??
            (ctx.config?.appearance?.default === "dark" ? "dark" : undefined)
        const payload = buildOgPayload({
            siteName,
            section: activeTab?.resolvedGroups
                ? findGroup(activeTab.resolvedGroups, null)
                : null,
            title: page.data.pageTitle,
            description:
                page.data.description ??
                ctx.seo.description ??
                ctx.identity.description,
            accent: ctx.themeTokens["--color-fd-primary"],
            ...(cardAppearance ? { appearance: cardAppearance } : {}),
        })
        // Dark cards use the dark wordmark of a light/dark pair
        // — the light mark can vanish on the dark background.
        const logoHash =
            cardAppearance === "dark" ? darkLogoHash : lightLogoHash
        const logo = logoHash ? assets.get(logoHash) : undefined
        const logoDataUri = logo
            ? `data:${logo.mimeType};base64,${logo.bytes.toString("base64")}`
            : null
        const dark = cardAppearance === "dark"
        const { createElement } = reactModule
        const titleNodes = payload.titleLines.map((line, index) =>
            createElement("div", { key: `title-${index}` }, line),
        )
        const descriptionNodes = payload.descriptionLines.map((line, index) =>
            createElement("div", { key: `description-${index}` }, line),
        )
        // Single left-aligned column, brand mark top-left, text
        // block anchored to the bottom — the logo already carries
        // the company name, so the plain-text site name renders
        // only when no logo was ingested.
        const element = createElement(
            "div",
            {
                style: {
                    width: "1200px",
                    height: "630px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    // thumbnails.background replaces the stock
                    // gradient; thumbnails.appearance "dark"
                    // flips the palette.
                    ...(backgroundDataUri
                        ? {
                              backgroundImage: `url("${backgroundDataUri}")`,
                              backgroundSize: "1200px 630px",
                          }
                        : {
                              background: dark
                                  ? "linear-gradient(135deg, #18181b 0%, #27272a 100%)"
                                  : "linear-gradient(135deg, #ffffff 0%, #f4f4f5 100%)",
                          }),
                    color: dark ? "#fafafa" : "#18181b",
                    // satori falls back across the registered
                    // font list for missing glyphs, so Geist
                    // stays the safety net under a custom face.
                    fontFamily: customFamily ?? "Geist",
                    padding: "80px",
                },
            },
            logoDataUri
                ? createElement("img", {
                      src: logoDataUri,
                      width: 360,
                      height: 64,
                      style: {
                          objectFit: "contain",
                          objectPosition: "left center",
                      },
                  })
                : createElement(
                      "div",
                      {
                          style: {
                              display: "flex",
                              fontSize: "36px",
                              fontWeight: 700,
                              letterSpacing: "-0.8px",
                          },
                      },
                      payload.siteName,
                  ),
            createElement(
                "div",
                {
                    style: {
                        display: "flex",
                        flexDirection: "column",
                    },
                },
                payload.section
                    ? createElement(
                          "div",
                          {
                              style: {
                                  display: "flex",
                                  fontSize: "28px",
                                  lineHeight: 1.2,
                                  color: payload.eyebrowColor,
                                  marginBottom: "18px",
                              },
                          },
                          payload.section,
                      )
                    : null,
                createElement(
                    "div",
                    {
                        style: {
                            display: "flex",
                            flexDirection: "column",
                            fontSize: "64px",
                            fontWeight: 700,
                            lineHeight: 1.1,
                            letterSpacing: "-1.8px",
                        },
                    },
                    ...titleNodes,
                ),
                descriptionNodes.length > 0
                    ? createElement(
                          "div",
                          {
                              style: {
                                  display: "flex",
                                  flexDirection: "column",
                                  fontSize: "30px",
                                  lineHeight: 1.45,
                                  color: dark ? "#a1a1aa" : "#71717a",
                                  marginTop: "28px",
                              },
                          },
                          ...descriptionNodes,
                      )
                    : null,
            ),
        )
        const satoriFonts: Array<{
            name: string
            data: Buffer
            weight: 400 | 700
            style: "normal"
        }> = [
            {
                name: "Geist",
                data: GEIST_REGULAR,
                weight: 400,
                style: "normal",
            },
            {
                // The title asks for 700 — without this face
                // satori silently substitutes regular.
                name: "Geist",
                data: GEIST_BOLD,
                weight: 700,
                style: "normal",
            },
        ]
        if (customFamily && customRegular) {
            satoriFonts.unshift(
                {
                    name: customFamily,
                    data: customRegular,
                    weight: 400,
                    style: "normal",
                },
                {
                    name: customFamily,
                    data: customBold ?? customRegular,
                    weight: 700,
                    style: "normal",
                },
            )
        }
        const svg = await satoriModule.default(element, {
            width: 1200,
            height: 630,
            fonts: satoriFonts,
        })
        const png = new resvgModule.Resvg(svg, {
            fitTo: { mode: "original" },
            font: { loadSystemFonts: false },
        })
            .render()
            .asPng()
        return new Response(new Uint8Array(png), {
            headers: {
                "Content-Type": "image/png",
                "Cache-Control":
                    "public, s-maxage=86400, stale-while-revalidate=604800",
            },
        })
    } catch (error) {
        // A silent 404 here hid a missing-module failure in prod
        // for months — render errors must be loud and observable.
        Sentry.captureException(error)
        await Sentry.flush(2000)
        return new Response("OG render failed", { status: 500 })
    }
}

export const Route = createFileRoute("/og/docs/$")({
    server: {
        handlers: {
            GET: getDocsOgImage,
        },
    },
})
