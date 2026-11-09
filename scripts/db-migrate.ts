/**
 * Applies the generated migrations in ./drizzle to the configured database
 * (`bun run db:migrate`). Prefers the direct (non-pooled) URL, which hosted
 * Postgres providers recommend for schema changes. Every pending migration
 * runs in one transaction, so a failure leaves the database untouched, and a
 * database that is already up to date is left alone.
 */
import { resolve } from "node:path"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client } from "pg"
import { z } from "zod"
import { resolveEnv } from "../src/db/env"

const env = resolveEnv()
// One client, so the session setting below covers every migration statement.
const client = new Client({
    connectionString: env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL,
})
await client.connect()
try {
    // Request sessions default to a 20 s statement_timeout (set below); this
    // direct migration session opts out so long DDL can finish.
    await client.query("set statement_timeout = 0")
    await migrate(drizzle({ client }), {
        migrationsFolder: resolve(import.meta.dirname, "../drizzle"),
    })
    console.log("[db:migrate] database is up to date")
    try {
        await client.query(
            `do $$ begin execute format('alter role current_user in database %I set statement_timeout = %L', current_database(), '20s'); end $$`,
        )
    } catch (error) {
        const pgError = z.object({ code: z.string() }).safeParse(error)
        // 42501 insufficient_privilege: the schema is current, only the
        // request-session default is missing, so warn instead of failing.
        if (!pgError.success || pgError.data.code !== "42501") throw error
        console.warn(
            "[db:migrate] WARNING: could not set statement_timeout = '20s' for this role (insufficient privilege). Run `ALTER ROLE <role> IN DATABASE <db> SET statement_timeout = '20s'` as an owner so a runaway query cannot hold a connection indefinitely.",
        )
    }
} finally {
    await client.end()
}
