/**
 * Honest agent-readiness verification. Pure HTTP (no app imports), so it runs via
 * `bun scripts/doctor.ts` or against a deployed URL. It does NOT score boolean flags:
 * it derives the advertised surfaces from the running server's own manifest +
 * /.well-known/mcp.json and asserts each one actually SERVES the expected shape —
 * including a real MCP initialize → tools/list → read_page('.md') handshake. Pass/fail
 * only. It does not (and cannot) measure prose usefulness.
 */

import { z } from "zod"

export interface DoctorCheck {
    name: string
    ok: boolean
    detail: string
}

export interface DoctorOptions {
    /** Hard ceiling for /llms-full.txt size, in chars. Defaults to the
     * budget the server advertises as `surfaces.llmsFull.maxChars` in its
     * own discovery manifest (agentConfig.llmsFull.maxChars) — the doctor is
     * env-free on purpose, so it cannot import the config module. */
    maxLlmsFullChars?: number
    fetchFn?: typeof fetch
}

/** A standalone .md body may open with YAML frontmatter and the index
 * preamble blockquote; the page content starts after them. */
function pageContent(body: string): string {
    return body
        .replace(/^---\n[\s\S]*?\n---\n\n/, "")
        .replace(/^(?:>.*\n)+\n/, "")
}

const MCP_HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
}

