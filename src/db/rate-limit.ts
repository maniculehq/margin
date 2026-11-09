/**
 * The Postgres-backed limiter behind the public endpoints (the Ask-AI chat
 * and the feedback route). Counters live in `public_rate_limit`, so a limit
 * holds across every instance that shares the database.
 */
import { sql } from "drizzle-orm"
import { db, schema } from "./index"

export interface RateLimitRule {
    bucket: string
    limit: number
    windowMs: number
    key: string
}

export interface RateLimitResult {
    allowed: boolean
    retryAfterSeconds?: number
    resetAt?: Date
}

/**
 * Counts one hit against every rule in a single multi-row upsert. Rules
 * sharing a `(bucket, key)` counter collapse to one row (Postgres refuses to
 * update a row twice in one statement), so each is judged against the same
 * count; the row's window comes from the first such rule. Each row resets at
 * its own `resetAt` to its own window via `excluded.reset_at`.
 */
export async function enforceRateLimits(
    rules: readonly RateLimitRule[],
): Promise<RateLimitResult> {
    if (rules.length === 0) return { allowed: true }
    const now = new Date()
    const nowTimestamp = now.toISOString()
    const counters = new Map<
        string,
        typeof schema.publicRateLimit.$inferInsert
    >()
    for (const rule of rules) {
        const counterKey = `${rule.bucket}\u0000${rule.key}`
        if (counters.has(counterKey)) continue
        counters.set(counterKey, {
            id: crypto.randomUUID(),
            bucket: rule.bucket,
            key: rule.key,
            count: 1,
            resetAt: new Date(now.getTime() + rule.windowMs),
        })
    }
    const table = schema.publicRateLimit
    const rows = await db
        .insert(table)
        .values([...counters.values()])
        .onConflictDoUpdate({
            target: [table.bucket, table.key],
            set: {
                count: sql<number>`case when ${table.resetAt} <= ${nowTimestamp}::timestamp then 1 else ${table.count} + 1 end`,
                resetAt: sql<Date>`case when ${table.resetAt} <= ${nowTimestamp}::timestamp then excluded.reset_at else ${table.resetAt} end`,
                updatedAt: now,
            },
        })
        .returning({
            bucket: table.bucket,
            key: table.key,
            count: table.count,
            resetAt: table.resetAt,
        })
    const byCounter = new Map(
        rows.map((row) => [`${row.bucket}\u0000${row.key}`, row]),
    )

    let mostConstrained: RateLimitResult | null = null
    for (const rule of rules) {
        const row = byCounter.get(`${rule.bucket}\u0000${rule.key}`)
        if (!row || row.count <= rule.limit) continue
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000),
        )
        if (retryAfterSeconds > (mostConstrained?.retryAfterSeconds ?? 0)) {
            mostConstrained = {
                allowed: false,
                resetAt: row.resetAt,
                retryAfterSeconds,
            }
        }
    }

    return mostConstrained ?? { allowed: true }
}
