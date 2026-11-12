import { eq } from "drizzle-orm"
import { LRUCache } from "lru-cache"
import { db, schema } from "@/db"
import { env } from "@/env"
import { docsSiteSlugSchema } from "@/types/docs"
import type { DocsExtensions, DocsSite, VersionSelector } from "./types"

/**
 * The built-in single-site extension: one `docs_site` row, named by
 * SITE_SLUG, serves every request. A build that ingested content bakes its
 * commit into DOCS_CONTENT_SHA, so the deployment serves exactly that
 * version; dev (nothing baked) follows the site's current pointer.
 */

// Validated with the slug schema ingest writes, so the default can never
// name a row ingest could not have created; the slug is also the cache tag.
const parsedSlug = docsSiteSlugSchema.safeParse(env.SITE_SLUG)
if (!parsedSlug.success)
    throw new Error(
        "Invalid environment variables: SITE_SLUG (one DNS label: lowercase letters, digits and hyphens, at most 55 characters)",
    )
const siteSlug = parsedSlug.data

const preview = env.VERCEL_ENV === "preview"

const versionSelector: VersionSelector =
    env.DOCS_CONTENT_SHA === undefined
        ? "current"
        : { kind: "commit", sha: env.DOCS_CONTENT_SHA }

// SITE_ORIGIN may carry a path (https://acme.com/docs): the site then sits
// under that base path behind the owner's proxy, and absolute URLs name the
// proxy's origin, because the request reaches this server on another host.
const siteOrigin = new URL(env.SITE_ORIGIN)
const basePath = siteOrigin.pathname.replace(/\/+$/, "")
const publicOrigin = basePath ? siteOrigin.origin : null

// Behind a proxy the request host is the proxy's target, never SITE_ORIGIN's
// host: redirecting there would send every request back through the proxy.
const canonicalHost =
    env.VERCEL_ENV === "production" &&
    env.DOCS_CANONICAL_REDIRECT !== "0" &&
    !basePath
        ? siteOrigin.host
        : null

// A failing lookup (DB down, missing DATABASE_URL) is memoized briefly too,
// so an outage costs one query per window rather than one per request.
const FAILURE_TTL_MS = 5_000

/** A resolved lookup (a null site is a remembered miss) or a remembered
 * failure: LRUCache stores neither a bare null nor a rejection. */
type SiteEntry = { site: DocsSite | null } | { error: unknown }

/** Positive and negative lookups live 30 s; `fetchMethod` coalesces
 * concurrent lookups into one query. One key in practice, bounded anyway. */
const sites = new LRUCache<
    string,
    SiteEntry,
    () => Promise<DocsSite | undefined>
>({
    max: 16,
    ttl: 30_000,
    ignoreFetchAbort: true,
    fetchMethod: async (_key, _stale, { context: query, options }) => {
        try {
            return { site: (await query()) ?? null }
        } catch (error) {
            // Memoize the FAILURE (briefly) and rethrow at the caller —
            // never fall back to a stale row while the database is out.
            options.ttl = FAILURE_TTL_MS
            return { error }
        }
    },
})

export const extensions: DocsExtensions = {
    async resolveSite() {
        // Null when no row carries SITE_SLUG. Status is not a gate here:
        // source.ts re-reads `docs_site.status` live with every version
        // read, so a suspended site goes dark without waiting out the cache.
        const entry = await sites.forceFetch(siteSlug, {
            context: async () => {
                const [row] = await db
                    .select({
                        id: schema.docsSite.id,
                        slug: schema.docsSite.slug,
                        name: schema.docsSite.name,
                        description: schema.docsSite.description,
                        repoOwner: schema.docsSite.repoOwner,
                        repoName: schema.docsSite.repoName,
                        branch: schema.docsSite.branch,
                        subdir: schema.docsSite.subdir,
                        analyticsMode: schema.docsSite.analyticsMode,
                        webmcpEnabled: schema.docsSite.webmcpEnabled,
                    })
                    .from(schema.docsSite)
                    .where(eq(schema.docsSite.slug, siteSlug))
                    .limit(1)
                if (!row) return undefined
                return {
                    id: row.id,
                    slug: row.slug,
                    name: row.name,
                    description: row.description,
                    repo:
                        row.repoOwner !== null && row.repoName !== null
                            ? {
                                  owner: row.repoOwner,
                                  name: row.repoName,
                                  branch: row.branch,
                                  subdir: row.subdir,
                              }
                            : null,
                    analyticsEnabled: row.analyticsMode !== "off",
                    webmcpEnabled: row.webmcpEnabled,
                }
            },
        })
        if ("error" in entry) throw entry.error
        return {
            site: entry.site,
            versionSelector,
            preview,
            canonicalHost,
            basePath,
            publicOrigin,
            // Under a base path the owner's proxy is this server's only
            // caller, so every visitor arrives from its address.
            sharedClientAddress: basePath !== "",
        }
    },
    requestPolicy() {
        return {
            hstsPreload: false,
            cacheTag: `site-${siteSlug}`,
            preview,
            shortCircuit: null,
        }
    },
    telemetry: {},
}
