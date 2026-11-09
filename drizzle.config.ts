import { defineConfig } from "drizzle-kit"

// Migrations and introspection go through a direct connection when one is
// configured: poolers in transaction mode drop the session state DDL relies
// on. `generate` reads only the schema files and needs no connection.
const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL

export default defineConfig({
    dialect: "postgresql",
    // Every table and enum module, but not index.ts: it re-exports them all,
    // and drizzle-kit would read each object twice.
    schema: [
        "./src/db/schema/enums.ts",
        "./src/db/schema/site.ts",
        "./src/db/schema/content.ts",
        "./src/db/schema/feedback.ts",
        "./src/db/schema/rate-limit.ts",
    ],
    out: "./drizzle",
    ...(url ? { dbCredentials: { url } } : {}),
})
