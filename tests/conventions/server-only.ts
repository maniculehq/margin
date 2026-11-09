/**
 * Package modules the browser must never load, relative to the package
 * root. The client-build test fails if a client chunk bundles one; the
 * client-bundle source scan stops at them and fails when a module that is
 * not a compiler boundary imports one.
 */
export const SERVER_ONLY_MODULES = [
    "src/env.ts",
    // The DocsExtensions implementation (drizzle + the DB layer) behind
    // `#docs-extensions`.
    "src/extensions/default.ts",
    "src/lib/agent-content.ts",
    "src/lib/agent.config.ts",
    "src/lib/llms-index.ts",
    "src/lib/observability.ts",
    "src/lib/sandbox-render.ts",
    "src/lib/seo.ts",
    "src/lib/source.ts",
]

/** Whole directories and Node-only packages no client chunk may bundle. */
export const SERVER_ONLY_PATTERN =
    /^src\/(?:db|ingest)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:pg|pg-pool|drizzle-orm|posthog-node|@sentry\/node|isolated-vm)\//
