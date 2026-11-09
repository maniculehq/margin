import { beforeEach, describe, expect, it, vi } from "vitest"
import { agentConfig } from "@/lib/agent.config"

/**
 * /api/spec: the API console and the download link fetch the same
 * `/api/spec?doc=<id>` URL, so it must carry the shared CDN policy and serve
 * exactly the requested document. Head resolution and the per-doc load are
 * DB-backed — mocked here so the route's doc selection is exercised in
 * isolation (webmcp-e2e covers the built server end to end).
 */
const resolveSiteVersion = vi.fn()
const openapiDocumentIndex = vi.fn()
const openapiDocument = vi.fn()
vi.mock("@/lib/source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/source")>()),
    resolveSiteVersion: (...args: unknown[]) => resolveSiteVersion(...args),
    openapiDocumentIndex: (...args: unknown[]) => openapiDocumentIndex(...args),
    openapiDocument: (...args: unknown[]) => openapiDocument(...args),
}))

const ctxSentinel = { versionId: "v-1", config: null }
const documents = new Map([
    ["admin", { openapi: "3.1.0", info: { title: "Admin" } }],
    ["petstore", { openapi: "3.1.0", info: { title: "Petstore" } }],
])

beforeEach(() => {
    resolveSiteVersion.mockReset().mockResolvedValue(ctxSentinel)
    openapiDocumentIndex.mockReset().mockResolvedValue(
        [...documents.keys()].map((docId) => ({
            docId,
            sourcePath: `specs/${docId}.yaml`,
            servers: [],
        })),
    )
    openapiDocument
        .mockReset()
        .mockImplementation(
            async (_ctx: unknown, docId: string) =>
                documents.get(docId) ?? null,
        )
})

// Load the real route during module setup, so cold imports cannot time out
// a request assertion and continue into the next case's reset mocks.
const { handleSpec } = await import("@/routes/api/spec")

describe("spec route", () => {
    it("serves the requested doc under the shared CDN policy", async () => {
        const response = await handleSpec({
            request: new Request(
                "https://acme.docs.test/api/spec?doc=petstore",
            ),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe(
            agentConfig.cache.header,
        )
        expect(response.headers.get("content-disposition")).toContain(
            "petstore.openapi.json",
        )
        expect(openapiDocument).toHaveBeenCalledWith(ctxSentinel, "petstore")
        expect(await response.json()).toEqual({
            openapi: "3.1.0",
            info: { title: "Petstore" },
        })
    })

    it("reads only the requested doc, never the version index", async () => {
        await handleSpec({
            request: new Request("https://acme.docs.test/api/spec?doc=admin"),
        })
        expect(openapiDocumentIndex).not.toHaveBeenCalled()
        expect(openapiDocument).toHaveBeenCalledTimes(1)
    })

    it("defaults to the docs.json api.openapi document when no doc is requested", async () => {
        // "petstore" sorts after "admin": only the configured pick serves it.
        resolveSiteVersion.mockResolvedValue({
            ...ctxSentinel,
            config: { api: { openapi: "./specs/petstore.yaml" } },
        })
        const response = await handleSpec({
            request: new Request("https://acme.docs.test/api/spec"),
        })
        expect(await response.json()).toEqual({
            openapi: "3.1.0",
            info: { title: "Petstore" },
        })
    })

    it("reads an object api.openapi entry as the primary", async () => {
        // The object entry comes first; the string entry names "admin".
        resolveSiteVersion.mockResolvedValue({
            ...ctxSentinel,
            config: {
                api: {
                    openapi: [
                        { id: "petstore", spec: "specs/petstore.yaml" },
                        "specs/admin.yaml",
                    ],
                },
            },
        })
        const response = await handleSpec({
            request: new Request("https://acme.docs.test/api/spec"),
        })
        expect(await response.json()).toEqual({
            openapi: "3.1.0",
            info: { title: "Petstore" },
        })
    })

    it("defaults to the lowest docId when no api.openapi is configured", async () => {
        const response = await handleSpec({
            request: new Request("https://acme.docs.test/api/spec"),
        })
        expect(await response.json()).toEqual({
            openapi: "3.1.0",
            info: { title: "Admin" },
        })
    })

    it("404s an unknown doc id instead of serving another spec", async () => {
        const response = await handleSpec({
            request: new Request("https://acme.docs.test/api/spec?doc=missing"),
        })
        expect(response.status).toBe(404)
    })

    it("lists the available docs on an unknown doc id", async () => {
        const response = await handleSpec({
            request: new Request("https://acme.docs.test/api/spec?doc=missing"),
        })
        expect(await response.json()).toEqual({
            error: "not_found",
            available: [
                {
                    doc: "admin",
                    source: "specs/admin.yaml",
                    url: "/api/spec?doc=admin",
                },
                {
                    doc: "petstore",
                    source: "specs/petstore.yaml",
                    url: "/api/spec?doc=petstore",
                },
            ],
        })
    })
})
