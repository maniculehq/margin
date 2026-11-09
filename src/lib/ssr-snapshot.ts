import { createSerializationAdapter } from "@tanstack/react-router"

/**
 * The V8 isolate's HTML for a compiled-JS page body (lib/sandbox-render.ts),
 * as the document render sees it. The markup is already in the SSR HTML, so
 * the dehydrated loader data carries none of it: the adapter below writes
 * `null` on the wire and the browser rebuilds an empty snapshot. SandboxedBody
 * (routes/$.tsx) keeps the server-rendered node in place instead of
 * re-rendering it from the empty value. Client-navigation RPCs return the
 * HTML as a plain string, since that DOM does not exist yet.
 */
export class SsrSnapshot {
    constructor(readonly html: string) {}
}

export const ssrSnapshotAdapter = createSerializationAdapter({
    key: "ssr-snapshot",
    test: (value): value is SsrSnapshot => value instanceof SsrSnapshot,
    toSerializable: () => null,
    fromSerializable: () => new SsrSnapshot(""),
})
