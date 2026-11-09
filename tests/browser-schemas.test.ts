/**
 * Browser-side parsing built on zod/mini: the defaults,
 * catch fallbacks and URL filtering must match the classic-zod behaviour
 * they replaced.
 */

import { describe, expect, it } from "vitest"
import { navbarChromeLinks } from "@/lib/layout.shared"
import { resolveDocsApiConfig } from "@/types/docs-shared"

describe("resolveDocsApiConfig", () => {
    it("fills every default for an absent api block", () => {
        expect(resolveDocsApiConfig(undefined)).toEqual({
            playground: {
                display: "interactive",
                proxy: true,
                credentials: false,
            },
            examples: { defaults: "all", autogenerate: true, prefill: false },
            params: {},
        })
    })

    it("falls back per section and keeps valid authored values", () => {
        expect(
            resolveDocsApiConfig({
                playground: { display: "bogus" },
                examples: { languages: ["bash"], defaults: "required" },
                params: { expanded: "all" },
            }),
        ).toEqual({
            playground: {
                display: "interactive",
                proxy: true,
                credentials: false,
            },
            examples: {
                languages: ["bash"],
                defaults: "required",
                autogenerate: true,
                prefill: false,
            },
            params: { expanded: "all" },
        })
    })
})

describe("navbarChromeLinks", () => {
    it("keeps allowed links, drops unsafe ones and appends the primary CTA", () => {
        expect(
            navbarChromeLinks({
                navbar: {
                    links: [
                        { label: "Blog", href: "https://example.dev/blog" },
                        { label: "Bad", href: "javascript:alert(1)" },
                        { href: 42 },
                    ],
                    primary: {
                        type: "button",
                        label: "Sign up",
                        href: "https://example.dev/signup",
                    },
                },
            }),
        ).toEqual([
            {
                href: "https://example.dev/blog",
                label: "Blog",
                primary: false,
                external: true,
            },
            {
                href: "https://example.dev/signup",
                label: "Sign up",
                primary: true,
                external: true,
            },
        ])
    })
})
