/**
 * Ingests a docs folder into Postgres as an immutable content version
 * (`bun run ingest`). Runs as a build step: the deployment then serves the
 * version keyed by the commit it was built from.
 *
 *   bun scripts/ingest.ts [--dir <path>] [--slug <slug>] [--sha <sha>]
 *                         [--kind production|preview] [--force] [--watch]
 *
 * - The docs folder is `--dir`, else DOCS_DIR, else `docs/` when it exists,
 *   else the current directory when it holds a docs.json.
 * - The version key is `--sha`, else DOCS_CONTENT_SHA, else
 *   VERCEL_GIT_COMMIT_SHA, else `git rev-parse HEAD`, else `dev-<unix ms>`.
 * - Production versions advance the site's served pointer; previews never do.
 * - Re-running an already-ingested key is a no-op unless `--force` (or
 *   DOCS_INGEST=force) replaces it; DOCS_INGEST=off skips ingest entirely.
 * - Content violations print the report and exit 1, so a broken docs tree
 *   fails the build instead of deploying.
 * - `--watch` re-ingests on every change under the docs folder, each run as a
 *   new `dev-<unix ms>` production version.
 *
 * Retention (also printed by `--help`): after each successful ingest, old
 * versions are collected. Kept: this build's version, the version served
 * before it, the newest DOCS_KEEP_VERSIONS (default 20) other production
 * versions, and every production version under 30 days old. So a deployment
 * pinned to a production version that is both older than 30 days and beyond
 * the keep count, and any preview version older than 30 days, may lose its
 * content: redeploy that commit to re-ingest it.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, watch } from "node:fs"
import { resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { and, eq, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm"
import { Client } from "pg"
import { z } from "zod"
import { db, schema } from "../src/db"
import { resolveEnv } from "../src/db/env"
import {
    buildSearchCorpus,
    collectPageDates,
    compileDocs,
    DOCS_BLOB_LOCK_KEY,
    deleteDoomedVersionBlobs,
    deleteUnreferencedBlobs,
    INLINE_VERSION_BYTES,
    type PersistSearchCorpus,
    persistDocsVersion,
    readDocsDir,
    recordFailedDocsVersion,
    resolveBlobNamespace,
    resolveFontCss,
    resolveRemoteBrandingAssets,
    uploadLargeAssets,
    uploadSearchCorpus,
} from "../src/ingest"
import {
    DOCS_CONTENT_VERSION_KINDS,
    docsSiteSlugSchema,
} from "../src/types/docs"

const run = promisify(execFile)
const DAY_MS = 24 * 60 * 60 * 1000
/** Versions younger than this are never collected, so a rollback to a recent
 * deployment still finds its content. */
const GC_MIN_AGE_MS = 30 * DAY_MS

const { values: flags } = parseArgs({
    options: {
        dir: { type: "string" },
        slug: { type: "string" },
        sha: { type: "string" },
        kind: { type: "string" },
        force: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
    },
    strict: true,
})

if (flags.help) {
    console.log(`Usage: bun scripts/ingest.ts [--dir <path>] [--slug <slug>] [--sha <sha>]
                            [--kind production|preview] [--force] [--watch]

Ingests a docs folder into Postgres as an immutable content version keyed by
commit. Production versions advance the served pointer; previews never do.

  --dir    docs folder (default: DOCS_DIR, docs/, or . when it has docs.json)
  --slug   site slug (default: SITE_SLUG or "docs")
  --sha    version key (default: DOCS_CONTENT_SHA, VERCEL_GIT_COMMIT_SHA,
           git rev-parse HEAD, dev-<unix ms>)
  --kind   production or preview (default: preview when VERCEL_ENV=preview)
  --force  re-ingest a key that already exists
  --watch  re-ingest on every change, as dev-<unix ms> production versions

Retention: each ingest collects old versions. It keeps this build's version,
the version served before it, the newest DOCS_KEEP_VERSIONS (default 20)
other production versions and every production version under 30 days old.
A deployment pinned to an older production version beyond the keep count, or
to a preview version older than 30 days, may lose its content; redeploy that
commit to re-ingest it. Versions whose blobs cannot be deleted (no
BLOB_READ_WRITE_TOKEN) are kept.`)
    process.exit(0)
}

