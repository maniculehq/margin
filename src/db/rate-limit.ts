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
}

/**
 * Counts one hit against the rule's fixed-window counter in a single
 * upsert. A counter past its `resetAt` starts a new window at this hit.
 */
export async function enforceRateLimit(
    rule: RateLimitRule,
): Promise<RateLimitResult> {
    const now = new Date()
    const nowTimestamp = now.toISOString()
    const table = schema.publicRateLimit
    const [row] = await db
        .insert(table)
        .values({
            id: crypto.randomUUID(),
            bucket: rule.bucket,
            key: rule.key,
            count: 1,
            resetAt: new Date(now.getTime() + rule.windowMs),
        })
        .onConflictDoUpdate({
            target: [table.bucket, table.key],
            set: {
                count: sql<number>`case when ${table.resetAt} <= ${nowTimestamp}::timestamp then 1 else ${table.count} + 1 end`,
                resetAt: sql<Date>`case when ${table.resetAt} <= ${nowTimestamp}::timestamp then excluded.reset_at else ${table.resetAt} end`,
                updatedAt: now,
            },
        })
        .returning({ count: table.count, resetAt: table.resetAt })
    if (!row || row.count <= rule.limit) return { allowed: true }
    return {
        allowed: false,
        retryAfterSeconds: Math.max(
            1,
            Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000),
        ),
    }
}
