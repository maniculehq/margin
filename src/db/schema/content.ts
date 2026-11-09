import { sql } from "drizzle-orm"
import {
    bigint,
    boolean,
    check,
    customType,
    foreignKey,
    index,
    integer,
    jsonb,
    type PgTableExtraConfigValue,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    varchar,
} from "drizzle-orm/pg-core"
import {
    docsBuildErrorKindEnum,
    docsContentVersionKindEnum,
    docsContentVersionStatusEnum,
    docsLayoutPresetEnum,
    docsNavSourceEnum,
    docsPageKindEnum,
} from "./enums"
import { docsSite } from "./site"

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
    dataType: () => "bytea",
    toDriver: (value) => Buffer.from(value),
})

/** Immutable snapshot for each ingested build. Production switches the site
 * pointer; previews resolve by commit SHA. The unique site/SHA/kind key makes
 * rebuilds of the same commit idempotent while allowing a preview SHA to
 * become production. */
export const docsContentVersion = pgTable(
    "docs_content_version",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        commitSha: varchar("commit_sha", { length: 64 }).notNull(),
        kind: docsContentVersionKindEnum("kind")
            .notNull()
            .default("production"),
        prNumber: integer("pr_number"),
        seq: bigint("seq", { mode: "number" }).notNull(),
        status: docsContentVersionStatusEnum("status")
            .notNull()
            .default("building"),
        error: text("error"),
        /** Failed rows only: whether `error` is author-facing (content) or a raw pipeline exception (internal). */
        errorKind: docsBuildErrorKindEnum("error_kind"),
        pageCount: integer("page_count").notNull().default(0),
        /**
         * Pipeline version of the ingest code that built this row; 0 =
         * pre-stamping. Read only by ingest (never serving) — a stale stamp
         * on a site's current production version triggers a re-ingest.
         */
        pipelineVersion: integer("pipeline_version").notNull().default(0),
        config: jsonb("config"),
        themeTokens: jsonb("theme_tokens"),
        versionsManifest: jsonb("versions_manifest"),
        redirects: jsonb("redirects"),
        seo: jsonb("seo"),
        integrations: jsonb("integrations"),
        diagnostics: jsonb("diagnostics"),
        localesManifest: jsonb("locales_manifest"),
        themeCss: text("theme_css"),
        /**
         * Inlined Google Fonts @font-face CSS, served ahead of themeCss.
         * Regenerable from fontInputs without a re-ingest (the documented
         * exception to version immutability — it is derived, content-free,
         * and keyed by stored inputs).
         */
        fontCss: text("font_css").notNull().default(""),
        /** DocsFontInputs the fontCss was resolved from. */
        fontInputs: jsonb("font_inputs"),
        navSource: docsNavSourceEnum("nav_source"),
        layoutPreset: docsLayoutPresetEnum("layout_preset"),
        /**
         * Derived, rebuildable search corpus — a gzipped
         * `{ formatVersion: 1, entries: [...] }` envelope; structured page
         * rows remain authoritative. Stored inline so an install without a
         * blob store serves search from Postgres alone.
         */
        searchCorpus: bytea("search_corpus"),
        /** The same corpus in a blob store, for installs that configure one. */
        searchCorpusUrl: text("search_corpus_url"),
        /** Git committer date of the built HEAD — informational only, never an ordering key. */
        headCommittedAt: timestamp("head_committed_at", { mode: "date" }),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
        builtAt: timestamp("built_at", { mode: "date" }),
    },
    // explicit return type breaks the TS inference cycle from the mutual FK
    (table): PgTableExtraConfigValue[] => [
        // Partial: failed attempts are per-attempt history keyed by their
        // claimed seq — a rebuild of an UNCHANGED sha must be able to record
        // its failure without touching the ready row that is still serving
        // (current_version_id pins serving; build history renders by seq).
        uniqueIndex("docs_content_version_site_sha_kind_uidx")
            .on(table.siteId, table.commitSha, table.kind)
            .where(sql`${table.status} <> 'failed'`),
        // A ready version must be searchable: its corpus lives inline or in
        // a blob store, never nowhere.
        check(
            "docs_content_version_ready_corpus_check",
            sql`${table.status} <> 'ready' or ${table.searchCorpus} is not null or ${table.searchCorpusUrl} is not null`,
        ),
        uniqueIndex("docs_content_version_site_seq_uidx").on(
            table.siteId,
            table.seq,
        ),
        index("docs_content_version_site_kind_pr_idx").on(
            table.siteId,
            table.kind,
            table.prNumber,
        ),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_content_version_site_id_fk",
        }).onDelete("cascade"),
    ],
)

