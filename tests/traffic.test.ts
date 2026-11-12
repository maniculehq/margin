import { afterEach, describe, expect, it, vi } from "vitest"
import { ASSISTANT_USER_AGENT_PATTERN } from "@/lib/agent.config"
import { ipInPublishedRanges } from "@/types/published-ranges"
import {
    aiReferral,
    BROWSER_AUTOMATION_PATTERN,
    BROWSER_ENGINE_PATTERN,
    BROWSER_PREFIX_PATTERN,
    browserCheck,
    classifyTraffic,
    prefersMarkdown,
    TRAFFIC_ENTRIES,
    TRAFFIC_GENERIC_CLIENTS,
} from "@/types/traffic"

const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
const FIREFOX =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"
const GPTBOT =
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)"

describe("classifyTraffic by user agent", () => {
    it.each([
        // People
        [CHROME, "human", null, null],
        [FIREFOX, "human", null, null],
        [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
            "human",
            null,
            null,
        ],
        // A phone whose model name ends in "bot" is still a person's phone.
        [
            "Mozilla/5.0 (Linux; Android 13; CUBOT P80) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
            "human",
            null,
            null,
        ],
        // An editor's embedded browser carries product words, not agents.
        [
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.109.3 Chrome/142.0.0.0 Electron/39.2.3 Safari/537.36",
            "human",
            null,
            null,
        ],
        [`${CHROME} Cursor/1.2`, "human", null, null],
        // The Cốc Cốc browser, as opposed to the search engine's crawler.
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/140.0.0 Chrome/134.0.0.0 Safari/537.36",
            "human",
            null,
            null,
        ],
        [`${CHROME} CocCoc/140.0`, "human", null, null],
        // Agents
        [
            "Claude-User (claude-code/2.1.308; +https://support.anthropic.com/)",
            "agent",
            "coding",
            "claude-code",
        ],
        ["claude-cli/1.0.80 (external, cli)", "agent", "coding", "claude-code"],
        [
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com",
            "agent",
            "assistant",
            "claude-user",
        ],
        [
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
            "agent",
            "assistant",
            "chatgpt-user",
        ],
        ["QwenCode/0.0.14 (linux; x64)", "agent", "coding", "qwen-code"],
        [
            "Mozilla/5.0 (compatible; Kimi-User/1.0)",
            "agent",
            "assistant",
            "kimi-user",
        ],
        // Crawlers
        [
            "Mozilla/5.0 (compatible; MistralAI-Index/1.0; +https://docs.mistral.ai/robots)",
            "crawler",
            "ai_search",
            "mistral-index",
        ],
        [GPTBOT, "crawler", "training", "gptbot"],
        [
            "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
            "crawler",
            "training",
            "claudebot",
        ],
        [
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot)",
            "crawler",
            "ai_search",
            "oai-searchbot",
        ],
        // Googlebot's smartphone crawler borrows a full Chrome user agent.
        [
            "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "crawler",
            "search",
            "googlebot",
        ],
        [
            "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)",
            "crawler",
            "training",
            "googleother",
        ],
        [
            "Mozilla/5.0 (compatible; coccoc/1.0; +http://help.coccoc.com/searchengine)",
            "crawler",
            "search",
            "coccocbot",
        ],
        // Other automation
        [
            "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
            "automation",
            "seo",
            "semrushbot",
        ],
        ["curl/8.7.1", "automation", "http_client", "curl"],
        ["node", "automation", "http_client", "node"],
        [
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.0 Safari/537.36",
            "automation",
            "headless",
            "headless-browser",
        ],
        // A truncated browser string names no engine a browser would.
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "automation",
            "unidentified",
            null,
        ],
        [
            "Mozilla/5.0 (compatible; SomeUnknownThing/1.0)",
            "automation",
            "unidentified",
            null,
        ],
        ["", "automation", "unidentified", null],
    ])("%s", (userAgent, category, kind, id) => {
        expect(classifyTraffic({ userAgent })).toMatchObject({
            category,
            kind,
            id,
        })
    })
})

