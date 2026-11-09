import { createFileRoute } from "@tanstack/react-router"
import { llmsFullResponse } from "@/lib/llms-index"

export const Route = createFileRoute("/llms-full.txt")({
    server: {
        handlers: {
            GET: ({ request }) => llmsFullResponse(request, []),
        },
    },
})
