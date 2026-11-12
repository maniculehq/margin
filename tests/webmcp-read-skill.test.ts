/** read_skill on a site served under a base path behind its owner's proxy.
 * Once the proxy is verified, the skills index names every skill at the
 * public address (acme.com/docs), while a visitor can have the same page
 * open at the platform address. The tool must read a listed skill from the
 * origin the page is open on, and never fetch another origin. The browser
 * boundary (WebMCP registration, location, the network) is faked; the base
 * path comes from the request scope, as `basePath()` reads it outside the
 * TanStack compiler. */

import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { registerDocsTools } from "@/components/docs-webmcp"
import { siteScope } from "@/lib/base-path"

const PLATFORM_ORIGIN = "https://acme.docs-platform.example"
const PUBLIC_ORIGIN = "https://acme.com"
const SKILL_PATH = "/docs/.well-known/agent-skills/acme-setup/SKILL.md"

// Built before the browser globals are stubbed: read_skill never navigates.
const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory(),
})
const tools = new Map<string, WebMCP.ToolExecuteCallback>()
const requested: string[] = []

beforeEach(() => {
    tools.clear()
    requested.length = 0
    vi.stubGlobal("location", { origin: PLATFORM_ORIGIN })
    vi.stubGlobal("navigator", { sendBeacon: () => true })
    vi.stubGlobal("document", {
        modelContext: {
            registerTool: async (tool: {
                name: string
                execute: WebMCP.ToolExecuteCallback
            }) => {
                tools.set(tool.name, tool.execute)
            },
        },
    })
    // The platform host, answering the paths the browser resolves against
    // the page's origin.
    vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = new URL(input, PLATFORM_ORIGIN)
        requested.push(url.href)
        if (url.origin !== PLATFORM_ORIGIN)
            return new Response("Not Found", { status: 404 })
        if (url.pathname === "/docs/.well-known/agent-skills/index.json")
            return Response.json({
                skills: [
                    {
                        name: "acme-setup",
                        description: "Set up Acme.",
                        url: `${PUBLIC_ORIGIN}${SKILL_PATH}`,
                    },
                ],
            })
        if (url.pathname === SKILL_PATH)
            return new Response("# Acme setup\n\nRun acme init.\n")
        return new Response("Not Found", { status: 404 })
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

it("reads a skill the index names at the public address from the platform address", async () => {
    const registration = new AbortController()
    const result = await siteScope().run(
        {
            basePath: "/docs",
            publicOrigin: PUBLIC_ORIGIN,
        },
        async () => {
            registerDocsTools(
                {
                    current: {
                        pathname: "/",
                        title: "Acme",
                        pageUrl: `${PUBLIC_ORIGIN}/docs`,
                    },
                },
                "/",
                "/",
                router,
                registration.signal,
            )
            const readSkill = tools.get("read_skill")
            if (!readSkill) throw new Error("read_skill was not registered")
            return readSkill(
                { name: "acme-setup" },
                { signal: new AbortController().signal },
            )
        },
    )
    registration.abort()

    expect(result).toMatchObject({
        ok: true,
        text: "# Acme setup\n\nRun acme init.\n",
    })
    expect(requested).toContain(`${PLATFORM_ORIGIN}${SKILL_PATH}`)
    expect(
        requested.filter((href) => new URL(href).origin !== PLATFORM_ORIGIN),
    ).toEqual([])
})