/** One ingested page version holds rendered content, agent markdown, code examples, and search data. OpenAPI pages store serialized page props separately; authored MDX may also attach an API console via frontmatter. */
export const docsPage = pgTable(
    "docs_page",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        versionId: varchar("version_id", { length: 36 }).notNull(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        kind: docsPageKindEnum("kind").notNull().default("mdx"),
        /** Virtual source path within the docs root, e.g. "guides/intro.mdx". */
        path: text("path").notNull(),
        versionLabel: text("version_label"),
        /** navigation.languages locale tag; null = the default locale. */
        localeLabel: text("locale_label"),
        url: text("url").notNull(),
        servedUrl: text("served_url").notNull(),
        slugs: jsonb("slugs").notNull(),
        title: varchar("title", { length: 255 }).notNull(),
        description: text("description"),
        icon: varchar("icon", { length: 255 }),
        hidden: boolean("hidden"),
        frontmatter: jsonb("frontmatter").notNull(),
        /** Human rendition for PDFs, with snippets and variables resolved at ingest (pipeline v33+). */
        source: text("source").notNull(),
        compiledJs: text("compiled_js"),
        /**
         * Final post-rehype hast for SSR-eligible pages — pure data the
         * framework renders server-side. Mutually exclusive with compiledJs
         * (the client-executed fallback for expression/snippet pages); both
         * null for kind="openapi".
         */
        hast: jsonb("hast"),
        /**
         * Desktop right-rail tree (authored <Panel> / pinned examples), split
         * from `hast` at ingest; null = standard TOC rail.
         */
        railHast: jsonb("rail_hast"),
        processedMarkdown: text("processed_markdown").notNull(),
        /** DocsCodeExample[] precomputed at ingest — MCP/agent surfaces read this. */
        codeExamples: jsonb("code_examples").notNull().default([]),
        /**
         * DocsPageOpenapiProps for kind="openapi" rows and for kind="mdx"
         * rows carrying a frontmatter operation reference; null otherwise.
         */
        openapiProps: jsonb("openapi_props"),
        /**
         * DocsPageUpdates (authored <Update> entries) extracted at ingest;
         * null when the page authors none.
         */
        updates: jsonb("updates"),
        structuredData: jsonb("structured_data").notNull(),
        toc: jsonb("toc").notNull(),
        /**
         * Carried forward from the previous version when the page source hash
         * is unchanged; else the built HEAD's commit date.
         */
        lastModified: timestamp("last_modified", { mode: "date" }).notNull(),
    },
    (table) => [
        uniqueIndex("docs_page_version_path_uidx").on(
            table.versionId,
            table.path,
        ),
        // The framework resolves pages by served URL (servedUrlsPresent,
        // resolvePage, and the lower() case-insensitive 404 fallback).
        // Without these every lookup filtered all pages of the version.
        // Non-unique: served URLs are unique per version today, but ingest
        // does not enforce it. Not CONCURRENTLY: the migrator applies every
        // migration inside one transaction, where Postgres refuses
        // CREATE INDEX CONCURRENTLY.
        index("docs_page_version_served_url_idx").on(
            table.versionId,
            table.servedUrl,
        ),
        index("docs_page_version_lower_served_url_idx").on(
            table.versionId,
            sql`lower(${table.servedUrl})`,
        ),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_page_version_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_page_site_id_fk",
        }).onDelete("cascade"),
    ],
)

/**
 * One OpenAPI document per version per spec — the bundled (parsed, validated,
 * local-refs-only) spec that kind="openapi" pages of the same version render
 * from. Stored once so per-operation page rows stay light; serving attaches
 * it to the page props as `payload.bundled`. `servers` is the extracted
 * origin allowlist for the playground proxy.
 */
