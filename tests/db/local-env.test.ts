/**
 * The README's local setup (`cp .env.example .env`, then `bun run
 * db:migrate`) configures the database only through `.env`. The bunfig keeps
 * Bun from loading `.env` on its own, so the script must load it. Runs the
 * real package script from a directory holding the package's manifest,
 * bunfig and scripts beside a `.env`, with no database variable in the
 * environment. Needs a Postgres the DATABASE_URL role can create databases
 * on; skipped, loudly, without one.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const adminUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!adminUrl)
    console.warn(
        "DATABASE_URL not set — skipping the local .env suite (docker compose up -d postgres)",
    )

const databaseName = `local_env_${randomUUID().replaceAll("-", "")}`
const freshUrl = (() => {
    if (!adminUrl) return ""
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    return url.toString()
})()

const adminQuery = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
        await client.query(sql)
    } finally {
        await client.end()
    }
}

describe.skipIf(!adminUrl)("bun run db:migrate with the README's .env", () => {
    const checkout = mkdtempSync(join(tmpdir(), "docs-local-env-"))

    beforeAll(async () => {
        await adminQuery(`create database "${databaseName}"`)
        for (const entry of ["package.json", "bunfig.toml", "scripts"])
            symlinkSync(resolve(root, entry), join(checkout, entry))
        writeFileSync(join(checkout, ".env"), `DATABASE_URL=${freshUrl}\n`)
    })

    afterAll(async () => {
        rmSync(checkout, { recursive: true, force: true })
        await adminQuery(
            `drop database if exists "${databaseName}" with (force)`,
        )
    })

    it("migrates the database the .env names", async () => {
        await promisify(execFile)("bun", ["run", "db:migrate"], {
            cwd: checkout,
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME },
        })
        const client = new Client({ connectionString: freshUrl })
        await client.connect()
        try {
            const { rows } = await client.query(
                "select to_regclass('public.docs_site') as site",
            )
            expect(rows).toEqual([{ site: "docs_site" }])
        } finally {
            await client.end()
        }
    }, 60_000)
})