describe("classifyTraffic by Accept", () => {
    it("counts a browser user agent that prefers markdown as an agent", () => {
        expect(
            classifyTraffic({
                userAgent: CHROME,
                accept: "text/markdown, text/html;q=0.9",
            }),
        ).toMatchObject({
            category: "agent",
            kind: "unidentified",
            signal: "accept",
        })
    })

    it("counts a script as an agent only when it asks for markdown", () => {
        const userAgent = "curl/8.7.1"
        expect(
            classifyTraffic({ userAgent, accept: "text/markdown" }).category,
        ).toBe("agent")
        expect(classifyTraffic({ userAgent, accept: "*/*" }).category).toBe(
            "automation",
        )
    })

    it("names an agent by an Accept header only it sends", () => {
        expect(
            classifyTraffic({
                userAgent: CHROME,
                accept: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
            }),
        ).toMatchObject({ category: "agent", kind: "coding", id: "opencode" })
    })

    it("keeps a link preview automation whatever it accepts", () => {
        expect(
            classifyTraffic({
                userAgent: "Slackbot-LinkExpanding 1.0",
                accept: "text/markdown",
            }),
        ).toMatchObject({ category: "automation", kind: "preview" })
    })

    it.each([
        ["text/markdown", true],
        ["text/markdown, text/html;q=0.9", true],
        ["text/html;q=0.8, text/x-markdown", true],
        ["text/html, text/markdown", false],
        ["text/html,application/xhtml+xml,*/*;q=0.8", false],
        ["text/plain", false],
        ["text/markdown;q=0, text/html", false],
        ["*/*", false],
        [null, false],
    ])("prefersMarkdown(%j) is %s", (accept, expected) => {
        expect(prefersMarkdown(accept)).toBe(expected)
    })
})

describe("classifyTraffic verification", () => {
    it("verifies a crawler whose address is in its operator's ranges", () => {
        expect(
            classifyTraffic({ userAgent: GPTBOT, ipInRanges: true }),
        ).toMatchObject({ category: "crawler", id: "gptbot", verified: true })
    })

    it("calls a crawler name from a foreign address an impersonator", () => {
        expect(
            classifyTraffic({ userAgent: GPTBOT, ipInRanges: false }),
        ).toMatchObject({
            category: "automation",
            kind: "impersonator",
            name: "GPTBot",
            verified: false,
        })
    })

    it("leaves an unchecked crawler a crawler", () => {
        expect(
            classifyTraffic({ userAgent: GPTBOT, ipInRanges: null }),
        ).toMatchObject({ category: "crawler", verified: null })
    })

    it("never condemns an agent that runs on the user's machine", () => {
        expect(
            classifyTraffic({
                userAgent: "claude-code/2.1.308",
                ipInRanges: false,
            }),
        ).toMatchObject({
            category: "agent",
            id: "claude-code",
            verified: null,
        })
    })

    it("names a signing agent that sends a browser user agent", () => {
        expect(
            classifyTraffic({
                userAgent: CHROME,
                signatureAgent: '"https://chatgpt.com"',
            }),
        ).toMatchObject({
            category: "agent",
            kind: "browser",
            id: "chatgpt-agent",
            signal: "signature",
        })
    })
})

it("names the hosted-browser platform a signed request comes from", () => {
    expect(
        classifyTraffic({
            userAgent: CHROME,
            signatureAgent: 'sig1="https://browserbase.com"',
        }),
    ).toMatchObject({ category: "agent", kind: "browser", id: "browserbase" })
})

describe("published address ranges", () => {
    afterEach(() => vi.unstubAllGlobals())

    const publish = (creationTime: string) =>
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    creationTime,
                    prefixes: [
                        { ipv4Prefix: "132.196.86.0/24" },
                        { ipv6Prefix: "2a01:111::/32" },
                    ],
                }),
            ),
        )
    const now = Date.parse("2026-11-01T00:00:00Z")

    it("answers inside, outside and IPv4-mapped addresses from a current file", async () => {
        publish("2026-10-20T00:00:00Z")
        const url = "https://ranges.test/current.json"
        expect(await ipInPublishedRanges(url, "132.196.86.12", now)).toBe(true)
        expect(await ipInPublishedRanges(url, "2a01:111:f00::1", now)).toBe(
            true,
        )
        expect(
            await ipInPublishedRanges(url, "::ffff:132.196.86.12", now),
        ).toBe(true)
        expect(await ipInPublishedRanges(url, "73.12.4.9", now)).toBe(false)
    })

    it("does not condemn an address against a file its operator stopped updating", async () => {
        publish("2025-01-01T00:00:00Z")
        const url = "https://ranges.test/stale.json"
        expect(await ipInPublishedRanges(url, "132.196.86.12", now)).toBe(true)
        expect(await ipInPublishedRanges(url, "73.12.4.9", now)).toBeNull()
    })

    // Trimmed copies of the files operators served on 2026-11-12. They
    // differ in ways a hand-written sample hides: timestamps with
    // microseconds and no zone, extra top-level fields, IPv4-only lists.
    it.each([
        {
            operator: "OpenAI",
            file: {
                creationTime: "2026-09-22T02:00:07.000000",
                prefixes: [
                    { ipv4Prefix: "132.196.86.0/24" },
                    { ipv4Prefix: "172.182.202.0/25" },
                ],
            },
            inside: "172.182.202.9",
        },
        {
            operator: "Google",
            file: {
                creationTime: "2026-11-12T15:45:54.000000",
                prefixes: [
                    { ipv6Prefix: "2001:4860:4801:10::/64" },
                    { ipv4Prefix: "192.178.4.0/27" },
                ],
            },
            inside: "2001:4860:4801:10::7",
        },
        {
            operator: "Common Crawl",
            file: {
                synctoken: "20260811134000",
                creationTime: "2026-08-11T13:40:00Z",
                notes: "IP ranges used by CCBot.",
                prefixes: [
                    { ipv6Prefix: "2600:1f28:365:8000::/56" },
                    { ipv4Prefix: "18.97.9.168/29" },
                ],
            },
            inside: "18.97.9.170",
        },
    ])(
        "reads the range file $operator publishes",
        async ({ operator, file, inside }) => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => Response.json(file)),
            )
            const url = `https://ranges.test/${operator}.json`
            const checked = Date.parse("2026-11-13T00:00:00Z")
            expect(await ipInPublishedRanges(url, inside, checked)).toBe(true)
            expect(await ipInPublishedRanges(url, "73.12.4.9", checked)).toBe(
                false,
            )
        },
    )

    it("leaves the address unchecked when the file cannot be loaded", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 503 })),
        )
        expect(
            await ipInPublishedRanges(
                "https://ranges.test/down.json",
                "73.12.4.9",
                now,
            ),
        ).toBeNull()
    })
})

