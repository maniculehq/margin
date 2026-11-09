import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { db, schema } from "@/db"
import { CONFIG_EXTENSION_KEY } from "@/types/constants"
import { hasDocsDb } from "../context"

// Record the real external SVG renderer's calls; rendering still runs.
vi.mock("satori", { spy: true })

describe.skipIf(!hasDocsDb)("ingested site identity", () => {
    it.each([
        { label: "changed", override: "Second docs", expected: "Second docs" },
        { label: "removed", override: undefined, expected: "Authored docs" },
    ])(
        "uses a $label deployment override on a same-SHA redeploy",
        async ({ label, override, expected }) => {
            const root = resolve(import.meta.dirname, "../..")
            const scratch = mkdtempSync(join(tmpdir(), "redeploy-identity-"))
            const slug = `redeploy-${randomUUID()}`
            const sha = "3".repeat(40)
            vi.stubEnv("SITE_SLUG", slug)
            vi.stubEnv("SITE_NAME", "First docs")
            vi.stubEnv("DOCS_CONTENT_SHA", sha)
            vi.stubEnv("VERCEL_ENV", undefined)
            vi.stubEnv("DOCS_CANONICAL_REDIRECT", "0")
            try {
                writeFileSync(
                    join(scratch, "docs.json"),
                    JSON.stringify({
                        name: "Authored docs",
                        description: "Authored description",
                        [CONFIG_EXTENSION_KEY]: {
                            agents: { markdownFrontmatter: true },
                        },
                    }),
                )
                // No authored index: ingest must generate a name-neutral home.
                writeFileSync(
                    join(scratch, "updates.mdx"),
                    '---\ntitle: Releases\n---\n\n<Update label="2026-10-12">Release notes.</Update>\n',
                )
                await promisify(execFile)(
                    "bun",
                    [
                        "scripts/ingest.ts",
                        "--dir",
                        scratch,
                        "--slug",
                        slug,
                        "--sha",
                        sha,
                    ],
                    {
                        cwd: root,
                        env: {
                            PATH: process.env.PATH,
                            DATABASE_URL: process.env.DATABASE_URL,
                            SITE_NAME: "First docs",
                        },
                    },
                )
                vi.resetModules()
                const first = await import("@/lib/source")
                const before = await first.resolveDocsContext(
                    new Request("https://docs.test.invalid/"),
                )
                expect(before.versionId).not.toBeNull()
                expect(before.identity.name).toBe("First docs")
                const beforePage = await first.resolvePage(
                    before,
                    before.source,
                    [],
                )
                if (!beforePage)
                    throw new Error("initial home page did not resolve")
                const beforeEtag = (
                    await import("@/lib/agent-content")
                ).htmlPageEtag(
                    before,
                    beforePage,
                    null,
                    "https://docs.test.invalid",
                )

                const rerun = await promisify(execFile)(
                    "bun",
                    [
                        "scripts/ingest.ts",
                        "--dir",
                        scratch,
                        "--slug",
                        slug,
                        "--sha",
                        sha,
                    ],
                    {
                        cwd: root,
                        env: {
                            PATH: process.env.PATH,
                            DATABASE_URL: process.env.DATABASE_URL,
                            SITE_NAME: override,
                        },
                    },
                )
                expect(rerun.stdout).toContain("already ingested")
                vi.stubEnv("SITE_NAME", override)
                vi.resetModules()
                const source = await import("@/lib/source")
                const request = new Request("https://docs.test.invalid/")
                const ctx = await source.resolveDocsContext(request)
                expect(ctx.versionId).toBe(before.versionId)
                expect(ctx.config).toMatchObject({
                    name: "Authored docs",
                    description: "Authored description",
                })
                expect(ctx.identity).toEqual({
                    name: expected,
                    description: "Authored description",
                })
                const page = await source.resolvePage(ctx, ctx.source, [])
                if (!page) throw new Error("ingested home page did not resolve")
                expect(page.data.sourcePath).toBe(beforePage.data.sourcePath)
                const agent = await import("@/lib/agent-content")
                const seo = (await import("@/lib/seo")).buildPageSeo({
                    siteUrl: "https://docs.test.invalid",
                    ctx,
                    source: ctx.source,
                    page,
                    imageUrl: "https://docs.test.invalid/og/docs",
                    apiReference: false,
                })
                expect(seo.siteName).toBe(expected)
                expect(seo.title).toContain(expected)
                expect(page.data.frontmatter.synthesized).toBe(true)
                expect(page.data.description).toBe("Explore the documentation.")
                const markdown = await (
                    await import("@/routes/{$}[.]md")
                ).getDocsMarkdown({
                    request: new Request("https://docs.test.invalid/index.md"),
                    params: { _splat: "index" },
                })
                expect(markdown.status).toBe(200)
                const body = await markdown.text()
                expect(body).toContain(
                    'description: "Explore the documentation."',
                )
                expect(body).toContain("# Overview (/)")
                expect(body).not.toContain("Authored docs")
                expect(
                    agent.htmlPageEtag(
                        ctx,
                        page,
                        null,
                        "https://docs.test.invalid",
                    ),
                ).not.toBe(beforeEtag)
                const card = (
                    await import("@/lib/mcp-discovery")
                ).mcpServerCard(ctx, "https://docs.test.invalid")
                expect(card.title).toBe(`${expected} docs`)
                expect(
                    (await import("@/lib/agent-skill")).renderSkill(
                        "https://docs.test.invalid",
                        ctx,
                    ),
                ).toContain(`# ${expected} — agent guide`)
                expect(
                    (await import("@/lib/agent-skills")).generatedSkill(
                        ctx,
                        "https://docs.test.invalid",
                    ).description,
                ).toContain(`Use the ${expected} documentation`)
                expect(
                    agent.buildLlmsManifest(
                        "https://docs.test.invalid",
                        ctx,
                        false,
                    ).name,
                ).toBe(expected)
                const llms = await (
                    await import("@/lib/llms-index")
                ).llmsIndexResponse(request, [])
                expect(llms.status).toBe(200)
                expect(await llms.text()).toContain(`# ${expected}\n`)
                const layout = (
                    await import("@/lib/layout.shared")
                ).baseOptions({
                    config: await source.serveLayoutConfig(ctx),
                    siteName: ctx.identity.name,
                    versionsManifest: ctx.versionsManifest,
                })
                // The same navigation title is used by root/404 chrome.
                expect(layout.nav?.title).toBe(expected)
                const rss = await (
                    await import("@/routes/{$}[.]rss[.]xml")
                ).getUpdatesRss({
                    request: new Request(
                        "https://docs.test.invalid/updates.rss.xml",
                    ),
                    params: { _splat: "updates" },
                })
                expect(rss.status).toBe(200)
                expect(await rss.text()).toContain(
                    `<title>${expected} — Releases</title>`,
                )

                // Observe the real SVG renderer's input without replacing it.
                // One rasterization suffices to guard the OG consumer; the removed
                // override case exercises the same effective identity contract.
                if (label === "changed") {
                    const satori = await import("satori")
                    const render = vi.mocked(satori.default)
                    const image = await (
                        await import("@/routes/og/docs/$")
                    ).getDocsOgImage({ request, params: {} })
                    expect(image.status).toBe(200)
                    expect(render).toHaveBeenCalledOnce()
                    const elements: unknown[] = [render.mock.calls[0]?.[0]]
                    const text: string[] = []
                    while (elements.length) {
                        const value = elements.pop()
                        const literal = z.string().safeParse(value)
                        const children = z.array(z.unknown()).safeParse(value)
                        if (literal.success) text.push(literal.data)
                        else if (children.success)
                            elements.push(...children.data)
                        else {
                            const node = z
                                .object({
                                    props: z.object({ children: z.unknown() }),
                                })
                                .safeParse(value)
                            if (node.success)
                                elements.push(node.data.props.children)
                        }
                    }
                    expect(text).toContain("Second docs")
                    expect(text).not.toContain("First docs")
                    render.mockClear()
                }
                expect(ctx.identity.name).not.toBe("First docs")
            } finally {
                vi.restoreAllMocks()
                vi.unstubAllEnvs()
                vi.resetModules()
                await db
                    .delete(schema.docsSite)
                    .where(eq(schema.docsSite.slug, slug))
                rmSync(scratch, { recursive: true, force: true })
            }
        },
        60_000,
    )

    it.each([undefined, "Deployment docs"])(
        "keeps production and preview identity pinned with SITE_NAME=%s",
        async (siteName) => {
            const root = resolve(import.meta.dirname, "../..")
            const scratch = mkdtempSync(join(tmpdir(), "site-identity-"))
            const slug = `identity-${randomUUID()}`
            const productionSha = "1".repeat(40)
            const previewSha = "2".repeat(40)
            vi.stubEnv("SITE_SLUG", slug)
            vi.stubEnv("SITE_NAME", siteName)
            vi.stubEnv("DOCS_CONTENT_SHA", undefined)
            vi.stubEnv("VERCEL_ENV", undefined)
            vi.stubEnv("DOCS_CANONICAL_REDIRECT", "0")
            vi.stubEnv("VERCEL_GIT_COMMIT_REF", "identity-test")
            try {
                // The existing MDX fixtures have no docs.json. Add distinct
                // authored identity to each copy without changing shared fixtures.
                for (const fixture of ["globex", "acme"]) {
                    const dir = join(scratch, fixture)
                    cpSync(join(root, "tests/fixtures", fixture), dir, {
                        recursive: true,
                    })
                    writeFileSync(
                        join(dir, "docs.json"),
                        JSON.stringify({
                            name: fixture === "globex" ? "Globex" : "Acme",
                            description:
                                fixture === "globex"
                                    ? "Globex documentation"
                                    : "Acme documentation",
                        }),
                    )
                }
                await promisify(execFile)(
                    "bun",
                    [
                        "scripts/ingest.ts",
                        "--dir",
                        join(scratch, "globex"),
                        "--slug",
                        slug,
                        "--sha",
                        productionSha,
                    ],
                    {
                        cwd: root,
                        env: {
                            PATH: process.env.PATH,
                            DATABASE_URL: process.env.DATABASE_URL,
                            SITE_NAME: siteName,
                        },
                    },
                )
                vi.resetModules()
                const { resolveSiteVersion } = await import("@/lib/source")
                const before = await resolveSiteVersion(
                    new Request("https://docs.test.invalid/quickstart.md"),
                )
                expect(before.versionId).not.toBeNull()
                expect(before.identity).toMatchObject({
                    name: siteName ?? "Globex",
                    description: "Globex documentation",
                })

                await promisify(execFile)(
                    "bun",
                    [
                        "scripts/ingest.ts",
                        "--dir",
                        join(scratch, "acme"),
                        "--slug",
                        slug,
                        "--sha",
                        previewSha,
                    ],
                    {
                        cwd: root,
                        env: {
                            PATH: process.env.PATH,
                            DATABASE_URL: process.env.DATABASE_URL,
                            SITE_NAME: siteName,
                            VERCEL_ENV: "preview",
                        },
                    },
                )
                // Reloading also clears the site's lookup cache: the failure
                // used to become visible only when that cache expired.
                vi.resetModules()
                const production = await import("@/lib/source")
                const current = await production.resolveSiteVersion(
                    new Request("https://docs.test.invalid/quickstart.md"),
                )
                expect(current.versionId).toBe(before.versionId)
                expect(current.identity).toMatchObject({
                    name: siteName ?? "Globex",
                    description: "Globex documentation",
                })
                expect(current.identity.description).not.toContain("Acme")

                vi.stubEnv("DOCS_CONTENT_SHA", previewSha)
                vi.stubEnv("VERCEL_ENV", "preview")
                vi.resetModules()
                const preview = await import("@/lib/source")
                const selected = await preview.resolveSiteVersion(
                    new Request("https://preview.test.invalid/quickstart.md"),
                )
                expect(selected.versionId).not.toBeNull()
                expect(selected.identity).toMatchObject({
                    name: siteName ?? "Acme",
                    description: "Acme documentation",
                })
                expect(selected.versionId).not.toBe(before.versionId)
                expect(selected.identity.description).not.toContain("Globex")
            } finally {
                vi.unstubAllEnvs()
                vi.resetModules()
                await db
                    .delete(schema.docsSite)
                    .where(eq(schema.docsSite.slug, slug))
                rmSync(scratch, { recursive: true, force: true })
            }
        },
        60_000,
    )
})
