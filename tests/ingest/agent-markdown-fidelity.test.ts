import { describe, expect, it } from "vitest"
import { compileDocs } from "@/ingest/compile"

/**
 * The stored agent markdown (.md twin, llms-full, MCP read_page, context
 * bundle) is built from the same tree as the human render — these pin the
 * places it used to diverge (QA findings 101, 105, 107, 114).
 */

async function compileOne(
    content: string,
    extra: Array<{ path: string; kind: "text"; content: string }> = [],
) {
    const compiled = await compileDocs([
        { path: "page.mdx", kind: "text", content },
        ...extra,
    ])
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
    const page = compiled.pages.find((entry) => entry.path === "page.mdx")
    if (!page) throw new Error("page.mdx did not compile")
    return page
}

describe.concurrent("agent markdown fidelity", () => {
    it("drops single-line human-only blocks and unwraps agent-only blocks", async () => {
        const page = await compileOne(
            [
                "Shared intro.",
                "",
                '<Visibility for="humans">Human sentence.</Visibility>',
                "",
                '<Visibility for="agents">Agent sentence.</Visibility>',
                "",
                "<Human>Human block.</Human>",
                "",
                "<Agent>Agent block.</Agent>",
                "",
            ].join("\n"),
        )
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain("Shared intro.")
        expect(markdown).toContain("Agent sentence.")
        expect(markdown).toContain("Agent block.")
        expect(markdown).not.toContain("Human sentence.")
        expect(markdown).not.toContain("Human block.")
        expect(markdown).not.toMatch(/<\/?(Agent|Human|Visibility)\b/)
    })

    it("keeps boolean props on API field components", async () => {
        const page = await compileOne(
            [
                '<ParamField path="project_id" type="string" required>The project.</ParamField>',
                "",
                '<ParamField body="decrypt" type="boolean" deprecated>No effect.</ParamField>',
                "",
            ].join("\n"),
        )
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain(
            '<ParamField path="project_id" type="string" required>The project.</ParamField>',
        )
        expect(markdown).toContain(
            '<ParamField body="decrypt" type="boolean" deprecated>No effect.</ParamField>',
        )
    })

    it("substitutes declared docs variables inside code fences and inline code", async () => {
        const page = await compileOne(
            [
                "Base URL: `https://{{api_host}}/v2`",
                "",
                "```bash",
                "curl https://{{api_host}}/v2/projects",
                "echo {{ .Name }} {{undeclared}}",
                "```",
                "",
            ].join("\n"),
            [
                {
                    path: "docs.json",
                    kind: "text",
                    content: JSON.stringify({
                        name: "Orbit",
                        variables: { api_host: "api.orbit.example" },
                        navigation: { pages: ["page"] },
                    }),
                },
            ],
        )
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain("`https://api.orbit.example/v2`")
        expect(markdown).toContain("curl https://api.orbit.example/v2/projects")
        // Undeclared names and template syntax in code stay as authored.
        expect(markdown).toContain("echo {{ .Name }} {{undeclared}}")
        expect(markdown).not.toContain("{{api_host}}")
    })

    it("leaves inherited object keys literal when no variable declares them", async () => {
        const page = await compileOne(
            "```js\nconst a = {{constructor}}\n```\n\nInline `{{toString}}`.\n",
        )
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain("const a = {{constructor}}")
        expect(markdown).toContain("`{{toString}}`")
    })

    it("counts a JSX line break as a space in derived titles and descriptions", async () => {
        const page = await compileOne(
            "# First<br />Second\n\nAlpha<br/>beta.\n",
        )
        expect(page.title).toBe("First Second")
        expect(page.description).toBe("Alpha beta.")
    })

    it("derives descriptions without stray spaces around inline markup", async () => {
        const page = await compileOne(
            "Orbit bills for `build minutes`, **bandwidth**, and *invocations*.\n",
        )
        expect(page.description).toBe(
            "Orbit bills for build minutes, bandwidth, and invocations.",
        )
    })
})

describe("generated OpenAPI agent markdown", () => {
    async function compileOpenapi(content: string) {
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "Orbit",
                    openapi: ["openapi.json"],
                    navigation: { pages: ["index"] },
                }),
            },
            { path: "openapi.json", kind: "text", content },
            { path: "index.mdx", kind: "text", content: "# Home\n" },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const page = compiled.pages.find((p) => p.kind === "openapi")
        if (!page) throw new Error("no OpenAPI page compiled")
        return page
    }

    const spec = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Orbit", version: "2.0.0" },
        servers: [
            { url: "https://api.orbit.example/v2" },
            {
                url: "https://{region}.api.orbit.example/v2",
                variables: { region: { default: "us", enum: ["us", "eu"] } },
            },
        ],
        security: [{ bearerAuth: [] }],
        components: {
            securitySchemes: {
                bearerAuth: { type: "http", scheme: "bearer" },
                unusedKey: { type: "apiKey", in: "header", name: "X-Unused" },
            },
        },
        paths: {
            "/deployments": {
                post: {
                    operationId: "createDeployment",
                    summary: "Create a deployment",
                    description:
                        "Starts a new build. Supply **either** a Git reference\nor a manifest.\n\nBuilds are queued.",
                    responses: { "201": { description: "created" } },
                },
            },
        },
    })

    it("states the base URL, server variables, and the auth scheme definitions", async () => {
        const page = await compileOpenapi(spec)
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain("Base URL: `https://api.orbit.example/v2`")
        expect(markdown).toContain(
            "Base URL: `https://{region}.api.orbit.example/v2` (`region`: one of `us`, `eu`, default `us`)",
        )
        expect(markdown).toContain('"securitySchemes": {')
        expect(markdown).toContain('"scheme": "bearer"')
        // Only schemes the operation actually uses are embedded.
        expect(markdown).not.toContain("X-Unused")
    })

    it("indexes a multi-line description as one plain line", async () => {
        const page = await compileOpenapi(spec)
        expect(page.description).toBe(
            "Starts a new build. Supply either a Git reference or a manifest.",
        )
        // The subtitle keeps the authored CommonMark.
        expect(page.frontmatter.description).toContain("**either**")
    })

    it("keeps an empty-string server variable default", async () => {
        const page = await compileOpenapi(
            JSON.stringify({
                openapi: "3.1.0",
                info: { title: "Orbit", version: "2.0.0" },
                servers: [
                    {
                        url: "https://api.orbit.example{basePath}",
                        variables: { basePath: { default: "" } },
                    },
                ],
                paths: {
                    "/ping": {
                        get: {
                            operationId: "ping",
                            summary: "Ping",
                            responses: { "200": { description: "ok" } },
                        },
                    },
                },
            }),
        )
        expect(page.processedMarkdown).toContain(
            "Base URL: `https://api.orbit.example{basePath}` (`basePath`: any value, default ``)",
        )
    })

    it("honours an empty servers override instead of inheriting the document host", async () => {
        const page = await compileOpenapi(
            JSON.stringify({
                openapi: "3.1.0",
                info: { title: "Orbit", version: "2.0.0" },
                servers: [{ url: "https://api.orbit.example/v2" }],
                paths: {
                    "/ping": {
                        get: {
                            operationId: "ping",
                            summary: "Ping",
                            servers: [],
                            responses: { "200": { description: "ok" } },
                        },
                    },
                },
            }),
        )
        const markdown = page.processedMarkdown ?? ""
        expect(markdown).toContain("Base URL: `/`")
        expect(markdown).not.toContain("api.orbit.example")
    })
})
