import { afterEach, expect, it, vi } from "vitest"
import { requestTraffic } from "@/lib/traffic"

// On Vercel the forwarded address is trustworthy, so identities are checked.
vi.mock("@/env", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/env")>()
    return { ...original, env: { ...original.env, VERCEL_ENV: "production" } }
})

afterEach(() => vi.unstubAllGlobals())

const crawlerFrom = (address: string) =>
    new Request("https://docs.test.invalid/quickstart", {
        headers: {
            "user-agent":
                "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)",
            "x-vercel-forwarded-for": address,
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
