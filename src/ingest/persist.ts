import { createHash, randomUUID } from "node:crypto"
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm"
import { db, schema } from "../db"
import type {
    Diagnostic,
    DocsBuildErrorKind,
    DocsContentVersionKind,
    LayoutPreset,
    LocalesManifest,
    NavSource,
    ThemeTokens,
} from "../types/docs"
import type { PreparedAsset } from "./assets"
import type { CompiledDocsMeta } from "./compile"
import type {
    NormalizedRedirect,
    StoredIntegrations,
    StoredSeo,
} from "./config"
import type { DocsFontInputs } from "./fonts"
import type { CompiledOpenapiDocument } from "./openapi"
import { DOCS_PIPELINE_VERSION } from "./pipeline-version"
import type { CompiledDocsSkill } from "./skills"
import type { VersionedCompiledDocsPage, VersionsManifest } from "./versions"

/**
 * Where a version's search corpus lives: inline in Postgres (`searchCorpus`,
 * the gzipped envelope from assets.ts/buildSearchCorpus) or in a blob store
 * (`searchCorpusUrl`, from uploadSearchCorpus, called BEFORE the persist
 * transaction like asset uploads — an upload failure must reject before any
 * row commits). Exactly one is set: every servable version carries a corpus.
 */
export type PersistSearchCorpus =
    | { searchCorpus: Uint8Array; searchCorpusUrl: null }
    | { searchCorpus?: undefined; searchCorpusUrl: string }

export type PersistDocsInput = PersistSearchCorpus & PersistDocsContent

export interface PersistDocsContent {
    siteId: string
    commitSha: string
    kind: DocsContentVersionKind
    /**
     * Ingest-order token claimed before the build (docs_site.ingest_seq).
     * The flip guard compares THIS — never build-completion order.
     */
    seq: number
    /** Pull request a preview was built for, recorded when known. */
    prNumber?: number
    /**
     * Stamp recorded on the version row. Defaults to DOCS_PIPELINE_VERSION —
     * the explicit parameter exists so tests can write stale rows.
     */
    pipelineVersion?: number
    /** Replace during a forced re-ingest. Readers keep the old version
     * until commit; callers delete replaced blobs afterward, outside the
     * transaction. */
    replaceExisting?: boolean
    /** Git committer date of the built HEAD — stored for display, never ordering. */
    headCommittedAt: Date | null
    /**
     * Per-source-path Git dates from docs-sync's resolvePageDates step (the
     * head date for paths the HEAD..previous compare lists as changed, or a
     * per-file last-commit date on first ingest). An explicit entry wins;
     * paths without one carry the previous served version's lastModified
     * forward when their source bytes are unchanged, else the head stamp.
     * Absent (scripts, seeds): every page falls back to that carry-forward.
     */
    pageDates?: ReadonlyMap<string, Date>
    pages: VersionedCompiledDocsPage[]
    metas: CompiledDocsMeta[]
    openapiDocuments: CompiledOpenapiDocument[]
    /** Authored Agent Skills (skills.ts), stored per version like pages. */
    skills: CompiledDocsSkill[]
    assets: PreparedAsset[]
    config: unknown
    diagnostics: Diagnostic[]
    navSource: NavSource
    themeTokens: ThemeTokens
    themeCss: string
    /** Output of fonts.ts/resolveFontCss over `fontInputs`. */
    fontCss: string
    fontInputs: DocsFontInputs
    layoutPreset: LayoutPreset
    versionsManifest: VersionsManifest
    localesManifest: LocalesManifest
    redirects: NormalizedRedirect[]
    seo: StoredSeo
    integrations: StoredIntegrations
}

export interface ReplacedBlobCandidate {
    contentHash: string
    blobUrl: string
}

