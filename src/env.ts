import { createEnv } from "@t3-oss/env-core"
import { vercel } from "@t3-oss/env-core/presets-zod"
import { z } from "zod"

const vercelEnv = vercel()
const vercelSiteOrigin =
    typeof window === "undefined" &&
    vercelEnv.VERCEL_ENV === "production" &&
    vercelEnv.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${vercelEnv.VERCEL_PROJECT_PRODUCTION_URL}`
        : typeof window === "undefined" && vercelEnv.VERCEL_URL
          ? `https://${vercelEnv.VERCEL_URL}`
          : undefined

/** The library default throws a bare "Invalid environment variables" and
 * prints the names only to the console. Name the keys in the thrown message
 * so an error report is actionable on its own. */
function rejectInvalid(
    issues: readonly { path?: readonly unknown[] }[],
): never {
    const keys = [
        ...new Set(issues.map((issue) => issue.path?.join(".") ?? "")),
    ]
        .filter(Boolean)
        .join(", ")
    throw new Error(`Invalid environment variables: ${keys || "unknown"}`)
}

/**
 * Every setting is optional except the database (src/db/env.ts) and, off
 * Vercel, SITE_ORIGIN. Unset integrations stay off: no Sentry without a DSN,
 * no PostHog without a key, and the assistant only when an AI Gateway
 * credential resolves.
 */
export const env = createEnv({
    extends: [vercelEnv],
    clientPrefix: "PUBLIC_",
    client: {},
    shared: {
        VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
        NODE_ENV: z
            .enum(["development", "test", "production"])
            .default("development"),
        // Absolute site origin. Vercel deployments derive it from the
        // deployment hostname; everywhere else it must be set explicitly.
        SITE_ORIGIN: vercelSiteOrigin
            ? z.string().url().default(vercelSiteOrigin)
            : z.string().url(),
        /** Display name; unset falls back to docs.json `name`, then the slug.
         * Inlined into the browser bundle at build (vite.config.ts). */
        SITE_NAME: z.string().min(1).optional(),
        /** The commit whose ingested content this build serves. Baked in at
         * build (vite.config.ts `define`); unset (dev) serves the site's
         * current pointer. */
        DOCS_CONTENT_SHA: z.string().min(1).max(64).optional(),
    },
    server: {
        /** docs_site.slug of the one site the default extension serves; also
         * its cache tag. The extension validates it against
         * docsSiteSlugSchema (kept out of this browser-shared module). */
        SITE_SLUG: z.string().min(1).default("docs"),
        /** "0" stops production deployments redirecting to SITE_ORIGIN's host. */
        DOCS_CANONICAL_REDIRECT: z.enum(["0", "1"]).default("1"),
        DOCS_CHAT_MODEL: z.string().min(1).default("openai/gpt-5.6-terra"),
        /** AI Gateway credential off Vercel; on Vercel the OIDC token works. */
        AI_GATEWAY_API_KEY: z.string().min(1).optional(),
        /** Base URI of the agent-surface link relations (RFC 8288 §2.1.2). */
        DOCS_LINK_RELATION_BASE: z
            .string()
            .url()
            .default(
                "https://github.com/maniculehq/margin/blob/main/docs/link-relations.md#",
            ),
        DATABASE_URL: z.string().min(1).optional(),
        /** Optional: lifts the GitHub API limit for the server-side stars
         * widget from 60/h per IP to 5000/h. */
        GITHUB_TOKEN: z.string().min(1).optional(),
        POSTHOG_KEY: z.string().min(1).optional(),
        POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
        SENTRY_DSN: z.string().min(1).optional(),
        SENTRY_ORG: z.string().min(1).optional(),
        SENTRY_PROJECT: z.string().min(1).optional(),
        SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
        SENTRY_ENVIRONMENT: z.string().min(1).optional(),
        SENTRY_RELEASE: z.string().min(1).optional(),
        NITRO_PRESET: z.string().min(1).default("vercel"),
        // Dev server port (vite ignores PORT itself; vite.config.ts forwards
        // this as server.port).
        PORT: z.coerce.number().int().positive().optional(),
    },
    runtimeEnv: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV,
        // Listed explicitly (not only via the spread) so vite.config.ts can
        // inline the build-time values into the browser bundle with `define`.
        SITE_ORIGIN: process.env.SITE_ORIGIN,
        SITE_NAME: process.env.SITE_NAME,
        DOCS_CONTENT_SHA: process.env.DOCS_CONTENT_SHA,
        VERCEL_ENV: process.env.VERCEL_ENV,
    },
    emptyStringAsUndefined: true,
    onValidationError: rejectInvalid,
})

export const deploymentEnvironment = env.VERCEL_ENV ?? env.NODE_ENV

/** Whether the Ask-AI assistant can reach a model: an AI Gateway key, or the
 * deployment's OIDC token on Vercel (present in the environment off-request,
 * and on every Vercel function). Without one the chrome falls back to the
 * static search dialog and /api/chat refuses. Read at call time: Vercel
 * refreshes the OIDC token on a running instance. */
export function assistantAvailable(): boolean {
    return Boolean(
        process.env.AI_GATEWAY_API_KEY ||
            process.env.VERCEL_OIDC_TOKEN ||
            process.env.VERCEL,
    )
}
