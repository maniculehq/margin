import { formatDoctorReport, runDoctor } from "../src/lib/agent-doctor"

// Pure HTTP — run against a built local server or a deployed URL:
//   NITRO_PRESET=node-server bun run build && PORT=3005 node .output/server/index.mjs &
//   bun scripts/doctor.ts --url=http://127.0.0.1:3005
//   bun scripts/doctor.ts --url=https://docs.example.com
const urlArg = process.argv
    .find((a) => a.startsWith("--url="))
    ?.slice("--url=".length)
// Deliberately not the app env module: a pure HTTP probe of a deployed
// server must not require the local site's SITE_ORIGIN.
const baseUrl = urlArg ?? process.env.AGENT_DOCTOR_URL
if (!baseUrl) {
    throw new Error("Pass --url=<origin> or set AGENT_DOCTOR_URL.")
}

const checks = await runDoctor(baseUrl)
console.log(`\nAgent doctor — ${baseUrl}\n`)
console.log(formatDoctorReport(checks))
process.exit(checks.some((c) => !c.ok) ? 1 : 0)
