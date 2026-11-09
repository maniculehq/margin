import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

// Called (not run at import) so importing the database module never demands a
// connection string: build steps and tests that never query load it freely.
// Validation happens on first use.
export function resolveEnv() {
    return createEnv({
        server: {
            DATABASE_URL: z.string().min(1),
            // Direct (non-pooled) connection for migrations; unset means the
            // pooled URL is used for those too.
            DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
            // Per-instance pg pool size. Unset means 2: small enough that a
            // fleet of warm serverless instances stays inside a pooler's
            // connection budget.
            DATABASE_POOL_MAX: z.coerce
                .number()
                .int()
                .min(1)
                .max(20)
                .optional(),
        },
        // The first non-empty name wins. Neon's Vercel integration sets both
        // the DATABASE_* and POSTGRES_* names; Vercel Postgres sets only the
        // POSTGRES_* ones.
        runtimeEnvStrict: {
            DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL,
            DATABASE_URL_UNPOOLED:
                process.env.DATABASE_URL_UNPOOLED ||
                process.env.POSTGRES_URL_NON_POOLING,
            DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
        },
        emptyStringAsUndefined: true,
        // The library default throws a bare "Invalid environment variables"
        // and prints the names only to the console. Name the keys in the
        // thrown message so an error report is actionable on its own.
        onValidationError: (issues) => {
            const keys = [
                ...new Set(issues.map((issue) => issue.path?.join(".") ?? "")),
            ]
                .filter(Boolean)
                .join(", ")
            throw new Error(
                `Invalid environment variables: ${keys || "unknown"} (missing or empty)`,
            )
        },
    })
}