describe("browserCheck", () => {
    const headers =
        (values: Record<string, string>) =>
        (name: string): string | null =>
            values[name] ?? null
    const browser = {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US",
        "sec-fetch-mode": "navigate",
    }

    it.each([
        [CHROME, browser, "consistent"],
        [CHROME, { ...browser, "sec-fetch-mode": "" }, "no_fetch_metadata"],
        [CHROME, { ...browser, "accept-language": "" }, "no_accept_language"],
        [
            FIREFOX,
            { ...browser, "sec-ch-ua": '"Chromium";v="149"' },
            "client_hints_mismatch",
        ],
        [
            CHROME,
            { ...browser, accept: "text/plain, text/html" },
            "plain_text_first",
        ],
        ["curl/8.7.1", browser, null],
    ])("%s with %j is %s", (userAgent, values, expected) => {
        expect(browserCheck(userAgent, headers(values))).toBe(expected)
    })
})

// Header and query values name table keys; a name every object inherits
// must not read as a match.
it("matches nothing for input named after an inherited object property", () => {
    expect(
        classifyTraffic({
            userAgent: CHROME,
            accept: "constructor",
            signatureAgent: "constructor",
        }),
    ).toMatchObject({ category: "human", signal: "browser" })
    expect(
        aiReferral({
            referer: "https://constructor/",
            requestPath: "/quickstart?utm_source=constructor",
        }),
    ).toBeNull()
})

describe("aiReferral", () => {
    it("attributes a click from an AI answer by its referrer", () => {
        expect(
            aiReferral({
                referer: "https://www.perplexity.ai/search?q=private-query",
                requestPath: "/quickstart",
            }),
        ).toEqual({ platform: "perplexity", detection: "referrer" })
    })

    it("attributes a referrer-suppressed click by utm_source", () => {
        expect(
            aiReferral({
                referer: null,
                requestPath: "/quickstart?utm_source=chatgpt.com",
            }),
        ).toEqual({ platform: "openai", detection: "utm" })
    })

    it("attributes nothing to an ordinary visit", () => {
        expect(
            aiReferral({
                referer: "https://www.google.com/",
                requestPath: "/quickstart?utm_source=newsletter",
            }),
        ).toBeNull()
    })
})

// The pattern strings also run in the CDN route (PCRE) and in the API's
// HogQL fallback (RE2). RE2 rejects lookaround, backreferences and named
// groups, so one of those here breaks a query, not this module.
it("keeps every pattern inside the syntax RE2 accepts", () => {
    const patterns = [
        ...TRAFFIC_ENTRIES.map((entry) => entry.pattern),
        ...TRAFFIC_GENERIC_CLIENTS.map((entry) => entry.pattern),
        BROWSER_PREFIX_PATTERN,
        BROWSER_ENGINE_PATTERN,
        BROWSER_AUTOMATION_PATTERN,
    ]
    expect(patterns.length).toBeGreaterThan(100)
    expect(
        patterns.filter((pattern) => /\(\?[=!<]|\\[1-9]/.test(pattern)),
    ).toEqual([])
})

// vite.config.ts wraps the pattern the same way for the CDN route that
// answers these agents with markdown before the cache.
describe("assistant markdown route pattern", () => {
    const route = new RegExp(`^.*(?:${ASSISTANT_USER_AGENT_PATTERN}).*$`, "i")

    it.each([
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
        "Claude-User (claude-code/2.1.308; +https://support.anthropic.com/)",
        "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    ])("matches %s", (userAgent) => {
        expect(route.test(userAgent)).toBe(true)
    })

    it.each([CHROME, GPTBOT, "curl/8.7.1", `${CHROME} Cursor/1.2`])(
        "leaves %s on HTML",
        (userAgent) => {
            expect(route.test(userAgent)).toBe(false)
        },
    )
})
