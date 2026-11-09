import { describe, expect, it } from "vitest"
import { buildOgPayload, luminanceAppearance } from "@/lib/og"

describe("buildOgPayload eyebrow contrast", () => {
    // A near-white accent: unreadable on the light card, fine on the dark one.
    const accent = "#fafafa"

    it("falls back to the light card's muted gray for a low-contrast accent", () => {
        const payload = buildOgPayload({
            siteName: "Docs",
            section: "Start here",
            title: "Quickstart",
            description: null,
            accent,
        })
        expect(payload.eyebrowColor).toBe("#52525b")
    })

    it("keeps the accent as the eyebrow on a dark card where it contrasts", () => {
        const payload = buildOgPayload({
            siteName: "Docs",
            section: "Start here",
            title: "Quickstart",
            description: null,
            accent,
            appearance: "dark",
        })
        expect(payload.eyebrowColor).toBe(accent)
    })

    it("falls back to the dark card's muted gray for a near-black accent", () => {
        const payload = buildOgPayload({
            siteName: "Docs",
            section: "Start here",
            title: "Quickstart",
            description: null,
            accent: "#18181b",
            appearance: "dark",
        })
        expect(payload.eyebrowColor).toBe("#a1a1aa")
    })
})

describe("luminanceAppearance", () => {
    it("reads an all-black raster as a dark card", () => {
        const pixels = new Uint8Array(60 * 32 * 4)
        for (let offset = 3; offset < pixels.length; offset += 4)
            pixels[offset] = 255
        expect(luminanceAppearance(pixels)).toBe("dark")
    })

    it("reads an all-white raster as a light card", () => {
        expect(luminanceAppearance(new Uint8Array(60 * 32 * 4).fill(255))).toBe(
            "light",
        )
    })

    it("composites transparent pixels over white", () => {
        // Fully transparent black: the card shows white behind it.
        expect(luminanceAppearance(new Uint8Array(16 * 4))).toBe("light")
    })
})