// Empty variables count as unset, as everywhere else in the framework.
const env = z
    .object({
        DOCS_DIR: z.string().optional(),
        DOCS_CONTENT_SHA: z.string().optional(),
        DOCS_INGEST: z.enum(["on", "off", "force"]).default("on"),
        DOCS_KEEP_VERSIONS: z.coerce.number().int().min(1).default(20),
        SITE_SLUG: z.string().optional(),
        VERCEL_ENV: z.string().optional(),
        VERCEL_GIT_COMMIT_SHA: z.string().optional(),
        VERCEL_GIT_PULL_REQUEST_ID: z.coerce
            .number()
            .int()
            .positive()
            .optional(),
        BLOB_READ_WRITE_TOKEN: z.string().optional(),
    })
    .parse(
        Object.fromEntries(
            Object.entries(process.env).filter(([, value]) => value !== ""),
        ),
    )

if (env.DOCS_INGEST === "off" && !flags.force) {
    console.log("[ingest] DOCS_INGEST=off: skipping build-time ingest")
    process.exit(0)
}

const dir = resolve(
    flags.dir ??
        env.DOCS_DIR ??
        (existsSync("docs")
            ? "docs"
            : existsSync("docs.json")
              ? "."
              : (() => {
                    throw new Error(
                        "[ingest] no docs folder: pass --dir, set DOCS_DIR, or add docs/ (or a docs.json in the current directory)",
                    )
                })()),
)
const slug = docsSiteSlugSchema.parse(flags.slug ?? env.SITE_SLUG ?? "docs")
const kind = z
    .enum(DOCS_CONTENT_VERSION_KINDS)
    .parse(
        flags.kind ?? (env.VERCEL_ENV === "preview" ? "preview" : "production"),
    )
const force = flags.force || env.DOCS_INGEST === "force"

const gitOutput = async (args: string[]): Promise<string | null> => {
    try {
        return (await run("git", args, { cwd: dir })).stdout.trim() || null
    } catch {
        return null
    }
}

