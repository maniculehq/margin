import {
    index,
    integer,
    pgTable,
    timestamp,
    uniqueIndex,
    varchar,
} from "drizzle-orm/pg-core"

/** Fixed-window counters behind enforceRateLimit (src/db/rate-limit.ts). */
export const publicRateLimit = pgTable(
    "public_rate_limit",
    {
        id: varchar("id", { length: 36 }).primaryKey(),
        bucket: varchar("bucket", { length: 96 }).notNull(),
        key: varchar("key", { length: 160 }).notNull(),
        count: integer("count").notNull().default(0),
        resetAt: timestamp("reset_at", { mode: "date" }).notNull(),
        createdAt: timestamp("created_at", { mode: "date" })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp("updated_at", { mode: "date" })
            .defaultNow()
            .$onUpdate(() => /* @__PURE__ */ new Date())
            .notNull(),
    },
    (table) => [
        uniqueIndex("public_rate_limit_bucket_key_uidx").on(
            table.bucket,
            table.key,
        ),
        index("public_rate_limit_reset_at_idx").on(table.resetAt),
    ],
)
