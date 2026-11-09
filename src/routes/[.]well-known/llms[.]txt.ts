import { createFileRoute } from "@tanstack/react-router"
import { llmsIndexResponse } from "@/lib/llms-index"

/** Alias of /llms.txt for agents that probe the well-known location first. */
export const Route = createFileRoute("/.well-known/llms.txt")({
    server: {
        handlers: {
            GET: ({ request }) => llmsIndexResponse(request, []),
        },
    },
})
