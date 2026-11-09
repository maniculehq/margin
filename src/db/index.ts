import { attachDatabasePool } from "@vercel/functions"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { resolveEnv } from "./env"
import { schema } from "./schema"

/** Create an independent pool; callers must close its $client when finished.
 *  `DATABASE_POOL_MAX` (default 2) bounds one warm instance's share of the
 *  database's connection budget; an explicit `max` wins for the few callers
 *  that need their own pool (test holders, one-off scripts). */
export function createDb(
    databaseUrl = resolveEnv().DATABASE_URL,
    options: { max?: number } = {},
) {
    // Parse the URL client-side and pass individual fields to pg to bypass any
    // URL parsing in the bundled `pg-connection-string`. On Vercel the bundled
    // parser interprets `sslmode=verify-full` by trying to `readFileSync('system')`
    // as a CA bundle, which fails with ENOENT and breaks every query.
    // The WHATWG parser keeps an IPv6 host's brackets and leaves the path
    // and credentials percent-encoded; pg wants the bare values.
    const url = new URL(databaseUrl)
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
    const max = options.max ?? resolveEnv().DATABASE_POOL_MAX ?? 2
    const isLocalHost =
        host === "localhost" || host === "127.0.0.1" || host === "::1"
    const pool = new Pool({
        host,
        port: url.port ? Number(url.port) : 5432,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, "")),
        // Verify the server certificate. Neon (the Vercel Marketplace
        // default) presents a publicly trusted certificate.
        ssl: !isLocalHost,
        application_name: "margin",
        // Fluid Compute serves many requests per instance and they all draw
        // on this pool, so `max: 1` would turn any slow statement into a
        // failure for every concurrent request on the instance. A small pool
        // lets unrelated requests pass; a pooler in front of the database
        // absorbs the multiplied connection count. Release idle connections
        // after 10 s so quiet instances stop counting against the
        // budget, and fail a starved acquire fast (pg-pool's "timeout
        // exceeded when trying to connect") instead of hanging a request
        // until the function deadline. The same timer bounds the handshake,
        // and a serverless compute waking from suspend or a loaded CI host
        // can take more than 5 s, so 10 s is the floor.
        max,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
    })
    // Fluid Compute can freeze the instance before the pool's idle timer
    // fires. Keep it alive through that timeout with `waitUntil`; this does
    // not retry failed handshakes and is inactive outside Vercel.
    attachDatabasePool(pool)
    // pg-pool emits 'error' when the server kills an IDLE connection
    // (managed Postgres maintenance: "terminating connection due to administrator
    // command"). With no listener, Node's EventEmitter turns that into an
    // instance-killing uncaught exception; the pool already discards the dead
    // client, so the right response is a log — the next query dials fresh.
    pool.on("error", (error) => {
        console.warn(`[db] idle connection error: ${error.message}`)
    })
    return drizzle({ client: pool })
}

type Db = ReturnType<typeof createDb>

let instance: Db | undefined

// The proxy target is never queried — every trap reads the lazily created
// instance — it only gives the proxy its type. An unconnected Pool opens no
// socket and reads no environment, so importing this module stays free.
const db = new Proxy<Db>(drizzle({ client: new Pool() }), {
    get(_target, prop) {
        instance ??= createDb()
        const value = Reflect.get(instance, prop, instance)
        return typeof value === "function" ? value.bind(instance) : value
    },
    has(_target, prop) {
        instance ??= createDb()
        return Reflect.has(instance, prop)
    },
})

export { db, schema }
