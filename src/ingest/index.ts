/**
 * Public surface of the docs ingest pipeline: read a docs tree, compile it,
 * resolve its network inputs, and persist an immutable content version.
 * `scripts/ingest.ts` drives these at build time; other hosts (a GitHub
 * sync, a CMS export) can drive the same steps with their own snapshot.
 */
export {
    type AssetUploader,
    buildSearchCorpus,
    DOCS_BLOB_LOCK_KEY,
    deleteDoomedVersionBlobs,
    deleteUnreferencedBlobs,
    INLINE_ASSET_BYTES,
    INLINE_VERSION_BYTES,
    MAX_ASSET_BYTES,
    type PreparedAsset,
    prepareAssets,
    resolveBlobNamespace,
    SEARCH_CORPUS_FORMAT_VERSION,
    type SearchCorpusEntry,
    uploadLargeAssets,
    uploadSearchCorpus,
} from "./assets"
export {
    type CompileDocsResult,
    type CompiledDocsPage,
    compileDocs,
} from "./compile"
export { type DocsFontInputs, resolveFontCss } from "./fonts"
export { collectPageDates, type DocsPageDates } from "./page-dates"
export {
    type PersistDocsInput,
    type PersistDocsResult,
    type PersistSearchCorpus,
    persistDocsVersion,
    recordFailedDocsVersion,
} from "./persist"
export { DOCS_PIPELINE_VERSION } from "./pipeline-version"
export { resolveRemoteBrandingAssets } from "./remote-assets"
export { type DocsSnapshotFile, readDocsDir } from "./snapshot"
export type { DocsViolation } from "./validate"
