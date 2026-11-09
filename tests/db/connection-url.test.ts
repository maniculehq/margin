/**
 * createDb splits DATABASE_URL into pg's connection fields itself (the
 * bundled connection-string parser breaks on Vercel), so it must undo the
 * URL encoding the WHATWG parser leaves in place: IPv6 brackets around the
 * host, and percent-escapes in the database name and credentials.
 *
 * A stand-in server on the loopback plays Postgres just far enough to read
 * what the client sends: the startup packet (TLS request or plaintext
 * protocol 3.0 with user and database), then, after asking for a cleartext
 * password, the password message.
 */
import { once } from "node:events"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createDb } from "@/db"

const PROTOCOL_3 = 196_608

interface Handshake {
    /** The first packet's code: PROTOCOL_3, or 80877103 for a TLS request. */
    code: number
    params: Record<string, string>
    password: string | null
}

let server: Server | undefined

afterEach(async () => {
    server?.close()
    server = undefined
})

/** Connects createDb to a stand-in on `host` and returns what it sent. */
const handshake = async (
    host: "127.0.0.1" | "::1",
    url: (port: number) => string,
): Promise<Handshake> => {
    const received = new Promise<Handshake>((resolve, reject) => {
        server = createServer((socket: Socket) => {
            let buffer = Buffer.alloc(0)
            let startup: Omit<Handshake, "password"> | null = null
            socket.on("data", (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk])
                if (startup === null) {
                    if (buffer.length < 8) return
                    const length = buffer.readInt32BE(0)
                    if (buffer.length < length) return
                    const code = buffer.readInt32BE(4)
                    const fields = buffer
                        .subarray(8, length)
                        .toString("utf8")
                        .split("\0")
                    buffer = buffer.subarray(length)
                    const params: Record<string, string> = {}
                    for (let i = 0; i + 1 < fields.length; i += 2) {
                        const key = fields[i]
                        if (key) params[key] = fields[i + 1] ?? ""
                    }
                    startup = { code, params }
                    if (code !== PROTOCOL_3) {
                        resolve({ ...startup, password: null })
                        socket.destroy()
                        return
                    }
                    // AuthenticationCleartextPassword.
                    const ask = Buffer.alloc(9)
                    ask.write("R", 0)
                    ask.writeInt32BE(8, 1)
                    ask.writeInt32BE(3, 5)
                    socket.write(ask)
                    return
                }
                // PasswordMessage: 'p', int32 length, NUL-terminated string.
                if (buffer.length < 5) return
                const length = buffer.readInt32BE(1)
                if (buffer.length < length + 1) return
                resolve({
                    ...startup,
                    password: buffer.subarray(5, length).toString("utf8"),
                })
                socket.destroy()
            })
            socket.on("error", reject)
        }).listen(0, host)
    })
    if (!server) throw new Error("stand-in did not start")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string")
        throw new Error("stand-in did not bind a port")
    const db = createDb(url(address.port), { max: 1 })
    // The stand-in hangs up mid-handshake, so the query always fails; a
    // failure before the stand-in heard from the client is the result.
    const query = db.$client.query("select 1").then(
        () => new Error("the stand-in answered a query"),
        (error: unknown) => error,
    )
    try {
        return await Promise.race([
            received,
            query.then((error) => {
                throw error
            }),
        ])
    } finally {
        await query
        await db.$client.end()
    }
}

describe("createDb connection URLs", () => {
    it("reaches a bracketed IPv6 loopback host without TLS", async () => {
        const sent = await handshake(
            "::1",
            (port) => `postgres://docs:secret@[::1]:${port}/docs`,
        )
        expect(sent.code).toBe(PROTOCOL_3)
        expect(sent.params.database).toBe("docs")
    })

    it("decodes a percent-encoded database name", async () => {
        const sent = await handshake(
            "127.0.0.1",
            (port) => `postgres://docs:secret@127.0.0.1:${port}/my%20docs`,
        )
        expect(sent.params.database).toBe("my docs")
    })

    it("decodes credentials that contain @, : and /", async () => {
        const sent = await handshake(
            "127.0.0.1",
            (port) =>
                `postgres://us%40er%3Aname:p%40ss%3Aw%2Frd@127.0.0.1:${port}/docs`,
        )
        expect(sent.params.user).toBe("us@er:name")
        expect(sent.password).toBe("p@ss:w/rd")
    })
})
