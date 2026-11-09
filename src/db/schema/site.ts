import {
    bigint,
    boolean,
    foreignKey,
    type PgTableExtraConfigValue,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    varchar,
} from "drizzle-orm/pg-core"
import { docsContentVersion } from "./content"
import { docsSiteAnalyticsModeEnum, docsSiteStatusEnum } from "./enums"

/**
 * One row per docs site: its slug, display copy, the repository its content
 * comes from, and the pointer to the content version it serves. A
 * single-site install has exactly one row.
 *
 * currentVersionSeq mirrors current_version.seq and is the monotonic flip
 * guard: racing ingests both build, but only the higher seq wins the pointer
 * (never keyed on git commit dates — those are author-controlled).
 */
export const docsSite = pgTable(
    "docs_site",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        slug: varchar("slug", { length: 63 }).notNull(),
        name: varchar("name", { length: 255 }).notNull(),
        description: text("description").notNull().default(""),
        repoOwner: varchar("repo_owner", { length: 255 }),
        repoName: varchar("repo_name", { length: 255 }),
        /** Branch whose builds flip production content. */
        branch: varchar("branch", { length: 255 }).notNull().default("main"),
        /** Repo subdirectory holding the docs ("" = repo root). */
        subdir: text("subdir").notNull().default(""),
        status: docsSiteStatusEnum("status").notNull().default("provisioning"),
        /**
         * "off" suppresses the site's configured analytics integrations at
         * serve time, so mirrored test content carrying third-party analytics
         * keys never fires them.
         */
        analyticsMode: docsSiteAnalyticsModeEnum("analytics_mode").notNull(),
        /** Opt-in to experimental WebMCP tools on the site's pages. */
        webmcpEnabled: boolean("webmcp_enabled").notNull().default(false),
        currentVersionId: varchar("current_version_id", { length: 36 }),
        currentVersionSeq: bigint("current_version_seq", { mode: "number" })
            .notNull()
            .default(0),
        /**
         * Ingest-ordering counter, claimed atomically before a build runs. A
         * slow build of an older commit carries a lower claimed seq and loses
         * the flip guard to any newer build — ordering must never derive from
         * build-completion time.
         */
        ingestSeq: bigint("ingest_seq", { mode: "number" })
            .notNull()
            .default(0),
        /** When a production build first went live; claimed once (analytics). */
        firstBuildAt: timestamp("first_build_at", { mode: "date" }),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp("updated_at", { mode: "date" })
            .defaultNow()
            .$onUpdate(() => /* @__PURE__ */ new Date())
            .notNull(),
    },
    // explicit return type breaks the TS inference cycle from the mutual FK
    (table): PgTableExtraConfigValue[] => [
        uniqueIndex("docs_site_slug_uidx").on(table.slug),
        foreignKey({
            columns: [table.currentVersionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_site_current_version_id_fk",
        }).onDelete("set null"),
    ],
)
