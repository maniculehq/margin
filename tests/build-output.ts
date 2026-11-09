import { existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The client assets of the last build: `.output/public/_margin/assets` from
 * `NITRO_PRESET=node-server bun run build`, or Vercel's static output.
 * Undefined without a build; build-dependent suites skip locally and fail in
 * CI and on Vercel, so a moved output directory cannot pass them as a no-op.
 */
export const ASSETS_DIR = [
    ".output/public/_margin/assets",
    ".vercel/output/static/_margin/assets",
]
    .map((dir) => resolve(import.meta.dirname, "..", dir))
    .find((dir) => existsSync(dir))

export const REQUIRE_BUILD = Boolean(process.env.CI || process.env.VERCEL)
