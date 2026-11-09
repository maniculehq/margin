import { createFileRoute } from "@tanstack/react-router"
import { llmsFullResponse } from "@/lib/llms-index"

/** Alias of /llms-full.txt for agents that probe the well-known location first. */
export const Route = createFileRoute("/.well-known/llms-full.txt")({
    server: {
        handlers: {
            GET: ({ request }) => llmsFullResponse(request, []),
        },
    },
})