export type PersistDocsResult =
    | {
          outcome: "flipped" | "superseded" | "stored"
          versionId: string
          seq: number
          /** Blob refs of a version replaced via replaceExisting — clean up post-commit. */
          replacedBlobCandidates: ReplacedBlobCandidate[]
          /**
           * Corpus URLs of versions replaced via replaceExisting — delete
           * post-commit UNCONDITIONALLY (per-build random-suffixed URLs are
           * never shared across rows, unlike content-hash-addressed asset
           * blobs, so no refcount pass applies).
           */
          replacedSearchCorpusUrls: string[]
      }
    | {
          outcome: "already-ingested"
          versionId: string
          /**
           * This build's pre-uploaded corpus (null when it was inline) — the
           * existing row keeps its own, so the caller deletes the fresh
           * upload post-commit instead of leaking it.
           */
          unusedSearchCorpusUrl: string | null
      }

/**
 * Record a failed build — visible for debugging, never servable — and, for
 * production, ADVANCE the site's ordering watermark without moving the
 * served pointer. The watermark advance keeps ordering fail-closed: once a
 * newer head has been observed (even if its build failed), a slower in-flight
 * build of an OLDER head must lose the flip guard rather than publish stale
 * content over the failure.
 */
export async function recordFailedDocsVersion(input: {
    siteId: string
    commitSha: string
    kind: DocsContentVersionKind
    seq: number
    prNumber?: number
    error: string
    errorKind: DocsBuildErrorKind
}): Promise<void> {
    const error = input.error.slice(0, 10_000)
    await db.transaction(async (tx) => {
        // Insert a fresh row for every attempt. A failed rebuild of the same sha
        // must remain visible without replacing the still-serving ready row; the
        // new row also drives build history and retry backoff.
        await tx
            .insert(schema.docsContentVersion)
            .values({
                id: randomUUID(),
                siteId: input.siteId,
                commitSha: input.commitSha,
                kind: input.kind,
                prNumber: input.prNumber ?? null,
                // Failed rows sit outside the flip; the claimed seq keeps
                // (site, seq) unique without a second counter.
                seq: input.seq,
                status: "failed",
                error,
                errorKind: input.errorKind,
                // Stamps which pipeline failed: a re-ingest sweep stops
                // re-enqueueing a site whose newest attempt already failed
                // on the current pipeline.
                pipelineVersion: DOCS_PIPELINE_VERSION,
            })
            // Step-retry idempotency: a replayed attempt re-books the same seq.
            // Only that conflict is benign — any other (the sha index drifting
            // back to non-partial hid two stuck sites) must throw so the run
            // fails loudly instead of leaving no row.
            .onConflictDoNothing({
                target: [
                    schema.docsContentVersion.siteId,
                    schema.docsContentVersion.seq,
                ],
            })
        if (input.kind === "production") {
            await tx
                .update(schema.docsSite)
                .set({ currentVersionSeq: input.seq })
                .where(
                    and(
                        eq(schema.docsSite.id, input.siteId),
                        lt(schema.docsSite.currentVersionSeq, input.seq),
                    ),
                )
        }
    })
}

/**
 * Writes an immutable version and flips the serving pointer in one transaction.
 * The webhook-assigned sequence prevents a late older build from replacing
 * newer content; commit dates are not reliable ordering signals after rebases.
 * Per-page `lastModified` carries forward unchanged sources.
 */
/**
 * Split rows into insert slices of at most ~2MB estimated payload (always at
 * least one row per slice) so no single INSERT statement carries an unbounded
 * body — PlanetScale kills the connection on oversized statements.
 */
export function sliceByWeight<T>(rows: T[], weigh: (row: T) => number): T[][] {
    const maxSliceBytes = 2 * 1024 * 1024
    const slices: T[][] = []
    let current: T[] = []
    let currentWeight = 0
    for (const row of rows) {
        const weight = weigh(row)
        if (current.length > 0 && currentWeight + weight > maxSliceBytes) {
            slices.push(current)
            current = []
            currentWeight = 0
        }
        current.push(row)
        currentWeight += weight
    }
    if (current.length > 0) slices.push(current)
    return slices
}

/**
 * Callers that also delete blobs must serialise uploads-through-persist with
 * that deletion (scripts/ingest.ts holds the DOCS_BLOB_LOCK_KEY advisory lock):
 * content-hash asset blobs are shared, so a deletion racing this commit can
 * remove a blob the new version references.
 */
