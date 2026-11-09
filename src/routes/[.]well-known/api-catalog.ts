import { createFileRoute } from "@tanstack/react-router"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { db, schema } from "@/db"
import { agentConfig } from "@/lib/agent.config"
import { orderedPages } from "@/lib/agent-content"
import { siteUrlFromRequest, withBase } from "@/lib/base-path"
import { openapiDocumentIndex, resolveDocsContext } from "@/lib/source"

const PROFILE = "https://www.rfc-editor.org/info/rfc9727"
const CONTENT_TYPE = `application/linkset+json; profile="${PROFILE}"`

/**
 * RFC 9727 API catalog: one linkset context per OpenAPI document behind the
 * docs — anchored at the API's first server URL — linking the machine
 * description (`service-desc`, the bundled spec) and the human reference
 * (`service-doc`, the first API-reference page for that document; omitted
 * when no page documents it). A site without specs answers an empty
 * linkset, which RFC 9264 allows.
 */
async function catalog(request: Request) {
    const ctx = await resolveDocsContext(request)
    const siteUrl = siteUrlFromRequest(request)
    // Each reference page's spec is the document its stored openapi_props
    // names (generated and authored operation pages alike); the first such
    // page in tree order is the spec's human reference.
    const documentByPath = new Map(
        ctx.versionId
            ? (
                  await db
                      .select({
                          path: schema.docsPage.path,
                          document: sql<string>`${schema.docsPage.openapiProps}->>'document'`,
                      })
                      .from(schema.docsPage)
                      .where(
                          and(
                              eq(schema.docsPage.versionId, ctx.versionId),
                              isNotNull(schema.docsPage.openapiProps),
                          ),
                      )
              ).map((row) => [row.path, row.document])
            : [],
    )
    const apiPages = orderedPages(ctx).filter(
        (page) => page.data.kind === "openapi",
    )
    const linkset = (await openapiDocumentIndex(ctx)).map((spec) => {
        const reference = apiPages.find(
            (page) => documentByPath.get(page.data.sourcePath) === spec.docId,
        )
        return {
            anchor:
                spec.servers[0] ??
                `${siteUrl}/api/spec?doc=${encodeURIComponent(spec.docId)}`,
            "service-desc": [
                {
                    href: `${siteUrl}/api/spec?doc=${encodeURIComponent(spec.docId)}`,
                    type: "application/json",
                },
            ],
            ...(reference
                ? {
                      "service-doc": [
                          {
                              href: `${siteUrl}${reference.url}`,
                              type: "text/html",
                          },
                      ],
                  }
                : {}),
        }
    })
    return { linkset }
}

export const Route = createFileRoute("/.well-known/api-catalog")({
    server: {
        handlers: {
            GET: async ({ request }) =>
                new Response(JSON.stringify(await catalog(request), null, 2), {
                    headers: {
                        "Content-Type": CONTENT_TYPE,
                        "Cache-Control": agentConfig.cache.header,
                        "Access-Control-Allow-Origin": "*",
                    },
                }),
            // RFC 9727 §3: HEAD answers with the catalog's own Link.
            HEAD: () =>
                new Response(null, {
                    headers: {
                        "Content-Type": CONTENT_TYPE,
                        Link: `<${withBase("/.well-known/api-catalog")}>; rel="api-catalog"`,
                        "Cache-Control": agentConfig.cache.header,
                    },
                }),
        },
    },
})
