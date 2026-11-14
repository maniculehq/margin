/**
 * Stamp for stored docs-ingest output. Bump when a pipeline change alters a
 * derived artifact; an older stamp on a site's current version marks it for
 * re-ingest. Kept outside compile.ts so scripts and tests avoid its
 * Shiki/rolldown dependencies.
 */
export const DOCS_PIPELINE_VERSION = 37
