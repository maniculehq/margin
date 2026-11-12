import { afterEach, expect, it, vi } from "vitest"
import { requestTraffic } from "@/lib/traffic"

// On Vercel the forwarded address is trustworthy, so identities are checked.
vi.mock("@/env", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/env")>()
    return { ...original, env: { ...original.env, VERCEL_ENV: "production" } }
})

afterEach(() => vi.unstubAllGlobals())

const crawlerFrom = (address: string, headers: Record<string, string> = {}) =>
    new Request("https://docs.test.invalid/quickstart", {
        headers: {
            "user-agent":
                "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)",
            "x-vercel-forwarded-for": address,
            ...headers,
        },
    })
const publishRanges = () =>
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                creationTime: new Date().toISOString(),
                prefixes: [{ ipv4Prefix: "132.196.86.0/24" }],
            }),
        ),
    )

it("calls a crawler name from outside its operator's ranges an impersonator", async () => {
    publishRanges()
    expect(await requestTraffic(crawlerFrom("73.12.4.9"), false)).toMatchObject(
        { category: "automation", kind: "impersonator" },
    )
})

it("does not judge a crawler by its site's proxy address", async () => {
    publishRanges()
    expect(await requestTraffic(crawlerFrom("73.12.4.9"), true)).toMatchObject({
        category: "crawler",
        id: "gptbot",
        verified: null,
    })
})

it("verifies a crawler from inside its operator's ranges", async () => {
    publishRanges()
    expect(
        await requestTraffic(crawlerFrom("132.196.86.7"), false),
    ).toMatchObject({ category: "crawler", id: "gptbot", verified: true })
})

// Behind another CDN (a customer's own Cloudflare, say) Vercel's address
// is that CDN's edge: a real crawler must not read as an impersonator.
it("leaves a crawler that arrived through another CDN unverified", async () => {
    publishRanges()
    expect(
        await requestTraffic(
            crawlerFrom("73.12.4.9", { "cdn-loop": "cloudflare; loops=1" }),
            false,
        ),
    ).toMatchObject({ category: "crawler", id: "gptbot", verified: null })
})

// A direct caller can forge the header: it must never verify anyone.
it("never verifies a crawler on a request that carries CDN-Loop", async () => {
    publishRanges()
    expect(
        await requestTraffic(
            crawlerFrom("132.196.86.7", { "cdn-loop": "example-cdn" }),
            false,
        ),
    ).toMatchObject({ category: "crawler", id: "gptbot", verified: null })
})
