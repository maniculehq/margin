import { describe, expect, it } from "vitest"
import { z } from "zod"
import { parseDocsConfig } from "@/ingest/config"

function parse(config: Record<string, unknown>) {
    return parseDocsConfig([
        {
            path: "docs.json",
            kind: "text",
            content: JSON.stringify({ name: "Recovery", ...config }),
        },
    ])
}

const droppedFields = (result: ReturnType<typeof parse>): string[] =>
    result.diagnostics
        .filter((diagnostic) => diagnostic.code === "field_invalid")
        .map((diagnostic) => diagnostic.message)

describe("field-level config recovery", () => {
    it("keeps a provider whose optional field is invalid (mixpanel.region)", () => {
        const result = parse({
            integrations: {
                mixpanel: { projectToken: "tok_1", region: "mars" },
                fathom: { siteId: "ABCDE" },
            },
        })
        const integrations = z
            .object({
                mixpanel: z.object({ projectToken: z.string() }),
                fathom: z.object({ siteId: z.string() }),
            })
            .parse(result.config?.integrations)
        expect(integrations.mixpanel.projectToken).toBe("tok_1")
        expect(integrations.fathom.siteId).toBe("ABCDE")
        expect(
            droppedFields(result).some((message) =>
                message.includes("integrations.mixpanel.region"),
            ),
        ).toBe(true)
    })

    it("drops a provider wholesale when a required field is invalid", () => {
        const result = parse({
            integrations: {
                fathom: { siteId: 42 },
                clarity: { projectId: "proj" },
            },
        })
        const integrations = z
            .record(z.string(), z.unknown())
            .parse(result.config?.integrations)
        expect(integrations.fathom).toBeUndefined()
        expect(integrations.clarity).toEqual({ projectId: "proj" })
        expect(
            droppedFields(result).some((message) =>
                message.includes("integrations.fathom"),
            ),
        ).toBe(true)
    })

    it("keeps unknown vendors untouched for quarantine reporting", () => {
        const result = parse({
            integrations: { koala: { publicApiKey: "k" } },
        })
        const integrations = z
            .record(z.string(), z.unknown())
            .parse(result.config?.integrations)
        expect(integrations.koala).toEqual({ publicApiKey: "k" })
    })

    it("keeps codeblocks.theme when only its languages value is malformed", () => {
        const result = parse({
            styling: {
                latex: true,
                eyebrows: "section",
                codeblocks: { theme: "nord", languages: 42 },
            },
        })
        const styling = z
            .object({ codeblocks: z.object({ theme: z.string() }) })
            .parse(result.config?.styling)
        expect(styling.codeblocks.theme).toBe("nord")
        expect(
            droppedFields(result).some((message) =>
                message.includes("styling.codeblocks.languages"),
            ),
        ).toBe(true)
    })

    it("drops a wholly-invalid codeblocks value without touching siblings", () => {
        const result = parse({
            styling: { latex: true, codeblocks: 42 },
        })
        const styling = z
            .record(z.string(), z.unknown())
            .parse(result.config?.styling)
        expect(styling.latex).toBe(true)
        expect(styling.codeblocks).toBeUndefined()
        expect(
            droppedFields(result).some((message) =>
                message.includes("styling.codeblocks"),
            ),
        ).toBe(true)
    })

    it("still drops an invalid styling.latex without touching siblings", () => {
        const result = parse({
            styling: { latex: "true", eyebrows: "breadcrumbs" },
        })
        const styling = z
            .record(z.string(), z.unknown())
            .parse(result.config?.styling)
        expect(styling.latex).toBeUndefined()
        expect(styling.eyebrows).toBe("breadcrumbs")
        expect(
            droppedFields(result).some((message) =>
                message.includes("styling.latex"),
            ),
        ).toBe(true)
    })
})