export async function runDoctor(
    baseUrl: string,
    options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
    const f = options.fetchFn ?? fetch
    const origin = baseUrl.replace(/\/$/, "")
    const checks: DoctorCheck[] = []

    const add = async (name: string, fn: () => Promise<string>) => {
        try {
            checks.push({ name, ok: true, detail: await fn() })
        } catch (error) {
            checks.push({
                name,
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
            })
        }
    }

    const get = async (url: string, expectType?: string) => {
        const res = await f(url)
        if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
        const type = res.headers.get("content-type") ?? ""
        if (expectType && !type.includes(expectType))
            throw new Error(
                `GET ${url} content-type ${type} (want ${expectType})`,
            )
        return res
    }

    // 1. Discovery manifest.
    let manifest: { surfaces?: Record<string, Record<string, string>> } = {}
    await add("manifest serves", async () => {
        const res = await get(
            `${origin}/.well-known/llms-manifest.json`,
            "application/json",
        )
        manifest = await res.json()
        const count = Object.keys(manifest.surfaces ?? {}).length
        if (count === 0) throw new Error("manifest advertises no surfaces")
        return `${count} surfaces advertised`
    })

    const surfaces = manifest.surfaces ?? {}

    // 2. Every advertised non-MCP surface actually serves (reachability-accurate).
    const probes: Array<[string, string]> = []
    if (surfaces.markdownRoutes?.example)
        probes.push(["markdownRoutes", surfaces.markdownRoutes.example])
    if (surfaces.llms?.url) probes.push(["llms", surfaces.llms.url])
    if (surfaces.llmsFull?.url) probes.push(["llmsFull", surfaces.llmsFull.url])
    if (surfaces.contextBundle?.example)
        probes.push(["contextBundle", surfaces.contextBundle.example])
    if (surfaces.search?.url)
        probes.push(["search", surfaces.search.url.replace("{query}", "a")])
    if (surfaces.sitemap?.xml)
        probes.push(["sitemap.xml", surfaces.sitemap.xml])
    if (surfaces.sitemap?.markdown)
        probes.push(["sitemap.md", surfaces.sitemap.markdown])
    if (surfaces.changes?.url) probes.push(["changes", surfaces.changes.url])
    if (surfaces.feedback?.schemaUrl)
        probes.push(["feedback?schema", surfaces.feedback.schemaUrl])
    if (surfaces.skill?.url) probes.push(["skill", surfaces.skill.url])
    if (surfaces.skill?.agents) probes.push(["AGENTS", surfaces.skill.agents])

    for (const [name, url] of probes) {
        await add(`advertised: ${name}`, async () => {
            await get(url)
            return `200 ${url}`
        })
    }

    // 3. .md route shape: clean markdown starting with a title header.
    const mdExample = surfaces.markdownRoutes?.example
    if (mdExample) {
        await add(".md route shape", async () => {
            const body = await (await get(mdExample, "text/markdown")).text()
            if (!pageContent(body).startsWith("# "))
                throw new Error('.md body does not start with "# "')
            if (body.startsWith("> ") && !body.includes("/llms.txt"))
                throw new Error("index preamble does not name llms.txt")
            return `text/markdown, ${body.length} chars`
        })

        // Discovery headers on the human page: typed Link relations, the
        // llms.txt pointer and the site's content signals.
        await add("HTML discovery headers", async () => {
            const res = await get(mdExample.replace(/\.md$/, ""), "text/html")
            const link = res.headers.get("link") ?? ""
            for (const rel of ["llms-txt", "describedby"])
                if (!link.includes(rel)) throw new Error(`Link lacks ${rel}`)
            if (!res.headers.get("x-llms-txt"))
                throw new Error("X-Llms-Txt missing")
            const signal = res.headers.get("content-signal") ?? ""
            if (!/search=(?:yes|no)/.test(signal))
                throw new Error(
                    `Content-Signal missing or malformed: ${signal}`,
                )
            return `Link + X-Llms-Txt + Content-Signal (${signal})`
        })

        // Content negotiation: the HTML URL + Accept: text/markdown serves
        // the markdown inline (no redirect hop), varying on Accept only.
        await add("Accept negotiation → markdown", async () => {
            const htmlUrl = mdExample.replace(/\.md$/, "")
            const res = await f(htmlUrl, {
                headers: { Accept: "text/markdown" },
                redirect: "manual",
            })
            if (res.status !== 200)
                throw new Error(`expected 200, got ${res.status}`)
            const type = res.headers.get("content-type") ?? ""
            if (!type.includes("text/markdown"))
                throw new Error(`negotiated content-type ${type}`)
            const vary = (res.headers.get("vary") ?? "").toLowerCase()
            if (vary.includes("user-agent")) {
                throw new Error("Vary: User-Agent present (CDN-unsafe)")
            }
            if (!vary.includes("accept"))
                throw new Error("Vary: Accept missing (CDN would cache HTML)")
            const body = await res.text()
            if (!pageContent(body).startsWith("# "))
                throw new Error('negotiated body does not start with "# "')
            return `200 ${type}, ${body.length} chars`
        })
    }

    // 3b. robots.txt grants or withholds AI uses explicitly.
    await add("robots Content-Signal", async () => {
        const text = await (await get(`${origin}/robots.txt`)).text()
        if (
            !/^Content-Signal: search=(?:yes|no), ai-input=(?:yes|no), ai-train=(?:yes|no)$/m.test(
                text,
            )
        )
            throw new Error("robots.txt has no Content-Signal line")
        return "Content-Signal present"
    })

    // 3c. A split llms.txt: every sub-index it links resolves.
    if (surfaces.llms?.url) {
        await add("llms.txt sub-indexes resolve", async () => {
            const text = await (await get(surfaces.llms.url)).text()
            if (!text.startsWith("# ")) throw new Error("llms.txt has no H1")
            // Sub-indexes may split further: follow every level.
            const linked = (body: string) =>
                [
                    ...body.matchAll(/\]\((https?:\/\/[^)]+\/_llms\/[^)]+)\)/g),
                ].map((match) => match[1] ?? "")
            const visited = new Set<string>()
            const queue = linked(text)
            for (let url = queue.shift(); url; url = queue.shift()) {
                if (visited.has(url)) continue
                visited.add(url)
                const body = await (await get(url)).text()
                if (!body.startsWith("# ")) throw new Error(`${url} has no H1`)
                queue.push(...linked(body))
            }
            return visited.size
                ? `${visited.size} sub-indexes resolve`
                : "single index (not split)"
        })
    }

    // 3d. Agent Skills: every indexed digest matches the bytes served.
    if (surfaces.skill?.index) {
        await add("agent-skills digests", async () => {
            const index = z
                .object({
                    $schema: z.string(),
                    skills: z
                        .array(
                            z.object({
                                name: z.string(),
                                type: z.literal("skill-md"),
                                url: z.string(),
                                digest: z.string(),
                            }),
                        )
                        .min(1),
                })
                .parse(await (await get(surfaces.skill.index)).json())
            for (const skill of index.skills) {
                // The served bytes, not decoded text: .text() would drop a
                // leading UTF-8 BOM the digest covers.
                const digest = await crypto.subtle.digest(
                    "SHA-256",
                    await (await get(skill.url)).arrayBuffer(),
                )
                const hex = [...new Uint8Array(digest)]
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("")
                if (`sha256:${hex}` !== skill.digest)
                    throw new Error(
                        `${skill.name}: digest does not match served bytes`,
                    )
            }
            return `${index.skills.length} skills, digests verified`
        })
    }

    // 3e. RFC 9727 API catalog parses as a linkset.
    if (surfaces.apiCatalog?.url) {
        await add("api-catalog linkset", async () => {
            const catalog = z
                .object({
                    linkset: z.array(
                        z.looseObject({
                            anchor: z.string(),
                            "service-desc": z
                                .array(z.object({ href: z.string() }))
                                .min(1),
                        }),
                    ),
                })
                .parse(
                    await (
                        await get(
                            surfaces.apiCatalog.url,
                            "application/linkset+json",
                        )
                    ).json(),
                )
            for (const entry of catalog.linkset)
                await get(entry["service-desc"][0]?.href ?? "")
            return `${catalog.linkset.length} APIs, specs reachable`
        })
    }

    // 4. llms-full under the size ceiling.
    if (surfaces.llmsFull?.url) {
        await add("llms-full under budget", async () => {
            const advertised = z.coerce
                .number()
                .int()
                .positive()
                .safeParse(surfaces.llmsFull?.maxChars)
            const maxLlmsFull =
                options.maxLlmsFullChars ??
                (advertised.success ? advertised.data : undefined)
            if (maxLlmsFull === undefined)
                throw new Error(
                    "manifest does not advertise llmsFull.maxChars and no ceiling was given",
                )
            const body = await (await get(surfaces.llmsFull.url)).text()
            if (body.length > maxLlmsFull)
                throw new Error(`${body.length} chars > ceiling ${maxLlmsFull}`)
            return `${body.length} chars ≤ ${maxLlmsFull}`
        })
    }

    // 5. MCP: advertised tools match the live handshake; read_page accepts a .md URL.
    if (surfaces.mcp?.url) {
        const mcpUrl = surfaces.mcp.url
        let advertisedTools: string[] = []
        await add("mcp descriptor", async () => {
            const desc = await (
                await get(`${origin}/.well-known/mcp.json`, "application/json")
            ).json()
            advertisedTools = desc.tools ?? []
            if (advertisedTools.length === 0)
                throw new Error("mcp.json advertises no tools")
            return `tools: ${advertisedTools.join(", ")}`
        })

        const rpc = async (method: string, params: unknown, id: number) => {
            const res = await f(mcpUrl, {
                method: "POST",
                headers: MCP_HEADERS,
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            })
            if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`)
            // Streamable HTTP may answer a POST as JSON or as an SSE stream
            // carrying the response in its data line (the stateless handler
            // does the latter for clients that accept both).
            const text = await res.text()
            const json = JSON.parse(
                text.trimStart().startsWith("{")
                    ? text
                    : (text
                          .split("\n")
                          .filter((line) => line.startsWith("data:"))
                          .at(-1)
                          ?.slice("data:".length) ?? ""),
            )
            if (json.error)
                throw new Error(`${method} → ${JSON.stringify(json.error)}`)
            return json.result
        }

        if (surfaces.mcp.serverCard) {
            await add("mcp server card", async () => {
                const card = z
                    .object({
                        $schema: z.string(),
                        name: z
                            .string()
                            .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
                        version: z.string(),
                        description: z.string().min(1).max(100),
                        remotes: z
                            .array(
                                z.object({ type: z.string(), url: z.string() }),
                            )
                            .min(1),
                    })
                    .parse(
                        await (
                            await get(
                                surfaces.mcp.serverCard,
                                "application/mcp-server-card+json",
                            )
                        ).json(),
                    )
                if (card.remotes[0]?.url !== mcpUrl)
                    throw new Error(
                        `card remote ${card.remotes[0]?.url} ≠ ${mcpUrl}`,
                    )
                return card.name
            })
        }

        await add("mcp initialize + tools/list", async () => {
            const init = await rpc(
                "initialize",
                {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "doctor", version: "1" },
                },
                1,
            )
            if (!init.instructions)
                throw new Error("initialize returned no instructions")
            const list = await rpc("tools/list", {}, 2)
            const names: string[] = (list.tools ?? []).map(
                (t: { name: string }) => t.name,
            )
            const missing = advertisedTools.filter((t) => !names.includes(t))
            if (missing.length)
                throw new Error(
                    `advertised tools missing from handshake: ${missing.join(", ")}`,
                )
            return `${names.length} tools match descriptor`
        })

        await add("mcp resources + prompts", async () => {
            const resources = await rpc("resources/list", {}, 4)
            if (!(resources.resources ?? []).length)
                throw new Error("resources/list is empty")
            const prompts = await rpc("prompts/list", {}, 5)
            if (!(prompts.prompts ?? []).length)
                throw new Error("prompts/list is empty")
            return `${resources.resources.length} resources, ${prompts.prompts.length} prompts`
        })

        await add("mcp query_docs_filesystem", async () => {
            const result = await rpc(
                "tools/call",
                {
                    name: "query_docs_filesystem",
                    arguments: { command: "find / -name '*.md' | head -3" },
                },
                6,
            )
            const stdout: string = result.structuredContent?.stdout ?? ""
            if (result.isError || !stdout.includes(".md"))
                throw new Error(
                    `no pages listed: ${JSON.stringify(result).slice(0, 200)}`,
                )
            return `${stdout.trim().split("\n").length} paths listed`
        })

        if (mdExample) {
            await add("mcp read_page accepts .md URL", async () => {
                const result = await rpc(
                    "tools/call",
                    { name: "read_page", arguments: { url: mdExample } },
                    3,
                )
                if (result.isError)
                    throw new Error("read_page returned isError for a .md URL")
                const text: string = result.content?.[0]?.text ?? ""
                if (!pageContent(text).startsWith("# "))
                    throw new Error("read_page text is not markdown")
                return `read_page('${mdExample}') → ${text.length} chars`
            })
        }
    }

    return checks
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
    const lines = checks.map(
        (c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`,
    )
    const failed = checks.filter((c) => !c.ok).length
    lines.push(
        "",
        failed === 0
            ? `All ${checks.length} checks passed.`
            : `${failed}/${checks.length} checks FAILED.`,
    )
    lines.push(
        "Note: this verifies reachability + shape of every advertised surface; it does not measure prose usefulness.",
    )
    return lines.join("\n")
}