export async function persistDocsVersion(
    input: PersistDocsInput,
): Promise<PersistDocsResult> {
    // One row PER PATH (unique (version, path)): the serve-side source-path
    // fallback resolves assets by their original repo path, so byte-identical
    // siblings must each keep a row — deduping by contentHash silently
    // dropped all but the first path. Blob uploads stay hash-addressed and
    // deduped inside uploadLargeAssets.
    const assetsByPath = new Map<string, PreparedAsset>()
    for (const asset of input.assets) {
        if (!assetsByPath.has(asset.path)) assetsByPath.set(asset.path, asset)
    }
    const assets = [...assetsByPath.values()]
    return db.transaction(async (tx) => {
        // Lock the site row BEFORE the already-ingested check. Concurrent
        // runs of the same sha (push + resync + re-ingest, webhook redelivery,
        // two PRs sharing a head) otherwise both see no row, and the loser's
        // insert dies on docs_content_version_site_sha_kind_uidx. Under READ
        // COMMITTED the check below then sees whatever the lock holder
        // committed, so the loser returns already-ingested (or replaces the
        // winner's row) instead.
        const siteRows = await tx
            .select({
                currentVersionId: schema.docsSite.currentVersionId,
            })
            .from(schema.docsSite)
            .where(eq(schema.docsSite.id, input.siteId))
            .for("update")
            .limit(1)
        // Failed rows are per-attempt history (partial unique index): they
        // are never already-ingested evidence and are never adopted or
        // deleted here — a successful rebuild of a previously-failed sha
        // simply inserts its own row alongside them.
        const existing = await tx
            .select({
                id: schema.docsContentVersion.id,
                status: schema.docsContentVersion.status,
                searchCorpusUrl: schema.docsContentVersion.searchCorpusUrl,
            })
            .from(schema.docsContentVersion)
            .where(
                and(
                    eq(schema.docsContentVersion.siteId, input.siteId),
                    eq(schema.docsContentVersion.commitSha, input.commitSha),
                    eq(schema.docsContentVersion.kind, input.kind),
                    ne(schema.docsContentVersion.status, "failed"),
                ),
            )
            .limit(1)
        const doomed =
            existing[0] && input.replaceExisting === true ? existing[0] : null
        if (existing[0] && !doomed) {
            return {
                outcome: "already-ingested",
                versionId: existing[0].id,
                unusedSearchCorpusUrl: input.searchCorpusUrl,
            }
        }

        // Previous served version's page timestamps, for carry-forward.
        const previousVersionId = siteRows[0]?.currentVersionId ?? null
        // Only path + a server-side content digest + timestamp — never the
        // full sources of the previous version.
        const previousPages = previousVersionId
            ? await tx
                  .select({
                      path: schema.docsPage.path,
                      sourceMd5: sql<string>`md5(${schema.docsPage.source})`,
                      // The compiled rendition changes when an imported
                      // snippet does even though the page source does not.
                      renditionMd5: sql<string>`md5(${schema.docsPage.processedMarkdown})`,
                      lastModified: schema.docsPage.lastModified,
                  })
                  .from(schema.docsPage)
                  .where(eq(schema.docsPage.versionId, previousVersionId))
            : []
        const previousByPath = new Map(previousPages.map((p) => [p.path, p]))

        // Replace versions atomically after carrying forward metadata. Deleting
        // the served row can null current_version_id, so always repoint it below;
        // a retried step may reuse the same sequence number.
        const replacedServedVersion =
            doomed !== null && doomed.id === previousVersionId
        const replacedBlobCandidates: ReplacedBlobCandidate[] = []
        const replacedSearchCorpusUrls: string[] = doomed?.searchCorpusUrl
            ? [doomed.searchCorpusUrl]
            : []
        if (doomed) {
            const doomedAssets = await tx
                .select({
                    contentHash: schema.docsAsset.contentHash,
                    blobUrl: schema.docsAsset.blobUrl,
                })
                .from(schema.docsAsset)
                .where(
                    and(
                        eq(schema.docsAsset.versionId, doomed.id),
                        isNotNull(schema.docsAsset.blobUrl),
                    ),
                )
            const seen = new Set<string>()
            for (const asset of doomedAssets) {
                if (!asset.blobUrl) continue
                const key = `${asset.contentHash}::${asset.blobUrl}`
                if (seen.has(key)) continue
                seen.add(key)
                replacedBlobCandidates.push({
                    contentHash: asset.contentHash,
                    blobUrl: asset.blobUrl,
                })
            }
            await tx
                .delete(schema.docsContentVersion)
                .where(eq(schema.docsContentVersion.id, doomed.id))
        }

        const seq = input.seq
        const versionId = randomUUID()
        const stampedAt = input.headCommittedAt ?? new Date()
        await tx.insert(schema.docsContentVersion).values({
            id: versionId,
            siteId: input.siteId,
            commitSha: input.commitSha,
            kind: input.kind,
            prNumber: input.prNumber ?? null,
            seq,
            status: "building",
            pipelineVersion: input.pipelineVersion ?? DOCS_PIPELINE_VERSION,
            pageCount: input.pages.length,
            config: input.config,
            diagnostics: input.diagnostics,
            navSource: input.navSource,
            themeTokens: input.themeTokens,
            themeCss: input.themeCss,
            fontCss: input.fontCss,
            fontInputs: input.fontInputs,
            layoutPreset: input.layoutPreset,
            versionsManifest: input.versionsManifest,
            localesManifest: input.localesManifest,
            redirects: input.redirects,
            seo: input.seo,
            integrations: input.integrations,
            searchCorpus: input.searchCorpus ?? null,
            searchCorpusUrl: input.searchCorpusUrl,
            headCommittedAt: input.headCommittedAt,
        })

        // Real-scale versions (bun: 318 pages, ~10MB of inline assets) blow
        // past what PlanetScale accepts as a single INSERT payload — the
        // connection is terminated mid-statement. Flush rows in bounded
        // slices instead; they stay inside this transaction either way.
        for (const slice of sliceByWeight(assets, (asset) => asset.byteSize)) {
            await tx.insert(schema.docsAsset).values(
                slice.map((asset) => ({
                    id: randomUUID(),
                    siteId: input.siteId,
                    versionId,
                    path: asset.path,
                    contentHash: asset.contentHash,
                    mimeType: asset.mimeType,
                    bytes: asset.bytes,
                    blobUrl: asset.blobUrl,
                    byteSize: asset.byteSize,
                    width: asset.width,
                    height: asset.height,
                })),
            )
        }

        // hast JSON length is measured directly (it dwarfs the heuristic
        // terms for SSR pages); computed once per page, ingest-time only.
        const hastWeights = new Map(
            input.pages.flatMap((page) => {
                // railHast duplicates highlighted example trees — it weighs
                // like hast and must count toward the 2MB insert slices.
                const weight =
                    (page.hast ? JSON.stringify(page.hast).length : 0) +
                    (page.railHast ? JSON.stringify(page.railHast).length : 0)
                return weight > 0 ? [[page, weight]] : []
            }),
        )
        for (const slice of sliceByWeight(
            input.pages,
            // mdast/structuredData scale with the text bodies — double the
            // measurable lengths as the serialized-payload estimate.
            (page) =>
                (page.source.length +
                    (page.compiledJs?.length ?? 0) +
                    page.processedMarkdown.length) *
                    2 +
                (hastWeights.get(page) ?? 0),
        )) {
            await tx.insert(schema.docsPage).values(
                slice.map((page) => {
                    const previous = previousByPath.get(page.path)
                    return {
                        id: randomUUID(),
                        versionId,
                        siteId: input.siteId,
                        kind: page.kind,
                        path: page.path,
                        versionLabel: page.versionLabel,
                        localeLabel: page.localeLabel,
                        url: page.url,
                        servedUrl: page.servedUrl,
                        slugs: page.slugs,
                        title: page.title,
                        description: page.description,
                        icon: page.icon,
                        hidden: page.hidden,
                        frontmatter: page.frontmatter,
                        source: page.source,
                        compiledJs: page.compiledJs,
                        hast: page.hast,
                        railHast: page.railHast,
                        processedMarkdown: page.processedMarkdown,
                        codeExamples: page.codeExamples,
                        updates: page.updates,
                        structuredData: page.structuredData,
                        toc: page.toc,
                        openapiProps: page.openapiProps,
                        lastModified:
                            input.pageDates?.get(page.path) ??
                            (previous &&
                            previous.sourceMd5 ===
                                createHash("md5")
                                    .update(page.source, "utf8")
                                    .digest("hex") &&
                            previous.renditionMd5 ===
                                createHash("md5")
                                    .update(page.processedMarkdown, "utf8")
                                    .digest("hex")
                                ? previous.lastModified
                                : stampedAt),
                    }
                }),
            )
        }
        if (input.metas.length > 0) {
            await tx.insert(schema.docsMeta).values(
                input.metas.map((meta) => ({
                    id: randomUUID(),
                    versionId,
                    path: meta.path,
                    data: meta.data,
                })),
            )
        }
        // Sliced like pages/assets: frontmatter-referenced specs (pipeline
        // v7) put real sites at ~20 documents of up to 4MB bundled JSON each
        // — one INSERT for all of them blew the connection's statement
        // limit (a real site's re-ingest failed here).
        for (const slice of sliceByWeight(
            input.openapiDocuments,
            (doc) => JSON.stringify(doc.document).length,
        )) {
            await tx.insert(schema.docsOpenapiDocument).values(
                slice.map((doc) => ({
                    id: randomUUID(),
                    versionId,
                    siteId: input.siteId,
                    docId: doc.docId,
                    sourcePath: doc.sourcePath,
                    specHash: doc.specHash,
                    label: doc.label,
                    basePath: doc.basePath,
                    document: doc.document,
                    servers: doc.servers,
                })),
            )
        }

        for (const slice of sliceByWeight(
            input.skills,
            (skill) => skill.body.length * 2,
        )) {
            await tx.insert(schema.docsSkill).values(
                slice.map((skill) => ({
                    id: randomUUID(),
                    siteId: input.siteId,
                    versionId,
                    name: skill.name,
                    description: skill.description,
                    frontmatter: skill.frontmatter,
                    body: skill.body,
                    digest: skill.digest,
                })),
            )
        }

        await tx
            .update(schema.docsContentVersion)
            .set({ status: "ready", builtAt: new Date() })
            .where(eq(schema.docsContentVersion.id, versionId))

        // Previews resolve by commit sha — every built commit stays
        // independently servable until reaped, so there is no pointer to flip
        // and nothing to supersede.
        if (input.kind === "preview") {
            return {
                outcome: "stored",
                versionId,
                seq,
                replacedBlobCandidates,
                replacedSearchCorpusUrls,
            }
        }

        // Guarded production pointer flip — only a strictly newer seq wins,
        // UNLESS this persist deleted the served version above: the pointer
        // is NULL in-tx and the replacement is the only version of the
        // served sha, so it must win even on a same-seq step retry. GREATEST
        // keeps the ordering watermark from regressing below a newer failed
        // build's advance.
        const result = await tx
            .update(schema.docsSite)
            .set({
                currentVersionId: versionId,
                currentVersionSeq: replacedServedVersion
                    ? sql`GREATEST(${schema.docsSite.currentVersionSeq}, ${seq})`
                    : seq,
            })
            .where(
                and(
                    eq(schema.docsSite.id, input.siteId),
                    replacedServedVersion
                        ? undefined
                        : lt(schema.docsSite.currentVersionSeq, seq),
                ),
            )
            .returning({ id: schema.docsSite.id })
        if (result.length === 0) {
            await tx
                .update(schema.docsContentVersion)
                .set({ status: "superseded" })
                .where(eq(schema.docsContentVersion.id, versionId))
            return {
                outcome: "superseded",
                versionId,
                seq,
                replacedBlobCandidates,
                replacedSearchCorpusUrls,
            }
        }
        if (previousVersionId && previousVersionId !== versionId) {
            await tx
                .update(schema.docsContentVersion)
                .set({ status: "superseded" })
                .where(eq(schema.docsContentVersion.id, previousVersionId))
        }
        return {
            outcome: "flipped",
            versionId,
            seq,
            replacedBlobCandidates,
            replacedSearchCorpusUrls,
        }
    })
}
