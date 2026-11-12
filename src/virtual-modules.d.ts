/**
 * Build-time virtual module (see resvgWasmBase64 in vite.config.ts): the
 * @resvg/resvg-wasm binary as base64 — the only delivery mechanism that
 * survives Vercel function bundling.
 */
declare module "virtual:resvg-wasm-base64" {
    const wasmBase64: string
    export default wasmBase64
}

/**
 * Build-time virtual module (see chromeIcons in vite.config.ts): the few
 * Hugeicons SVGs the framework chrome and code-tab triggers need, extracted
 * from the committed 2 MB icon map so the map itself never ships.
 */
declare module "virtual:chrome-icons" {
    const icons: Record<string, string>
    export default icons
}

/**
 * Build-time virtual module (see sandboxRenderBundle in
 * src/sandbox/bundle-plugin.ts): the self-contained IIFE that
 * src/lib/sandbox-render.ts evaluates inside an isolated-vm isolate.
 */
declare module "virtual:sandbox-render-bundle" {
    const bundle: string
    export default bundle
}

/**
 * Build-time alias (see vite.config.ts): the DocsExtensions module the
 * server consumes — src/extensions/default.ts unless DOCS_EXTENSIONS names
 * another. A replacement must export `extensions: DocsExtensions`.
 */
declare module "#docs-extensions" {
    export const extensions: typeof import("./extensions/default").extensions
}

/**
 * Build-time alias (see vite.config.ts): the browser half of the
 * extensions, src/extensions/browser-default.ts unless
 * DOCS_BROWSER_EXTENSIONS names another. A replacement must export
 * `browserExtensions: DocsBrowserExtensions`.
 */
declare module "#docs-browser-extensions" {
    export const browserExtensions: typeof import("./extensions/browser-default").browserExtensions
}
