import { createFileRoute } from "@tanstack/react-router"
import { agentConfig } from "@/lib/agent.config"
import { withBase } from "@/lib/base-path"
import {
    openapiDocument,
    openapiDocumentIndex,
    orderOpenapiDocuments,
    resolveSiteVersion,
} from "@/lib/source"

/** Re-serve a bundled public spec. `doc` selects among the live version's
 * documents (docIds are unique per version, so no page context is needed);
 * without it the configured primary (docs.json `api.openapi`) is served. The
 * API console fetches this same URL, so the spec rides one host-keyed CDN
 * entry per doc instead of every operation page's loader payload. */
export async function handleSpec({ request }: { request: Request }) {
    const ctx = await resolveSiteVersion(request)
    const requested = new URL(request.url).searchParams.get("doc")
    // A requested doc reads only that doc (the console's hot path); the
    // version index is read for the default pick and the 404 listing.
    const documents = requested
        ? null
        : orderOpenapiDocuments(await openapiDocumentIndex(ctx), ctx.config)
    const docId = requested ?? documents?.[0]?.docId
    const document = docId ? await openapiDocument(ctx, docId) : null
    if (!docId || !document)
        // A wrong `doc` names the ones that exist, so a caller can recover
        // without guessing ids.
        return new Response(
            JSON.stringify(
                {
                    error: "not_found",
                    available: (
                        documents ??
                        orderOpenapiDocuments(
                            await openapiDocumentIndex(ctx),
                            ctx.config,
                        )
                    ).map((doc) => ({
                        doc: doc.docId,
                        source: doc.sourcePath,
                        url: withBase(
                            `/api/spec?doc=${encodeURIComponent(doc.docId)}`,
                        ),
                    })),
                },
                null,
                2,
            ),
            {
                status: 404,
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    "cache-control": agentConfig.cache.header,
                },
            },
        )
    return new Response(JSON.stringify(document, null, 2), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${docId}.openapi.json"`,
            // Version-immutable like the pages that render it: the shared
            // policy lets cacheTagMiddleware tag it for docs-sync's purge.
            "cache-control": agentConfig.cache.header,
        },
    })
}

export const Route = createFileRoute("/api/spec")({
    server: {
        handlers: {
            GET: handleSpec,
        },
    },
})
