import { createFileRoute } from "@tanstack/react-router"
import { llmsIndexResponse } from "@/lib/llms-index"

/** The /llms.txt index — docs pages linked by their root-served .md URLs. */
export const Route = createFileRoute("/llms.txt")({
    server: {
        handlers: {
            GET: ({ request }) => llmsIndexResponse(request, []),
        },
    },
})
