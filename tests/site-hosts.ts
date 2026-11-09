import { eq } from "drizzle-orm"
import { LRUCache } from "lru-cache"
import { db, schema } from "@/db"
import type { DocsExtensions, DocsSite } from "@/extensions/types"

/**
 * A host-keyed DocsExtensions for DB-backed suites that seed many sites side
 * by side (the built-in extension serves exactly one): `<slug>.sites.test`
 * serves site `<slug>` at its current version, `<sha7>-<slug>.sites.test`
 * the preview built from that commit. A suite swaps it in with
 * `vi.mock("#docs-extensions", () => import("./site-hosts"))`. Lookups are
 * cached 30 s like the built-in extension's, so statement budgets measure
 * the serving code, not this resolver.
 */
const ROOT = "sites.test"

export const siteHost = (slug: string) => `${slug}.${ROOT}`

export const previewHost = (sha: string, slug: string) =>
    `${sha.slice(0, 7)}-${slug}.${ROOT}`

const sites = new LRUCache<string, { site: DocsSite | null }>({
    max: 256,
    ttl: 30_000,
    fetchMethod: async (slug) => {
        const [row] = await db
            .select()
            .from(schema.docsSite)
            .where(eq(schema.docsSite.slug, slug))
            .limit(1)
        return {
            site: row
                ? {
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
                : null,
        }
    },
})

const labelOf = (request: Request) =>
    (request.headers.get("host") ?? "").split(":")[0]?.split(".")[0] ?? ""

export const extensions: DocsExtensions = {
    async resolveSite(request) {
        const label = labelOf(request)
        const preview = /^[0-9a-f]{7}-/.exec(label)
        const slug = preview ? label.slice(8) : label
        const { site } = await sites.forceFetch(slug)
        return {
            site,
            versionSelector: preview
                ? { kind: "preview", shaPrefix: label.slice(0, 7) }
                : "current",
            preview: preview !== null,
            canonicalHost: null,
            basePath: "",
            publicOrigin: null,
        }
    },
    requestPolicy(request) {
        return {
            hstsPreload: false,
            cacheTag: `site-${labelOf(request)}`,
            preview: /^[0-9a-f]{7}-/.test(labelOf(request)),
            shortCircuit: null,
        }
    },
    telemetry: {},
}
