import { describe, expect, it } from "vitest"
import { agentConfig } from "@/lib/agent.config"
import { llmsFullChunks, shareLlmsFull } from "@/lib/agent-content"

const collect = async (
    texts: Iterable<string>,
    maxChars?: number,
): Promise<{ chunks: string[]; truncated: boolean; includedCount: number }> => {
    const chunks: string[] = []
    const generator = llmsFullChunks(texts, maxChars)
    let step = await generator.next()
    while (!step.done) {
        chunks.push(step.value)
        step = await generator.next()
    }
    return { chunks, ...step.value }
}

describe("llms-full budget", () => {
    // 200 pages × 5,000 chars = 1M chars: past the retired 600k cap, well
    // under the 4M default.
    const pages = Array.from(
        { length: 200 },
        (_, index) =>
            `# Page ${index} (/page-${index})\n\n${"x".repeat(4_950)}`,
    )

    it("emits every page of a corpus that exceeded the old 600k cap", async () => {
        const result = await collect(pages)
        expect(result.truncated).toBe(false)
        expect(result.includedCount).toBe(200)
        expect(result.chunks.join("")).toBe(pages.join("\n\n"))
    })

    it("stops at the budget and appends the truncation marker", async () => {
        const result = await collect(pages, 12_000)
        expect(result.truncated).toBe(true)
        expect(result.includedCount).toBe(2)
        expect(result.chunks.at(-1)).toBe(agentConfig.llmsFull.truncationMarker)
        expect(result.chunks.join("")).toBe(
            pages.slice(0, 2).join("\n\n") +
                agentConfig.llmsFull.truncationMarker,
        )
    })

    it("keeps the shared assembly alive for a second consumer when the first stops early", async () => {
        // Texts arrive one macrotask apart so the first consumer really does
        // leave before the pump has finished.
        const slow = (async function* () {
            for (const page of pages.slice(0, 5)) {
                await new Promise((resolve) => setTimeout(resolve, 0))
                yield page
            }
        })()
        const job = shareLlmsFull(slow, 5)

        const first = job.chunks()
        const opening = await first.next()
        expect(opening.done).toBe(false)
        // Simulates a disconnected response: the iterator is abandoned and
        // the consumer's own failure never reaches the job.
        await first.return()

        const second: string[] = []
        for await (const chunk of job.chunks()) second.push(chunk)
        expect(second.join("")).toBe(pages.slice(0, 5).join("\n\n"))

        const result = await job.result
        expect(result.truncated).toBe(false)
        expect(result.includedCount).toBe(5)
        expect(result.pageCount).toBe(5)
    })

    it("rejects every consumer when the assembly itself fails", async () => {
        const failing = (async function* () {
            yield pages[0] ?? ""
            throw new Error("processed markdown missing")
        })()
        const job = shareLlmsFull(failing, 1)
        job.result.catch(() => {})
        const consume = async () => {
            const seen: string[] = []
            for await (const chunk of job.chunks()) seen.push(chunk)
            return seen
        }
        await expect(consume()).rejects.toThrow("processed markdown missing")
        await expect(consume()).rejects.toThrow("processed markdown missing")
    })

    it("keeps a complete corpus that lands within the marker's width of the ceiling", async () => {
        const marker = agentConfig.llmsFull.truncationMarker
        const maxChars = 10_000
        const only = "y".repeat(maxChars - Math.floor(marker.length / 2))
        const chunks: string[] = []
        const generator = llmsFullChunks([only], maxChars)
        let step = await generator.next()
        while (!step.done) {
            chunks.push(step.value)
            step = await generator.next()
        }
        expect(step.value).toEqual({ truncated: false, includedCount: 1 })
        expect(chunks.join("")).toBe(only)
    })
})
