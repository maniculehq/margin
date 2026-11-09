import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { sandboxRenderBundle } from "./src/sandbox/bundle-plugin.ts"
import { chromeIcons, resvgWasmBase64 } from "./vite-plugins.ts"

export default defineConfig({
    // Component tests import chrome-icons.tsx, which reads the build-time
    // virtual module; the OG route test rasterizes through the resvg one;
    // the sandbox render test loads the isolate bundle through
    // virtual:sandbox-render-bundle.
    plugins: [chromeIcons(), resvgWasmBase64(), sandboxRenderBundle()],
    resolve: {
        tsconfigPaths: true,
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // Same seam as vite.config.ts: DOCS_EXTENSIONS runs the suite
            // against a host's DocsExtensions module instead of the default.
            "#docs-extensions": process.env.DOCS_EXTENSIONS
                ? resolve(import.meta.dirname, process.env.DOCS_EXTENSIONS)
                : resolve(import.meta.dirname, "src/extensions/default.ts"),
        },
    },
    test: {
        environment: "node",
        // The framework env requires SITE_ORIGIN outside Vercel (no localhost
        // fallback); tests run off-Vercel, so give them a dead test origin.
        env: { SITE_ORIGIN: "https://docs.test.invalid" },
        include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
        server: {
            deps: {
                // image-zoom.js imports its CSS directly (unlike the rest of
                // fumadocs-ui, whose styles ride the preset) — inline the
                // package so Vite handles the .css import instead of Node's
                // ESM loader choking on it.
                inline: [/fumadocs-ui/],
            },
        },
    },
})
