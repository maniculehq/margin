import {
    boolean,
    foreignKey,
    index,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core"
import { docsContentVersion } from "./content"
import { docsAgentFeedbackKindEnum, docsAgentFeedbackSourceEnum } from "./enums"
import { docsSite } from "./site"

/**
 * Feedback on a docs page from the thumbs widgets, the Assistant, or agents
 * (HTTP and MCP). Written by the public feedback endpoint — best-effort
 * telemetry, so the row records what was claimed (`source`, page URL)
 * without authenticating it, `answerId` included. `versionId` is the version served when it
 * arrived; it survives that version's deletion.
 */
export const docsAgentFeedback = pgTable(
    "docs_agent_feedback",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        siteId: varchar("site_id", { length: 36 }).notNull(),
        versionId: varchar("version_id", { length: 36 }),
        pageUrl: text("page_url").notNull(),
        pageExists: boolean("page_exists").notNull(),
        kind: docsAgentFeedbackKindEnum("kind").notNull(),
        source: docsAgentFeedbackSourceEnum("source").notNull(),
        message: text("message"),
        suggestedFix: text("suggested_fix"),
        /** The Assistant answer a chat-answer thumb rates: the id /api/chat
         * minted for it. Null for page thumbs, agent reports and MCP. */
        answerId: varchar("answer_id", { length: 36 }),
        agentName: varchar("agent_name", { length: 255 }),
        agentKind: varchar("agent_kind", { length: 64 }),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
    },
    (table) => [
        index("docs_agent_feedback_site_created_idx").on(
            table.siteId,
            table.createdAt.desc(),
            table.id.desc(),
        ),
        foreignKey({
            columns: [table.siteId],
            foreignColumns: [docsSite.id],
            name: "docs_agent_feedback_site_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.versionId],
            foreignColumns: [docsContentVersion.id],
            name: "docs_agent_feedback_version_id_fk",
        }).onDelete("set null"),
    ],
)
