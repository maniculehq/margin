import { describe, expect, it } from "vitest"
import { z } from "zod"
import { compileDocs } from "@/ingest/compile"
import { resolvedNavigationSchema } from "@/types/docs"

describe("navigation.global beside navigation.languages (compileDocs)", () => {
    it("keeps the root global anchors when the navigation is split by language", async () => {
        const compiled = await compileDocs([
            {
                path: "docs.json",
                kind: "text",
                content: JSON.stringify({
                    name: "Global Anchors",
                    navigation: {
                        global: {
                            anchors: [
                                {
                                    anchor: "Community",
                                    href: "https://discord.example",
                                },
                                {
                                    anchor: "Blog",
                                    href: "https://blog.example",
                                },
                            ],
                        },
                        languages: [
                            {
                                language: "en",
                                default: true,
                                groups: [{ group: "Start", pages: ["intro"] }],
                            },
                        ],
                    },
                }),
            },
            { path: "intro.mdx", kind: "text", content: "# Intro\n\nBody.\n" },
        ])
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.violations))
        const localized = z
            .object({ __resolvedNav: resolvedNavigationSchema })
            .loose()
            .parse(compiled.config).__resolvedNav
        expect(localized.language).toBe("en")
        expect(localized.global?.anchors?.map((anchor) => anchor.href)).toEqual(
            ["https://discord.example", "https://blog.example"],
        )
    })
})
