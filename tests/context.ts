import { inflateSync } from "node:zlib"
import { env } from "@/env"

/**
 * Content-backed suites run against a real seeded Postgres: point
 * DATABASE_URL at a database with each fixture ingested via
 * `bun scripts/ingest.ts --dir tests/fixtures/<name> --slug <name>`.
 * Suites are skipped — loudly — when no database is configured.
 */
export const hasDocsDb = Boolean(env.DATABASE_URL)
if (!hasDocsDb)
    console.warn(
        "DATABASE_URL not set — skipping DB-backed docs suites (ingest fixtures with scripts/ingest.ts --dir tests/fixtures/<name> --slug <name>)",
    )

export function requestFor(host: string, path = "/"): Request {
    return new Request(`http://placeholder.local${path}`, {
        headers: { host },
    })
}

/**
 * A PDF's text: every TJ operand's hex glyph runs, decoded from the inflated
 * content streams (the renderer's standard fonts encode WinAnsi bytes).
 */
export function pdfText(bytes: Uint8Array): string {
    const pdf = Buffer.from(bytes).toString("latin1")
    return [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
        .map((match) => {
            try {
                return inflateSync(
                    Buffer.from(match[1] ?? "", "latin1"),
                ).toString("latin1")
            } catch {
                return ""
            }
        })
        .flatMap((stream) =>
            [...stream.matchAll(/\[(.*?)\]\s*TJ/g)].map((op) =>
                [...(op[1] ?? "").matchAll(/<([0-9a-f]*)>/gi)]
                    .map((hex) =>
                        Buffer.from(hex[1] ?? "", "hex").toString("latin1"),
                    )
                    .join(""),
            ),
        )
        .join("\n")
}
