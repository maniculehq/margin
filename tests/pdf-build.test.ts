import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { build, createNitro } from "nitro/builder"
import { expect, it } from "vitest"
import config from "../vite.config"

it.concurrent("serves standard PDF fonts from the packaged Node artifact", async () => {
    const directory = await mkdtemp(join(import.meta.dirname, ".pdf-build-"))
    const nitro = await createNitro({
        ...config.nitro,
        rootDir: directory,
        preset: "node-server",
        routes: { "/fonts.pdf": "./handler.ts" },
        typescript: { tsConfig: { compilerOptions: { jsx: "react-jsx" } } },
        logLevel: 0,
    })
    try {
        await writeFile(
            join(directory, "handler.ts"),
            [
                `import { parsePageMarkdown, renderPagePdf } from ${JSON.stringify(join(import.meta.dirname, "../src/lib/page-pdf.tsx"))}`,
                "export default async () => new Response(await renderPagePdf({",
                'title: "PDF font regression",',
                'url: "https://docs.test/fonts",',
                'root: parsePageMarkdown("Normal text, **bold text**, and `code text`."),',
                "images: new Map(),",
                '}), { headers: { "content-type": "application/pdf" } })',
            ].join("\n"),
        )
        await build(nitro)
        const server = spawn(
            process.execPath,
            [join(nitro.options.output.serverDir, "index.mjs")],
            {
                cwd: nitro.options.output.serverDir,
                env: {
                    PATH: process.env.PATH,
                    NODE_ENV: "production",
                    NITRO_HOST: "127.0.0.1",
                    NITRO_PORT: "0",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        )
        let output = ""
        const ready = new Promise<string>((done, fail) => {
            // The listener announces readiness after loading the packaged
            // modules. Wait for that event within the test's overall budget;
            // a separate polling deadline races cold imports under load.
            server.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString()
                const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
                if (address) done(address)
            })
            server.stderr.on("data", (chunk: Buffer) => {
                output += chunk.toString()
            })
            server.once("error", fail)
            server.once("exit", (code, signal) =>
                fail(
                    new Error(
                        `PDF server exited (${code ?? signal}): ${output}`,
                    ),
                ),
            )
        })
        try {
            const origin = await ready
            const response = await fetch(`${origin}/fonts.pdf`)
            expect(response.status, output).toBe(200)
            expect(response.headers.get("content-type")).toBe("application/pdf")
            const pdf = Buffer.from(await response.arrayBuffer()).toString(
                "latin1",
            )
            expect(pdf.startsWith("%PDF-")).toBe(true)
            for (const font of ["Helvetica", "Helvetica-Bold", "Courier"]) {
                expect(pdf).toContain(`/BaseFont /${font}\n`)
            }
            const manifest = await readFile(
                join(
                    nitro.options.output.serverDir,
                    "node_modules/pdfkit/package.json",
                ),
                "utf8",
            )
            expect(manifest).toContain('"#standard-fonts/*"')
        } finally {
            if (server.exitCode === null) {
                const stopped = once(server, "exit")
                server.kill()
                await stopped
            }
        }
    } finally {
        await nitro.close()
        await rm(directory, { recursive: true, force: true })
    }
}, 180_000)
