import { describe, expect, it } from "vitest"
import { redirectedTwin } from "@/lib/source"
import {
    applyRedirectPattern,
    matchRedirect,
    parseRedirectPattern,
} from "@/types/docs"

describe("docs.json redirect grammar", () => {
    it("parses every documented source form and rejects misplaced wildcards", () => {
        expect(parseRedirectPattern("/a/b")).toEqual([
            { kind: "literal", value: "a" },
            { kind: "literal", value: "b" },
        ])
        expect(parseRedirectPattern("/agent/workflows/:page")).toEqual([
            { kind: "literal", value: "agent" },
            { kind: "literal", value: "workflows" },
            { kind: "param", name: ":page" },
        ])
        expect(parseRedirectPattern("/beta/:slug*")?.at(-1)).toEqual({
            kind: "rest",
            name: ":slug*",
        })
        expect(parseRedirectPattern("/legacy/*")?.at(-1)).toEqual({
            kind: "rest",
            name: "*",
        })
        expect(parseRedirectPattern("/articles/concepts-*")?.at(-1)).toEqual({
            kind: "partial",
            prefix: "concepts-",
        })
        expect(parseRedirectPattern("/a/*/b")).toBeNull()
        expect(parseRedirectPattern("/a/:x*/b")).toBeNull()
        expect(parseRedirectPattern("/a/b*c")).toBeNull()
        expect(parseRedirectPattern("relative")).toBeNull()
    })

    it("substitutes captures into destinations, keeping fragments and queries", () => {
        expect(
            applyRedirectPattern({
                pathname: "/agent/workflows/setup",
                source: "/agent/workflows/:page",
                destination: "/automations/:page#top",
            }),
        ).toBe("/automations/setup#top")
        expect(
            applyRedirectPattern({
                pathname: "/beta/guides/intro",
                source: "/beta/:slug*",
                destination: "/v2/:slug*",
            }),
        ).toBe("/v2/guides/intro")
        expect(
            applyRedirectPattern({
                pathname: "/api-playground/mdx/anything/here",
                source: "/api-playground/mdx/:slug*",
                destination: "/api-playground/mdx-setup",
            }),
        ).toBe("/api-playground/mdx-setup")
        expect(
            applyRedirectPattern({
                pathname: "/old/article-123",
                source: "/old/article-*",
                destination: "/new/article-*",
            }),
        ).toBe("/new/article-123")
        expect(
            applyRedirectPattern({
                pathname: "/settings/authentication-personalization/x/y",
                source: "/settings/authentication-personalization/*",
                destination: "/deploy/authentication-setup?from=*",
            }),
        ).toBe("/deploy/authentication-setup?from=x/y")
        // Rest may be empty; a param may not.
        expect(
            applyRedirectPattern({
                pathname: "/beta",
                source: "/beta/:slug*",
                destination: "/v2/:slug*",
            }),
        ).toBe("/v2/")
        expect(
            applyRedirectPattern({
                pathname: "/agent/workflows",
                source: "/agent/workflows/:page",
                destination: "/automations/:page",
            }),
        ).toBeNull()
        // Captured text containing alias characters stays opaque.
        expect(
            applyRedirectPattern({
                pathname: "/old/a*b",
                source: "/old/:slug*",
                destination: "/new/:slug*",
            }),
        ).toBe("/new/a*b")
        // Case-sensitive.
        expect(
            applyRedirectPattern({
                pathname: "/Old/article-1",
                source: "/old/article-*",
                destination: "/new/article-*",
            }),
        ).toBeNull()
    })

    it("matches exact rules first and defaults to permanent", () => {
        const redirects = [
            { source: "/legacy/:slug*", destination: "/guides/:slug*" },
            { source: "/legacy/special", destination: "/special" },
            {
                source: "/temp",
                destination: "/campaign",
                permanent: false,
            },
        ]
        expect(matchRedirect("/legacy/special", redirects)).toEqual({
            destination: "/special",
            permanent: true,
        })
        expect(matchRedirect("/legacy/a/b", redirects)).toEqual({
            destination: "/guides/a/b",
            permanent: true,
        })
        expect(matchRedirect("/temp", redirects)).toEqual({
            destination: "/campaign",
            permanent: false,
        })
        expect(matchRedirect("/nothing", redirects)).toBeNull()
    })
})

describe("redirectedTwin", () => {
    const ctx = {
        redirects: [
            { source: "/old", destination: "/new#top" },
            { source: "/gone", destination: "https://external.example/new" },
            { source: "/home-old", destination: "/" },
            { source: "/temp", destination: "/campaign", permanent: false },
        ],
    }
    it("moves the format suffix onto the internal destination path", () => {
        expect(redirectedTwin(ctx, ["old"], ".md")).toEqual({
            href: "/new.md#top",
            statusCode: 308,
        })
        expect(redirectedTwin(ctx, ["home-old"], ".pdf")).toEqual({
            href: "/index.pdf",
            statusCode: 308,
        })
        expect(redirectedTwin(ctx, ["temp"], ".rss.xml")).toEqual({
            href: "/campaign.rss.xml",
            statusCode: 307,
        })
    })
    it("carries the request query before the destination fragment", () => {
        expect(redirectedTwin(ctx, ["old"], ".md", "?search=x")).toEqual({
            href: "/new.md?search=x#top",
            statusCode: 308,
        })
        // A destination's own query wins over the request's.
        expect(
            redirectedTwin(
                { redirects: [{ source: "/q", destination: "/dest?tab=1" }] },
                ["q"],
                ".md",
                "?search=x",
            ),
        ).toEqual({ href: "/dest.md?tab=1", statusCode: 308 })
    })
    it("follows external destinations unchanged, like the HTML route", () => {
        expect(redirectedTwin(ctx, ["gone"], ".md")).toEqual({
            href: "https://external.example/new",
            statusCode: 308,
        })
    })
    it("carries the request query onto an external destination without one", () => {
        expect(redirectedTwin(ctx, ["gone"], ".md", "?ref=feed")).toEqual({
            href: "https://external.example/new?ref=feed",
            statusCode: 308,
        })
        expect(
            redirectedTwin(
                {
                    redirects: [
                        {
                            source: "/gone-q",
                            destination:
                                "https://external.example/new?tab=1#top",
                        },
                    ],
                },
                ["gone-q"],
                ".md",
                "?ref=feed",
            ),
        ).toEqual({
            href: "https://external.example/new?tab=1#top",
            statusCode: 308,
        })
    })
    it("returns null when no rule matches", () => {
        expect(redirectedTwin(ctx, ["nothing"], ".md")).toBeNull()
    })
})