export const docsOpenapiDocument = pgTable(
    "docs_openapi_document",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        versionId: varchar("version_id", { length: 36 }).notNull(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        /** Schema id referenced by docs_page.openapi_props.document. */
        docId: varchar("doc_id", { length: 64 }).notNull(),
        /** Spec file path within the docs root, e.g. "openapi.yaml". */
        sourcePath: text("source_path").notNull(),
        /** sha256 of the bundled document JSON — lastModified carry-forward key. */
        specHash: varchar("spec_hash", { length: 64 }).notNull(),
        /** Nav section title, from docs.json or the default. */
        label: varchar("label", { length: 255 }).notNull(),
        /** URL folder under the docs root holding the generated pages. */
        basePath: text("base_path").notNull(),
        /** Bundled OpenAPI document (JSON object). */
        document: jsonb("document").notNull(),
        /** Origins from the spec's servers list — proxy allowlist. */
        servers: jsonb("servers").notNull(),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
    },
    (table) => [
        uniqueIndex("docs_openapi_document_version_docid_uidx").on(
            table.versionId,
            table.docId,
        ),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_openapi_document_version_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_openapi_document_site_id_fk",
        }).onDelete("cascade"),
    ],
)

/** Immutable binary asset collected while compiling a content version. */
export const docsAsset = pgTable(
    "docs_asset",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        versionId: varchar("version_id", { length: 36 }).notNull(),
        path: text("path").notNull(),
        contentHash: text("content_hash").notNull(),
        mimeType: text("mime_type").notNull(),
        bytes: bytea("bytes"),
        blobUrl: text("blob_url"),
        byteSize: integer("byte_size").notNull(),
        // Intrinsic image size measured at ingest (null for non-images).
        width: integer("width"),
        height: integer("height"),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
    },
    (table) => [
        // One row per source path: the serve-side source-path fallback
        // resolves by original repo path, and byte-identical sibling paths
        // each keep a row. Hash lookups (the /_assets route) stay indexed but
        // are not unique — duplicate-content paths share a hash; limit(1)
        // reads any of them.
        uniqueIndex("docs_asset_version_path_uidx").on(
            table.versionId,
            table.path,
        ),
        index("docs_asset_version_hash_idx").on(
            table.versionId,
            table.contentHash,
        ),
        index("docs_asset_site_hash_idx").on(table.siteId, table.contentHash),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_asset_site_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_asset_version_id_fk",
        }).onDelete("cascade"),
    ],
)

/** meta.json equivalents — page-tree ordering/grouping rows per version. */
export const docsMeta = pgTable(
    "docs_meta",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        versionId: varchar("version_id", { length: 36 }).notNull(),
        /** Virtual path, e.g. "meta.json" or "guides/meta.json". */
        path: text("path").notNull(),
        data: jsonb("data").notNull(),
    },
    (table) => [
        uniqueIndex("docs_meta_version_path_uidx").on(
            table.versionId,
            table.path,
        ),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_meta_version_id_fk",
        }).onDelete("cascade"),
    ],
)

/**
 * Authored Agent Skills (https://agentskills.io) discovered at ingest:
 * `.mintlify/skills/<name>/SKILL.md`, `skills/<name>/SKILL.md`, or a root
 * `skill.md`/`SKILL.md`. `body` is the SKILL.md exactly as authored
 * (frontmatter included) and is what the framework serves; `digest` is
 * `sha256:<hex>` over its UTF-8 bytes, so a served body always verifies.
 */
export const docsSkill = pgTable(
    "docs_skill",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        versionId: varchar("version_id", { length: 36 }).notNull(),
        name: varchar("name", { length: 64 }).notNull(),
        description: text("description").notNull(),
        /** Validated DocsSkillFrontmatter (src/types/docs-agent.ts). */
        frontmatter: jsonb("frontmatter").notNull(),
        body: text("body").notNull(),
        digest: varchar("digest", { length: 71 }).notNull(),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
    },
    (table) => [
        uniqueIndex("docs_skill_version_name_uidx").on(
            table.versionId,
            table.name,
        ),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_skill_version_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_skill_site_id_fk",
        }).onDelete("cascade"),
    ],
)

/**
 * The blob namespace each database writes under. Blob pathnames start with
 * the namespace, and a database deletes only blobs under its own, because
 * one Blob store commonly serves several databases (production, every
 * preview branch, local development) whose rows it cannot see. Keyed by a
 * fingerprint of the database's address: a branched or restored copy carries
 * its parent's row, but under the parent's fingerprint, so it mints its own
 * namespace instead of collecting the parent's blobs. See
 * src/ingest/assets.ts:resolveBlobNamespace.
 */
export const docsBlobNamespace = pgTable("docs_blob_namespace", {
    /** sha256 of the database's host, port and name. */
    databaseFingerprint: varchar("database_fingerprint", {
        length: 64,
    }).primaryKey(),
    namespace: varchar("namespace", { length: 36 }).notNull().unique(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
})
