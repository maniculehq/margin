import { and, eq } from "drizzle-orm"
import { db, schema } from "@/db"
import { type DocsCodeExample, docsCodeExamplesSchema } from "@/types/docs"
import type { DocPage, DocsContext } from "../source"

export type CodeExample = DocsCodeExample

/**
 * Code examples for one page are precomputed from its MDAST by
 * src/ingest/code-examples.ts. AST extraction cannot be desynchronized by a
 * stray fence in prose. This is a plain row read, shared by the MCP
 * get_code_examples tool and the agent context bundle.
 */
export async function codeExamplesFor(
    ctx: DocsContext,
    page: DocPage,
): Promise<CodeExample[]> {
    if (!ctx.versionId) return []
    // OpenAPI pages store [] — no authored fences to extract from.
    const rows = await db
        .select({ codeExamples: schema.docsPage.codeExamples })
        .from(schema.docsPage)
        .where(
            and(
                eq(schema.docsPage.versionId, ctx.versionId),
                eq(schema.docsPage.siteId, ctx.site.id),
                eq(schema.docsPage.path, page.data.sourcePath),
            ),
        )
        .limit(1)
    if (!rows[0]) return []
    return docsCodeExamplesSchema.parse(rows[0].codeExamples)
}
