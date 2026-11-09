"use client"

import { useEffect, useState } from "react"
import { z } from "zod/mini"
import { cn } from "@/lib/cn"

/**
 * <GitHub.Repo repo="owner/name" variant="inset|flat" />: a public
 * repository card with its description, star and fork counts. The data is fetched from api.github.com in the visitor's browser (no
 * server round-trip, no stored copy) and cached per session; while loading
 * or when the API refuses (rate limit, private repo) the card degrades to a
 * plain link with the repository name.
 */
const repoSchema = z.object({
    description: z.nullable(z.string()),
    stargazers_count: z.number(),
    forks_count: z.number(),
})

function parseRepo(input: string | undefined): string | null {
    if (typeof input !== "string") return null
    const trimmed = input.trim()
    const fromUrl = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(
        trimmed,
    )
    const slug = fromUrl ? `${fromUrl[1]}/${fromUrl[2]}` : trimmed
    return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug.replace(/\.git$/, "") : null
}

function GitHubRepo({
    repo,
    variant,
    className,
}: {
    repo?: string
    variant?: "inset" | "flat" | string
    className?: string
}) {
    const slug = parseRepo(repo)
    const [meta, setMeta] = useState<z.infer<typeof repoSchema> | null>(null)
    useEffect(() => {
        if (!slug) return
        const key = `docs:github-repo:v1:${slug}`
        try {
            const cached = sessionStorage.getItem(key)
            if (cached) {
                const parsed = repoSchema.safeParse(JSON.parse(cached))
                if (parsed.success) {
                    setMeta(parsed.data)
                    return
                }
            }
        } catch {}
        const controller = new AbortController()
        fetch(`https://api.github.com/repos/${slug}`, {
            headers: { Accept: "application/vnd.github+json" },
            signal: controller.signal,
        })
            .then((response) => (response.ok ? response.json() : null))
            .then((json: unknown) => {
                const parsed = repoSchema.safeParse(json)
                if (!parsed.success) return
                setMeta(parsed.data)
                try {
                    sessionStorage.setItem(key, JSON.stringify(parsed.data))
                } catch {}
            })
            .catch(() => {})
        return () => controller.abort()
    }, [slug])
    if (!slug) return null
    const flat = variant === "flat"
    const count = (value: number) => new Intl.NumberFormat().format(value)
    return (
        <a
            href={`https://github.com/${slug}`}
            target="_blank"
            rel="noreferrer noopener"
            data-github-repo=""
            className={cn(
                "not-prose my-4 block rounded-xl text-fd-card-foreground no-underline transition-colors",
                flat
                    ? "py-2"
                    : "border bg-fd-card p-4 hover:border-fd-primary/50",
                className,
            )}
        >
            <span className="flex items-center gap-2 font-medium text-sm">
                <svg
                    viewBox="0 0 24 24"
                    aria-hidden
                    className="size-4 shrink-0 fill-current"
                >
                    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
                </svg>
                <span className="truncate">{slug}</span>
            </span>
            {meta?.description ? (
                <span className="mt-1 block text-fd-muted-foreground text-sm">
                    {meta.description}
                </span>
            ) : null}
            {meta ? (
                <span className="mt-2 flex items-center gap-4 text-fd-muted-foreground text-xs">
                    <span title="Stars">★ {count(meta.stargazers_count)}</span>
                    <span title="Forks">⑂ {count(meta.forks_count)}</span>
                </span>
            ) : null}
        </a>
    )
}

/** Member components live on the root object like Tree.File. */
export const GitHub = Object.assign(
    function GitHub({ children }: { children?: React.ReactNode }) {
        return children
    },
    { Repo: GitHubRepo },
)
