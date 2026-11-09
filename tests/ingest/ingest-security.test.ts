import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { compileDocs } from "@/ingest/compile"
import { CONFIG_EXTENSION_KEY } from "@/types/docs"

const PIXEL = new Uint8Array([137, 80, 78, 71])
const PIXEL_HASH = createHash("sha256").update(PIXEL).digest("hex")

const contextualSchema = z.object({
    contextual: z.object({
        options: z.array(
            z.union([z.string(), z.record(z.string(), z.unknown())]),
        ),
    }),
})

describe("agent-only visibility never leaks into human metadata", () => {
    it("skips nested inline agent-only content in titles and excerpts", async () => {
        const compiled = await compileDocs([
            {
                path: "install.mdx",
                kind: "text",
                content:
                    '# Install <Visibility for="agents">AGENTTITLE</Visibility>\n\nHuman intro <Visibility for="agents">AGENTSECRET</Visibility> continues.\n',
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        expect(page?.title).toBe("Install")
        expect(page?.description).toContain("Human intro")
        expect(page?.description).toContain("continues.")
        expect(page?.description).not.toContain("AGENTSECRET")
    })

    it("falls through to the filename title when the whole H1 is agent-only", async () => {
        const compiled = await compileDocs([
            {
                path: "quick-start.mdx",
                kind: "text",
                content:
                    '# <Visibility for="agents">secret heading</Visibility>\n\nBody text.\n',
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages[0]
        expect(page?.title).not.toContain("secret")
        expect(page?.title).toBe("Quick Start")
    })
})

describe("page-level contextual overrides get asset admission at ingest", () => {
    it("hashes local src/icon, keeps allow-listed externals, drops denied hosts", async () => {
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "Ctx",
                    [CONFIG_EXTENSION_KEY]: {
                        assets: { allowExternal: ["cdn.example.com"] },
                    },
                }),
            },
            {
                path: "ctx.mdx",
                kind: "text",
                content: [
                    "---",
                    "title: Ctx",
                    "contextual:",
                    "  options:",
                    "    - copy",
                    "    - title: Run",
                    "      description: Runs it",
                    "      href: https://example.com/run",
                    "      src: /images/pixel.png",
                    "      icon: /images/pixel.png",
                    "    - title: Ext",
                    "      description: Allowed external",
                    "      href: https://example.com/ok",
                    "      src: https://cdn.example.com/x.png",
                    "    - title: Bad",
                    "      description: Denied external",
                    "      href: https://example.com/bad",
                    "      src: https://evil.example.com/x.png",
                    "---",
                    "",
                    "# Ctx",
                    "",
                    "Body.",
                    "",
                ].join("\n"),
            },
            {
                path: "images/pixel.png",
                kind: "binary",
                bytes: PIXEL,
            },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages.find((entry) => entry.path === "ctx.mdx")
        const { contextual } = contextualSchema.parse(page?.frontmatter)
        const [, run, ext, bad] = contextual.options
        expect(run).toMatchObject({
            src: `/_assets/${PIXEL_HASH}`,
            icon: `/_assets/${PIXEL_HASH}`,
        })
        expect(ext).toMatchObject({ src: "https://cdn.example.com/x.png" })
        expect(bad).toMatchObject({ title: "Bad", src: undefined })
        expect(
            compiled.diagnostics.some(
                (diagnostic) =>
                    diagnostic.code === "asset_missing" &&
                    diagnostic.message.includes("contextual.options[3].src"),
            ),
        ).toBe(true)
    })
})