/** One ingest of the docs folder at `sha`. Returns the process exit code. */
async function ingest(input: {
    sha: string
    kind: "production" | "preview"
    force: boolean
    /** Watch mode: dev versions are collected regardless of age. */
    collectDevVersions: boolean
}): Promise<number> {
    const started = Date.now()
    const { files, diagnostics: snapshotDiagnostics } = await readDocsDir(dir)
    if (files.length === 0) {
        console.error(`[ingest] ${dir} holds no docs files`)
        return 1
    }

    const [site] = await db
        .insert(schema.docsSite)
        .values({
            id: randomUUID(),
            slug,
            name: slug,
            status: "active",
            analyticsMode: "tenant",
        })
        // An existing site keeps its status: an operator's suspension must
        // survive every later build, previews and reruns included. The no-op
        // update only makes the conflict return the row.
        .onConflictDoUpdate({
            target: schema.docsSite.slug,
            set: { status: sql`${schema.docsSite.status}` },
        })
        .returning({
            id: schema.docsSite.id,
            currentVersionId: schema.docsSite.currentVersionId,
        })
    if (!site) throw new Error(`[ingest] could not upsert site ${slug}`)

    const existing = await db
        .select({ id: schema.docsContentVersion.id })
        .from(schema.docsContentVersion)
        .where(
            and(
                eq(schema.docsContentVersion.siteId, site.id),
                eq(schema.docsContentVersion.commitSha, input.sha),
                eq(schema.docsContentVersion.kind, input.kind),
                ne(schema.docsContentVersion.status, "failed"),
            ),
        )
        .limit(1)
    if (existing[0] && !input.force) {
        console.log(
            `[ingest] ${slug}@${input.sha} (${input.kind}) is already ingested as ${existing[0].id}; nothing to do (--force re-ingests)`,
        )
        return 0
    }

    // Claimed before the build: a slower build of an older commit carries a
    // lower seq and loses the pointer flip to any newer one.
    const [claimed] = await db
        .update(schema.docsSite)
        .set({ ingestSeq: sql`${schema.docsSite.ingestSeq} + 1` })
        .where(eq(schema.docsSite.id, site.id))
        .returning({ seq: schema.docsSite.ingestSeq })
    if (!claimed) throw new Error(`[ingest] site ${slug} disappeared`)
    const prNumber =
        input.kind === "preview" ? env.VERCEL_GIT_PULL_REQUEST_ID : undefined
    const fail = async (
        report: string,
        errorKind: "content" | "internal",
    ): Promise<number> => {
        await recordFailedDocsVersion({
            siteId: site.id,
            commitSha: input.sha,
            kind: input.kind,
            seq: claimed.seq,
            prNumber,
            error: report,
            errorKind,
        })
        console.error(`[ingest] ${slug}@${input.sha} failed:\n${report}`)
        return 1
    }

    let persisted = false
    try {
        const compiled = await compileDocs(files)
        if (!compiled.ok) {
            const lines = compiled.violations
                .slice(0, 50)
                .map(
                    (v) =>
                        `- \`${v.path}\`${v.line ? ` (line ${v.line})` : ""}: ${v.message}`,
                )
            if (compiled.violations.length > 50)
                lines.push(`- …and ${compiled.violations.length - 50} more`)
            return await fail(lines.join("\n"), "content")
        }
        if (compiled.pages.length === 0)
            return await fail(
                "the docs folder contains no pages — refusing to publish an empty docs site",
                "content",
            )

        compiled.diagnostics.push(...snapshotDiagnostics)
        // Network inputs resolve outside compile, which stays a pure
        // function of the tree; both degrade to diagnostics, never throw.
        const font = await resolveFontCss(compiled.fontInputs)
        compiled.diagnostics.push(...font.diagnostics)
        await resolveRemoteBrandingAssets(compiled)

        const previous = site.currentVersionId
            ? await db
                  .select({ commitSha: schema.docsContentVersion.commitSha })
                  .from(schema.docsContentVersion)
                  .where(
                      eq(schema.docsContentVersion.id, site.currentVersionId),
                  )
                  .limit(1)
            : []
        const pageDates = await collectPageDates({
            dir,
            paths: compiled.pages.map((page) => page.path),
            previousSha: previous[0]?.commitSha ?? null,
        })
        compiled.diagnostics.push(...pageDates.diagnostics)

        // Everything that writes or deletes blob references runs under the
        // blob-namespace advisory lock (one for every site in this database:
        // they share its namespace): uploads through the persist commit, and the
        // collection below from its reference check to its deletes. Without
        // it a concurrent build's collection could delete a content-hash
        // blob after this build re-uploaded it but before its reference
        // committed. Session-scoped on its own direct connection: outside
        // the pool, which the persist transaction needs, and never through a
        // transaction-mode pooler, where a session lock binds to whichever
        // backend served the statement. A dropped connection releases it.
        const dbEnv = resolveEnv()
        if (
            !dbEnv.DATABASE_URL_UNPOOLED &&
            /-pooler\.|pgbouncer=true|:6543\//.test(dbEnv.DATABASE_URL)
        )
            console.warn(
                "[ingest] DATABASE_URL looks pooled and no DATABASE_URL_UNPOOLED / POSTGRES_URL_NON_POOLING is set: the blob lock may not serialise concurrent builds",
            )
        const directUrl = dbEnv.DATABASE_URL_UNPOOLED ?? dbEnv.DATABASE_URL
        const lock = new Client({ connectionString: directUrl })
        await lock.connect()
        try {
            // The role's request default (db:migrate sets 20 s) would cancel
            // the wait while another build holds the lock; this build-only
            // session waits as long as that build runs.
            await lock.query("set statement_timeout = 0")
            await lock.query("select pg_advisory_lock($1)", [
                DOCS_BLOB_LOCK_KEY.toString(),
            ])
            const namespace = await resolveBlobNamespace(directUrl)
            // Blob writes (only with BLOB_READ_WRITE_TOKEN) precede the persist
            // transaction, so a failed upload never leaves a committed row.
            const assets = await uploadLargeAssets(compiled.assets, {
                namespace,
            })
            let corpus: PersistSearchCorpus
            let corpusBytes: number
            if (env.BLOB_READ_WRITE_TOKEN) {
                corpus = {
                    searchCorpusUrl: await uploadSearchCorpus(compiled.pages, {
                        namespace,
                    }),
                }
                corpusBytes = 0
            } else {
                const built = buildSearchCorpus(compiled.pages)
                if (built.gzipped.byteLength > INLINE_VERSION_BYTES)
                    return await fail(
                        `the search corpus is ${(built.gzipped.byteLength / 1024 / 1024).toFixed(1)} MB gzipped, over the ${INLINE_VERSION_BYTES / 1024 / 1024} MB Postgres limit — set BLOB_READ_WRITE_TOKEN to store it in Vercel Blob`,
                        "content",
                    )
                corpus = { searchCorpus: built.gzipped, searchCorpusUrl: null }
                corpusBytes = built.gzipped.byteLength
            }

            const headCommittedAt = await gitOutput([
                "log",
                "-1",
                "--format=%cI",
            ])
            const result = await persistDocsVersion({
                ...corpus,
                siteId: site.id,
                commitSha: input.sha,
                kind: input.kind,
                seq: claimed.seq,
                prNumber,
                headCommittedAt: headCommittedAt
                    ? new Date(headCommittedAt)
                    : null,
                pageDates: pageDates.dates,
                pages: compiled.pages,
                metas: compiled.metas,
                openapiDocuments: compiled.openapiDocuments,
                skills: compiled.skills,
                assets,
                config: compiled.config,
                diagnostics: compiled.diagnostics,
                navSource: compiled.navSource,
                themeTokens: compiled.themeTokens,
                themeCss: compiled.themeCss,
                fontCss: font.css,
                fontInputs: compiled.fontInputs,
                layoutPreset: compiled.layoutPreset,
                versionsManifest: compiled.versionsManifest,
                localesManifest: compiled.localesManifest,
                redirects: compiled.redirects,
                seo: compiled.seo,
                integrations: compiled.integrations,
                replaceExisting: input.force,
            })
            persisted = true
            const warnings = compiled.diagnostics.filter(
                (diagnostic) => diagnostic.severity !== "info",
            )
            for (const diagnostic of warnings)
                console.warn(
                    `[ingest]   ${diagnostic.severity}: ${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`,
                )
            console.log(
                `[ingest] ${slug}@${input.sha} (${input.kind}): ${compiled.pages.length} pages, ${assets.length} assets, corpus ${corpusBytes} bytes inline → ${result.outcome} ${result.versionId} in ${Date.now() - started} ms`,
            )

            // Rows are committed; nothing below may touch a version a
            // deployment could still serve. Protected: this build's version, the
            // pointer before this build (the live deployment keeps serving it
            // until the new one is promoted) and the pointer now. Production
            // versions are kept by count (the newest DOCS_KEEP_VERSIONS besides
            // this build's) AND by age (anything under 30 days), so rollbacks
            // keep working; previews and failed attempts go after 30 days.
            const cutoff = new Date(Date.now() - GC_MIN_AGE_MS)
            const [current] = await db
                .select({ id: schema.docsSite.currentVersionId })
                .from(schema.docsSite)
                .where(eq(schema.docsSite.id, site.id))
            const protectedIds = [
                result.versionId,
                ...(site.currentVersionId ? [site.currentVersionId] : []),
                ...(current?.id ? [current.id] : []),
            ]
            const production = await db
                .select({
                    id: schema.docsContentVersion.id,
                    commitSha: schema.docsContentVersion.commitSha,
                    createdAt: schema.docsContentVersion.createdAt,
                })
                .from(schema.docsContentVersion)
                .where(
                    and(
                        eq(schema.docsContentVersion.siteId, site.id),
                        eq(schema.docsContentVersion.kind, "production"),
                        ne(schema.docsContentVersion.status, "failed"),
                        ne(schema.docsContentVersion.id, result.versionId),
                    ),
                )
                .orderBy(sql`${schema.docsContentVersion.seq} desc`)
            let doomedVersionIds = production
                .slice(env.DOCS_KEEP_VERSIONS)
                .filter(
                    (version) =>
                        !protectedIds.includes(version.id) &&
                        (version.createdAt < cutoff ||
                            // Watch-mode dev versions are never deployed.
                            (input.collectDevVersions &&
                                version.commitSha.startsWith("dev-"))),
                )
                .map((version) => version.id)
            const stale = await db
                .select({ id: schema.docsContentVersion.id })
                .from(schema.docsContentVersion)
                .where(
                    and(
                        eq(schema.docsContentVersion.siteId, site.id),
                        lt(schema.docsContentVersion.createdAt, cutoff),
                        or(
                            eq(schema.docsContentVersion.kind, "preview"),
                            eq(schema.docsContentVersion.status, "failed"),
                        ),
                        notInArray(schema.docsContentVersion.id, protectedIds),
                    ),
                )
            doomedVersionIds.push(...stale.map((version) => version.id))

            // A doomed version's blobs go before its rows, and its rows only
            // once its blobs are gone (deleteDoomedVersionBlobs).
            doomedVersionIds = await deleteDoomedVersionBlobs(
                doomedVersionIds,
                namespace,
            )
            if (doomedVersionIds.length > 0) {
                // Pages, assets and the rest cascade with their version.
                await db
                    .delete(schema.docsContentVersion)
                    .where(
                        inArray(schema.docsContentVersion.id, doomedVersionIds),
                    )
                console.log(
                    `[ingest] collected ${doomedVersionIds.length} old version(s)`,
                )
            }

            // This build's own leftovers: a corpus uploaded for a commit that was
            // already ingested, or the blobs of a version --force replaced. No
            // row references them any more, so a failed delete only leaks.
            const leftovers = new Set<string>()
            if (result.outcome === "already-ingested") {
                if (result.unusedSearchCorpusUrl)
                    leftovers.add(result.unusedSearchCorpusUrl)
            } else {
                for (const url of result.replacedSearchCorpusUrls)
                    leftovers.add(url)
                for (const candidate of result.replacedBlobCandidates)
                    leftovers.add(candidate.blobUrl)
            }
            await deleteUnreferencedBlobs(leftovers, namespace)
            return 0
        } finally {
            try {
                await lock.query("select pg_advisory_unlock($1)", [
                    DOCS_BLOB_LOCK_KEY.toString(),
                ])
            } finally {
                await lock.end()
            }
        }
    } catch (error) {
        // An internal failure before the version committed still records the
        // attempt, so it is visible and a production failure advances the
        // ordering watermark. Cleanup after the commit leaves the version be.
        if (!persisted)
            await fail(
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error),
                "internal",
            )
        throw error
    }
}

if (!flags.watch) {
    const sha =
        flags.sha ??
        env.DOCS_CONTENT_SHA ??
        env.VERCEL_GIT_COMMIT_SHA ??
        (await gitOutput(["rev-parse", "HEAD"])) ??
        `dev-${Date.now()}`
    let code = 1
    try {
        code = await ingest({ sha, kind, force, collectDevVersions: false })
    } finally {
        await db.$client.end()
    }
    process.exit(code)
}

// Watch: one ingest at a time; changes during a run queue exactly one more.
let running = false
let queued = false
const ingestNow = async () => {
    if (running) {
        queued = true
        return
    }
    running = true
    try {
        await ingest({
            sha: `dev-${Date.now()}`,
            kind: "production",
            force: false,
            collectDevVersions: true,
        })
    } catch (error) {
        console.error(error)
    } finally {
        running = false
    }
    if (queued) {
        queued = false
        await ingestNow()
    }
}
let timer: ReturnType<typeof setTimeout> | undefined
watch(dir, { recursive: true }, (_event, file) => {
    if (file && /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/.test(file))
        return
    clearTimeout(timer)
    timer = setTimeout(() => void ingestNow(), 300)
})
console.log(`[ingest] watching ${dir}`)
await ingestNow()
