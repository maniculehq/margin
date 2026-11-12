import type { Root } from "mdast"
import { describe, expect, it } from "vitest"
import { headingSlug } from "@/ingest/heading-slug"

const slugs = (...headings: string[]) => {
    const root: Root = { type: "root", children: [] }
    return headings.map((heading) => headingSlug(root, heading))
}

describe("heading anchors", () => {
    it.each([
        ["Always pass decision.id", "always-pass-decision-id"],
        ["new OpenComputer(options)", "new-opencomputer-options"],
        ["Read the current agent's logs", "read-the-current-agent’s-logs"],
        ['Don\'t use "no-reply"', "don’t-use-“no-reply”"],
        ["Domains & Verification", "domains-&-verification"],
        ["POST /emails/batch endpoint", "post-/emails/batch-endpoint"],
        ["Split configuration with $ref", "split-configuration-with-$ref"],
        [".NET (C#)", "net-c#"],
        ["name - required", "name-required"],
        ["projects_list", "projects_list"],
        ["Is TLS better?", "is-tls-better"],
    ])("%s → #%s", (heading, anchor) => {
        expect(slugs(heading)).toEqual([anchor])
    })

    it("numbers a repeated heading from 2", () => {
        expect(slugs("Install", "Install", "Install")).toEqual([
            "install",
            "install-2",
            "install-3",
        ])
    })

    it("never hands out an anchor a numbered repeat already took", () => {
        expect(slugs("Setup", "Setup", "Setup 2")).toEqual([
            "setup",
            "setup-2",
            "setup-2-2",
        ])
    })

    it("numbers each document on its own", () => {
        expect([...slugs("Install"), ...slugs("Install")]).toEqual([
            "install",
            "install",
        ])
    })
})
