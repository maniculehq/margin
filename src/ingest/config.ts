import { z } from "zod"
import {
    applyRedirectPattern,
    CONFIG_EXTENSION_KEY,
    configExtensionSchema,
    type Diagnostic,
    type DocsConfigSuperset,
    docsConfigSupersetSchema,
    docsLocaleTagSchema,
    docsNotFoundErrorSchema,
    docsSeoOrganizationSchema,
    docsSeoProvenanceSchema,
    docsSeoPublisherSchema,
    docsSeoTitleTemplateSchema,
    docsVariationsSchema,
    integrationsSchema,
    isAllowedUrl,
    type NormalizedRedirect,
    normalizedRedirectSchema,
    parseRedirectPattern,
    redirectCaptureTokens,
    redirectSchema,
    type StoredIntegrations,
    type StoredSeo,
    storedIntegrationsSchema,
    storedSeoSchema,
} from "../types/docs"
import type { DocsSnapshotFile } from "./compile"
import type { DocsViolation } from "./validate"

export type {
    NormalizedRedirect,
    StoredIntegrations,
    StoredSeo,
} from "../types/docs"

const configObjectSchema = z.record(z.string(), z.unknown())
const chromeLinkSchema = z
    .object({
        label: z.string().optional(),
        name: z.string().optional(),
        href: z.string().min(1),
    })
    .passthrough()
const footerColumnSchema = z
    .object({
        header: z.string().min(1),
        items: z.array(z.unknown()),
    })
    .passthrough()
const footerItemSchema = z
    .object({ label: z.string().min(1), href: z.string().min(1) })
    .passthrough()

const droppedConfigHref = Symbol("droppedConfigHref")

function sanitizeConfigHrefs(input: {
    value: unknown
    path: string
    configPath: string
    diagnostics: Diagnostic[]
}): unknown | typeof droppedConfigHref {
    if (Array.isArray(input.value))
        return input.value.flatMap((value, index) => {
            const sanitized = sanitizeConfigHrefs({
                ...input,
                value,
                path: `${input.path}.${index}`,
            })
            return sanitized === droppedConfigHref ? [] : [sanitized]
        })

    const object = configObjectSchema.safeParse(input.value)
    if (!object.success) return input.value
    const href = object.data.href
    if (typeof href === "string" && !isAllowedUrl(href)) {
        input.diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: `Invalid config href "${input.path}.href"; the link was dropped.`,
            path: input.configPath,
        })
        const hasContainerContent = [
            "directory",
            "groups",
            "pages",
            "tabs",
            "dropdowns",
            "anchors",
            "products",
            "versions",
            "languages",
            "menu",
            "global",
            "openapi",
            "asyncapi",
        ].some((key) => key in object.data)
        const isLeafLink = !hasContainerContent
        if (isLeafLink) return droppedConfigHref
    }

    return Object.fromEntries(
        Object.entries(object.data).flatMap(([key, value]) => {
            if (
                key === "href" &&
                typeof href === "string" &&
                !isAllowedUrl(href)
            )
                return []
            const sanitized = sanitizeConfigHrefs({
                ...input,
                value,
                path: input.path ? `${input.path}.${key}` : key,
            })
            return sanitized === droppedConfigHref ? [] : [[key, sanitized]]
        }),
    )
}

const unsafeMetaValue = /<\s*(?:script|style|link)\b|javascript\s*:/i
const officialPosthogOrigins = new Set([
    "https://us.i.posthog.com",
    "https://eu.i.posthog.com",
    "https://us.posthog.com",
    "https://eu.posthog.com",
])

/** Longest redirect chain the loop walker follows before calling it a loop. */
const MAX_REDIRECT_HOPS = 32

function isExternalDestination(value: string): boolean {
    return /^https?:\/\//i.test(value)
}

/** Strip `#fragment`/`?query` — pattern and page matching see paths only. */
function pathOnly(value: string): string {
    const boundary = value.search(/[?#]/)
    return boundary === -1 ? value : value.slice(0, boundary)
}

/** Loop/shadow bookkeeping key: every capture collapses to one token. */
function redirectNode(value: string): string {
    const parts = parseRedirectPattern(pathOnly(value))
    if (!parts) return pathOnly(value)
    return `/${parts
        .map((part) =>
            part.kind === "literal"
                ? part.value
                : part.kind === "partial"
                  ? `${part.prefix}*`
                  : ":wildcard",
        )
        .join("/")}`
}

export function resolveDeploymentConfig(input: {
    config: DocsConfigSuperset | null
    servedUrls: string[]
    diagnostics: Diagnostic[]
    /**
     * Pipeline-generated redirects (the missing-root-index home redirect)
     * validated alongside the authored set, so authored redirects that
     * TARGET the generated route (e.g. /old → /) resolve instead of being
     * dropped as unreachable. Appended after the authored redirects —
     * callers must not pass a source an authored redirect already claims.
     */
    syntheticRedirects?: Array<{
        source: string
        destination: string
        permanent?: boolean
    }>
}): {
    redirects: NormalizedRedirect[]
    seo: StoredSeo
    integrations: StoredIntegrations
} {
    const config = input.config
    const servedUrls = new Set(input.servedUrls)
    const redirects = [
        ...(config?.redirects ?? []),
        ...(input.syntheticRedirects ?? []),
    ].flatMap((redirect) => {
        if (
            /^[a-z][a-z\d+.-]*:/i.test(redirect.source) ||
            (/^[a-z][a-z\d+.-]*:/i.test(redirect.destination) &&
                !isExternalDestination(redirect.destination))
        ) {
            input.diagnostics.push({
                code: "redirect_invalid",
                severity: "warn",
                message: `Redirect "${redirect.source}" has an invalid source or destination and was dropped.`,
                path: "docs.json",
            })
            return []
        }
        // Docs serve at the tenant root, so authored targets normalize to
        // root-relative paths: guarantee the leading slash, trim a trailing
        // one (except for the index page, which IS "/").
        // Normalizes the PATH component: a destination may carry `?query`
        // or `#fragment` after a trailing slash (`/guide/?tab=api`), which
        // must not hide the slash from the trim.
        const normalizeTarget = (value: string): string => {
            const boundary = value.search(/[?#]/)
            const path = boundary === -1 ? value : value.slice(0, boundary)
            const suffix = boundary === -1 ? "" : value.slice(boundary)
            const slashed = path.startsWith("/") ? path : `/${path}`
            const trimmed =
                slashed !== "/" && slashed.endsWith("/")
                    ? slashed.slice(0, -1)
                    : slashed
            return `${trimmed}${suffix}`
        }
        const source = normalizeTarget(redirect.source)
        // Authored redirects can target the /x/index spelling of an
        // x/index.mdx page; our served URL is /x, so the destination lands there directly
        // instead of being dropped as missing (or chaining a second 308).
        const destination = isExternalDestination(redirect.destination)
            ? redirect.destination
            : normalizeTarget(redirect.destination).replace(
                  /^(\/(?:[^?#]*?))?\/index(?=$|[?#])/,
                  (_match, prefix: string | undefined) => prefix || "/",
              )
        // Redirect grammar: sources carry no anchors or query strings;
        // destinations may. Wildcards follow the shared grammar in @/types/docs, and a
        // destination may only substitute tokens its source captured.
        const sourceParts = /[?#]/.test(source)
            ? null
            : parseRedirectPattern(source)
        const destinationPath = isExternalDestination(destination)
            ? destination
            : pathOnly(destination)
        const destinationTokens = [
            ...destinationPath.matchAll(/:[A-Za-z_][\w-]*\*?|\*/g),
        ].map((match) => match[0])
        const allowedTokens = sourceParts
            ? new Set(redirectCaptureTokens(sourceParts))
            : new Set<string>()
        if (
            sourceParts === null ||
            destinationTokens.some((token) => !allowedTokens.has(token))
        ) {
            input.diagnostics.push({
                code: "redirect_invalid",
                severity: "warn",
                message: `Redirect "${redirect.source}" has an invalid source or wildcard mapping and was dropped.`,
                path: "docs.json",
            })
            return []
        }
        return [
            normalizedRedirectSchema.parse({
                source,
                destination,
                ...(redirect.permanent === undefined
                    ? {}
                    : { permanent: redirect.permanent }),
            }),
        ]
    })

    // Walk by RULE identity with the serving matcher's precedence (exact
    // source first, then the first matching pattern in declaration order):
    // keying by a collapsed wildcard node let a later overlapping pattern
    // stand in for the earlier one the route would actually take.
    const nextRule = (destination: string): number => {
        const destinationPath = pathOnly(destination)
        const exact = redirects.findIndex(
            (candidate) => candidate.source === destinationPath,
        )
        if (exact !== -1) return exact
        return redirects.findIndex(
            (candidate) =>
                applyRedirectPattern({
                    pathname: destinationPath,
                    source: candidate.source,
                    destination: "",
                }) !== null,
        )
    }
    const cyclicRules = new Set<number>()
    for (let start = 0; start < redirects.length; start += 1) {
        const chain: number[] = []
        const positions = new Map<number, number>()
        let current = start
        while (current !== -1) {
            const position = positions.get(current)
            // A revisited rule closes a cycle; a walk still hopping past the
            // cap is one the serving route would never finish either.
            if (position !== undefined || chain.length >= MAX_REDIRECT_HOPS) {
                for (const rule of chain.slice(position ?? 0))
                    cyclicRules.add(rule)
                break
            }
            positions.set(current, chain.length)
            chain.push(current)
            const rule = redirects[current]
            if (!rule || isExternalDestination(rule.destination)) break
            current = nextRule(rule.destination)
        }
    }

    let admittedRedirects = redirects.filter((redirect) => {
        if (cyclicRules.has(redirects.indexOf(redirect))) {
            input.diagnostics.push({
                code: "redirect_invalid",
                severity: "warn",
                message: `Redirect "${redirect.source}" forms a loop and was dropped.`,
                path: "docs.json",
            })
            return false
        }
        const shadowsPage = [...servedUrls].some(
            (url) =>
                applyRedirectPattern({
                    pathname: url,
                    source: redirect.source,
                    destination: "",
                }) !== null,
        )
        if (shadowsPage) {
            input.diagnostics.push({
                code: "redirect_shadows_page",
                severity: "warn",
                message: `Redirect "${redirect.source}" shadows a published page and was dropped.`,
                path: "docs.json",
            })
            return false
        }
        return true
    })

    let changed = true
    while (changed) {
        changed = false
        const sources = new Set(
            admittedRedirects.map((redirect) => redirect.source),
        )
        admittedRedirects = admittedRedirects.filter((redirect) => {
            const destinationPath = pathOnly(redirect.destination)
            // A capturing destination is itself a pattern in the shared
            // grammar (`/guides/:section/new-*`): it is reachable when some
            // served page matches it. A plain one must name a page (or
            // another redirect).
            const destinationCaptures =
                /\/(?::[A-Za-z_][\w-]*\*?|[^/]*\*)(?:\/|$)/.test(
                    destinationPath,
                )
            const destinationMatchesPage = destinationCaptures
                ? [...servedUrls].some(
                      (url) =>
                          applyRedirectPattern({
                              pathname: url,
                              source: destinationPath,
                              destination: "",
                          }) !== null,
                  )
                : servedUrls.has(destinationPath)
            const destinationMatchesRedirect = admittedRedirects.some(
                (candidate) =>
                    redirectNode(candidate.source) ===
                        redirectNode(destinationPath) ||
                    applyRedirectPattern({
                        pathname: destinationPath,
                        source: candidate.source,
                        destination: "",
                    }) !== null,
            )
            if (
                isExternalDestination(redirect.destination) ||
                destinationMatchesPage ||
                sources.has(destinationPath) ||
                destinationMatchesRedirect
            )
                return true
            input.diagnostics.push({
                code: "redirect_invalid",
                severity: "warn",
                message: `Redirect "${redirect.source}" targets a missing internal destination and was dropped.`,
                path: "docs.json",
            })
            changed = true
            return false
        })
    }

    const metatags: Record<string, string> = {}
    for (const [key, value] of Object.entries(config?.seo?.metatags ?? {})) {
        if (unsafeMetaValue.test(key) || unsafeMetaValue.test(value)) {
            input.diagnostics.push({
                code: "head_rejected",
                severity: "warn",
                message: `SEO metatag "${key}" was rejected because only inert meta values are allowed.`,
                path: "docs.json",
            })
        } else if (key.toLowerCase() === "canonical") {
            // seo.metatags is site-wide; a canonical here would
            // stamp the same destination URL onto
            // every page, telling crawlers the whole site is a duplicate of
            // it. Pages always emit their own self-canonical instead.
            input.diagnostics.push({
                code: "head_rejected",
                severity: "warn",
                message:
                    'SEO metatag "canonical" was ignored: it is site-wide, but canonical URLs are per-page; each page emits its own.',
                path: "docs.json",
            })
        } else {
            metatags[key] = value
        }
    }
    const headMeta = (config?.[CONFIG_EXTENSION_KEY]?.head?.meta ?? []).filter(
        (meta) => {
            const unsafe = Object.entries(meta).some(
                ([key, value]) =>
                    unsafeMetaValue.test(key) ||
                    unsafeMetaValue.test(
                        typeof value === "string"
                            ? value
                            : (JSON.stringify(value) ?? ""),
                    ),
            )
            if (unsafe) {
                input.diagnostics.push({
                    code: "head_rejected",
                    severity: "warn",
                    message:
                        "A head meta entry was rejected because only inert meta values are allowed.",
                    path: "docs.json",
                })
            }
            return !unsafe
        },
    )
    // docs.json seo.organization is the standard publisher identity; the
    // config-extension seo.publisher stays as a legacy alias and loses
    // when both are authored. `id` is intentionally unmapped — the JSON-LD
    // graph mints its own origin-bound @id at serve time.
    const organization = config?.seo?.organization
    // Validated through the publisher schema (never a cast): the mapped
    // object is exactly the stored shape.
    const organizationPublisher =
        organization &&
        Object.entries(organization).some(
            ([key, value]) => key !== "id" && value !== undefined,
        )
            ? docsSeoPublisherSchema.parse({
                  type: "Organization",
                  ...(organization.name === undefined
                      ? {}
                      : { name: organization.name }),
                  ...(organization.legalName === undefined
                      ? {}
                      : { legalName: organization.legalName }),
                  ...(organization.url === undefined
                      ? {}
                      : { url: organization.url }),
                  ...(organization.logo === undefined
                      ? {}
                      : { logoUrl: organization.logo }),
                  ...(organization.sameAs === undefined
                      ? {}
                      : { sameAs: organization.sameAs }),
              })
            : undefined
    const seo = storedSeoSchema.parse({
        ...(config?.description === undefined
            ? {}
            : { description: config.description }),
        indexing: config?.seo?.indexing ?? "navigable",
        trailingSlash: config?.seo?.trailingSlash ?? false,
        metatags,
        ogDefaults: { ...(config?.thumbnails ?? {}) },
        titleTemplate: config?.[CONFIG_EXTENSION_KEY]?.seo?.titleTemplate,
        language: config?.[CONFIG_EXTENSION_KEY]?.seo?.language,
        publisher:
            organizationPublisher ??
            config?.[CONFIG_EXTENSION_KEY]?.seo?.publisher,
        provenance: config?.[CONFIG_EXTENSION_KEY]?.seo?.provenance,
        headMeta,
    })

    const enabled: Record<string, Record<string, string>> = {}
    const ignored: Record<string, unknown> = {}
    const integrations = config?.integrations
    if (integrations?.ga4)
        enabled.ga4 = { measurementId: integrations.ga4.measurementId }
    if (integrations?.fathom)
        enabled.fathom = { siteId: integrations.fathom.siteId }
    if (integrations?.clarity)
        enabled.clarity = { projectId: integrations.clarity.projectId }
    // Long-tail vendors, all data-only keys injected into PINNED official
    // script origins by the framework (never tenant-selected hosts).
    if (integrations?.amplitude)
        enabled.amplitude = { apiKey: integrations.amplitude.apiKey }
    if (integrations?.mixpanel)
        enabled.mixpanel = {
            projectToken: integrations.mixpanel.projectToken,
            // Data-only residency key: the renderer maps eu/in onto PINNED
            // official ingestion origins; a mismatched region drops events.
            ...(integrations.mixpanel.region &&
            integrations.mixpanel.region !== "us"
                ? { region: integrations.mixpanel.region }
                : {}),
        }
    if (integrations?.segment)
        enabled.segment = { key: integrations.segment.key }
    if (integrations?.hotjar) {
        // Hotjar ids are numeric — a non-digit value would look enabled but
        // silently emit no snippet at serve time.
        const hjid = String(integrations.hotjar.hjid)
        const hjsv = String(integrations.hotjar.hjsv ?? 6)
        if (/^\d+$/.test(hjid)) {
            enabled.hotjar = {
                hjid,
                hjsv: /^\d+$/.test(hjsv) ? hjsv : "6",
            }
        } else {
            ignored.hotjar = { hjid: integrations.hotjar.hjid }
            input.diagnostics.push({
                code: "integration_unsupported",
                severity: "warn",
                message:
                    "Hotjar hjid was ignored because it is not a numeric site id.",
                path: "docs.json",
            })
        }
    }
    if (integrations?.intercom)
        enabled.intercom = { appId: integrations.intercom.appId }
    if (integrations?.plausible) {
        enabled.plausible = { domain: integrations.plausible.domain }
        if ("server" in integrations.plausible) {
            ignored.plausible = { server: integrations.plausible.server }
            input.diagnostics.push({
                code: "integration_unsupported",
                severity: "warn",
                message:
                    "Plausible server was ignored because tenant-selected script origins are not allowed.",
                path: "docs.json",
            })
        }
    }
    if (integrations?.posthog) {
        enabled.posthog = { apiKey: integrations.posthog.apiKey }
        if (integrations.posthog.apiHost) {
            let origin: string | null = null
            try {
                const url = new URL(integrations.posthog.apiHost)
                if (url.pathname === "/" && !url.search && !url.hash)
                    origin = url.origin
            } catch {
                origin = null
            }
            if (origin && officialPosthogOrigins.has(origin)) {
                enabled.posthog.apiHost = origin
            } else {
                ignored.posthog = { apiHost: integrations.posthog.apiHost }
                input.diagnostics.push({
                    code: "integration_unsupported",
                    severity: "warn",
                    message:
                        "PostHog apiHost was ignored because it is not an official PostHog cloud origin.",
                    path: "docs.json",
                })
            }
        }
    }
    for (const [provider, value] of Object.entries(integrations ?? {})) {
        if (
            [
                "ga4",
                "posthog",
                "plausible",
                "fathom",
                "clarity",
                "amplitude",
                "mixpanel",
                "segment",
                "hotjar",
                "intercom",
            ].includes(provider)
        )
            continue
        ignored[provider] = value
        input.diagnostics.push({
            code: "integration_unsupported",
            severity: "warn",
            message: `Integration "${provider}" is stored but not executable under INV-2.`,
            path: "docs.json",
        })
    }

    return {
        redirects: admittedRedirects,
        seo,
        integrations: storedIntegrationsSchema.parse({ enabled, ignored }),
    }
}

export function parseDocsConfig(files: DocsSnapshotFile[]): {
    config: DocsConfigSuperset | null
    diagnostics: Diagnostic[]
    navSource: "filesystem" | "config"
    fatal: DocsViolation | null
} {
    const diagnostics: Diagnostic[] = []
    const textFiles = files.filter(
        (file): file is Extract<DocsSnapshotFile, { kind: "text" }> =>
            file.kind === "text",
    )
    const docsFile = textFiles.find((file) => file.path === "docs.json")
    const mintFile = textFiles.find((file) => file.path === "mint.json")
    const configFile = docsFile ?? mintFile

    if (docsFile && mintFile) {
        diagnostics.push({
            code: "config_dual",
            severity: "info",
            message:
                "Both docs.json and mint.json are present; docs.json takes precedence.",
            path: "docs.json",
        })
    } else if (mintFile) {
        // DIAGNOSTIC_CODES has no dedicated legacy-mint.json code. config_dual
        // is the closest config-selection diagnostic and keeps the persisted
        // report within the canonical tuple.
        diagnostics.push({
            code: "config_dual",
            severity: "info",
            message: "Using legacy mint.json because docs.json is absent.",
            path: "mint.json",
        })
    }

    if (!configFile) {
        return {
            config: null,
            diagnostics,
            navSource: "filesystem",
            fatal: null,
        }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(configFile.content)
    } catch {
        return {
            config: null,
            diagnostics,
            navSource: "filesystem",
            fatal: { path: configFile.path, message: "invalid JSON" },
        }
    }

    // docs.json navigation may reference sibling JSON files with a sole `$ref`.
    // Resolve refs only in navigation, dropping unresolved nodes with a warning.
    // Reject paths outside the snapshot root, cap total expansion, and clone
    // cached targets so repeated references do not share objects.
    const droppedRef = Symbol("droppedRef")
    const MAX_REF_EXPANSIONS = 32
    const MAX_REF_BYTES = 2 * 1024 * 1024
    let refExpansions = 0
    let refBytes = 0
    const refParseCache = new Map<string, unknown>()
    const resolveRefs = (
        value: unknown,
        baseDir: string,
        stack: readonly string[],
    ): unknown => {
        if (Array.isArray(value)) {
            return value
                .map((entry) => resolveRefs(entry, baseDir, stack))
                .filter((entry) => entry !== droppedRef)
        }
        if (typeof value !== "object" || value === null) return value
        const record = configObjectSchema.safeParse(value)
        if (!record.success) return value
        const ref = record.data.$ref
        if (typeof ref === "string" && Object.keys(record.data).length === 1) {
            const dropRef = (reason: string) => {
                diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `Config $ref "${ref}" ${reason}; the node was dropped.`,
                    path: configFile.path,
                })
                return droppedRef
            }
            const segments = baseDir ? baseDir.split("/") : []
            for (const part of ref.replaceAll("\\", "/").split("/")) {
                if (!part || part === ".") continue
                if (part === "..") {
                    // Underflow past the snapshot root must reject, not
                    // silently clamp onto an unrelated root-level file.
                    if (segments.length === 0)
                        return dropRef("escapes the snapshot root")
                    segments.pop()
                } else segments.push(part)
            }
            const refPath = segments.join("/")
            if (!/\.json$/i.test(refPath) || /^[a-z][a-z\d+.-]*:/i.test(ref))
                return dropRef("must point to a .json file in the snapshot")
            if (stack.includes(refPath) || stack.length >= 8)
                return dropRef("is circular or nested too deeply")
            const target = textFiles.find((file) => file.path === refPath)
            if (!target) return dropRef("names a file that was not ingested")
            refExpansions += 1
            refBytes += target.content.length
            if (refExpansions > MAX_REF_EXPANSIONS || refBytes > MAX_REF_BYTES)
                return dropRef("exceeds the reference expansion budget")
            let targetParsed: unknown
            if (refParseCache.has(refPath)) {
                targetParsed = structuredClone(refParseCache.get(refPath))
            } else {
                try {
                    targetParsed = JSON.parse(target.content)
                } catch {
                    return dropRef("is not valid JSON")
                }
                refParseCache.set(refPath, targetParsed)
                targetParsed = structuredClone(targetParsed)
            }
            return resolveRefs(
                targetParsed,
                refPath.split("/").slice(0, -1).join("/"),
                [...stack, refPath],
            )
        }
        return Object.fromEntries(
            Object.entries(record.data).flatMap(([key, entry]) => {
                const resolved = resolveRefs(entry, baseDir, stack)
                return resolved === droppedRef ? [] : [[key, resolved]]
            }),
        )
    }
    const objectResult = configObjectSchema.safeParse(parsed)
    let candidate: Record<string, unknown>
    if (objectResult.success) {
        candidate = objectResult.data
    } else {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message: "Invalid config root: expected an object; using defaults.",
            path: configFile.path,
        })
        candidate = {}
    }
    // Sites may keep redirects in a sibling file
    // (`"redirects": {"$ref": "./redirects.json"}`), so the same $ref
    // expansion applies to that key — a redirect object left unexpanded
    // parses as zero redirects and every legacy URL 404s.
    for (const key of ["navigation", "redirects"] as const) {
        if (candidate[key] === undefined) continue
        const resolved = resolveRefs(
            candidate[key],
            configFile.path.split("/").slice(0, -1).join("/"),
            [configFile.path],
        )
        candidate[key] = resolved === droppedRef ? undefined : resolved
    }

    // Normalize object-form OpenAPI refs to source strings and register their
    // authored directory. Configured entries preserve routes and specs that
    // filename-based discovery would miss.
    const openapiObjectRefSchema = z.object({
        source: z.string().min(1),
        directory: z.string().min(1).optional(),
    })
    const collectedSpecRefs: Array<{ source: string; directory?: string }> = []
    const rewriteOpenapiRefs = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(rewriteOpenapiRefs)
        const record = configObjectSchema.safeParse(value)
        if (!record.success) return value
        return Object.fromEntries(
            Object.entries(record.data).map(([key, entry]) => {
                if (key === "openapi") {
                    const ref = openapiObjectRefSchema.safeParse(entry)
                    if (ref.success) {
                        collectedSpecRefs.push(ref.data)
                        return [key, ref.data.source]
                    }
                }
                return [key, rewriteOpenapiRefs(entry)]
            }),
        )
    }
    if (candidate.navigation !== undefined) {
        candidate.navigation = rewriteOpenapiRefs(candidate.navigation)
    }
    const rawApi = configObjectSchema.safeParse(candidate.api)
    if (rawApi.success && rawApi.data.openapi !== undefined) {
        const apiRef = openapiObjectRefSchema.safeParse(rawApi.data.openapi)
        if (apiRef.success) {
            // The whole ref moves into the openapi[] entry — leaving the
            // source string on api.openapi as well would register the spec
            // twice under one derived id (a fatal duplicate-id violation).
            collectedSpecRefs.push(apiRef.data)
            candidate.api = Object.fromEntries(
                Object.entries(rawApi.data).filter(
                    ([key]) => key !== "openapi",
                ),
            )
        } else if (Array.isArray(rawApi.data.openapi)) {
            candidate.api = {
                ...rawApi.data,
                openapi: rawApi.data.openapi.filter((entry) => {
                    const ref = openapiObjectRefSchema.safeParse(entry)
                    if (!ref.success) return true
                    collectedSpecRefs.push(ref.data)
                    return false
                }),
            }
        }
    }
    if (collectedSpecRefs.length > 0) {
        const existingEntries = Array.isArray(candidate.openapi)
            ? candidate.openapi
            : []
        // Sources already registered elsewhere (legacy openapi[] entries by
        // spec path, api.openapi strings) must not be re-appended: two
        // entries deriving the same id is a fatal violation downstream.
        const registeredSources = new Set([
            ...existingEntries.flatMap((entry) => {
                if (typeof entry === "string") return [entry]
                const parsed = configObjectSchema.safeParse(entry)
                return parsed.success && typeof parsed.data.spec === "string"
                    ? [parsed.data.spec]
                    : []
            }),
            ...(typeof rawApi.data?.openapi === "string"
                ? [rawApi.data.openapi]
                : []),
            ...(Array.isArray(rawApi.data?.openapi)
                ? rawApi.data.openapi.filter(
                      (entry): entry is string => typeof entry === "string",
                  )
                : []),
        ])
        const slugify = (value: string): string =>
            value
                .replace(/\.(json|ya?ml)$/i, "")
                .replace(/\.(openapi|swagger)$/i, "")
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
        // Ids already claimed by authored entries — two entries deriving one
        // id is a fatal duplicate downstream, so same-basename refs from
        // different directories (v1/schema.yml + v2/schema.yml) must
        // disambiguate instead of colliding.
        const usedIds = new Set(
            existingEntries.flatMap((entry) => {
                if (typeof entry === "string")
                    return [slugify(entry.split("/").at(-1) ?? "") || "api"]
                const parsed = configObjectSchema.safeParse(entry)
                return parsed.success && typeof parsed.data.id === "string"
                    ? [parsed.data.id]
                    : []
            }),
        )
        const appendedEntries = [...existingEntries]
        for (const ref of collectedSpecRefs) {
            if (registeredSources.has(ref.source)) continue
            registeredSources.add(ref.source)
            // Same basename-slug derivation discoverOpenapiSpecs applies to
            // bare string entries ("openapi-public.yml" → "openapi-public");
            // collisions fall back to the full path slug, then a counter.
            let id =
                slugify(ref.source.split("/").at(-1) ?? "") ||
                slugify(ref.source) ||
                "api"
            if (usedIds.has(id)) id = slugify(ref.source) || "api"
            for (let n = 2; usedIds.has(id); n += 1)
                id = `${slugify(ref.source) || "api"}-${n}`
            usedIds.add(id)
            // The spec's directory is a URL segment path — normalize slashes
            // so "reference/api/" cannot persist pages under "reference/api//".
            const directory = ref.directory
                ?.replaceAll("\\", "/")
                .replace(/^\/+|\/+$/g, "")
            appendedEntries.push({
                id,
                spec: ref.source,
                ...(directory ? { path: directory } : {}),
            })
        }
        if (appendedEntries.length !== existingEntries.length)
            candidate.openapi = appendedEntries
    }

    const knownTopLevelKeys = new Set(
        Object.keys(docsConfigSupersetSchema.shape),
    )
    for (const key of Object.keys(candidate)) {
        if (!knownTopLevelKeys.has(key)) {
            diagnostics.push({
                code: "unknown_field",
                severity: "info",
                message: `Unknown config field "${key}" is ignored.`,
                path: configFile.path,
            })
        }
    }

    const rawConfigExtension = candidate[CONFIG_EXTENSION_KEY]
    const configExtensionObject =
        configObjectSchema.safeParse(rawConfigExtension)
    if (configExtensionObject.success) {
        const knownConfigExtensionKeys = new Set(
            Object.keys(configExtensionSchema.shape),
        )
        for (const key of Object.keys(configExtensionObject.data)) {
            if (!knownConfigExtensionKeys.has(key)) {
                diagnostics.push({
                    code: "unknown_field",
                    severity: "info",
                    message: `Unknown config field "${CONFIG_EXTENSION_KEY}.${key}" is ignored.`,
                    path: configFile.path,
                })
            }
        }
    }

    const rawRedirects = candidate.redirects
    if (Array.isArray(rawRedirects)) {
        candidate.redirects = rawRedirects.flatMap((redirect, index) => {
            const result = redirectSchema.safeParse(redirect)
            if (result.success) return [result.data]
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid config field "redirects.${index}"; the redirect was dropped.`,
                path: configFile.path,
            })
            return []
        })
    }

    const rawNavbar = configObjectSchema.safeParse(candidate.navbar)
    if (rawNavbar.success && "links" in rawNavbar.data) {
        const links = Array.isArray(rawNavbar.data.links)
            ? rawNavbar.data.links.flatMap((link, index) => {
                  const result = chromeLinkSchema.safeParse(link)
                  if (result.success && isAllowedUrl(result.data.href))
                      return [result.data]
                  diagnostics.push({
                      code: "field_invalid",
                      severity: "warn",
                      message: `Invalid config field "navbar.links.${index}"; the link was dropped.`,
                      path: configFile.path,
                  })
                  return []
              })
            : []
        if (!Array.isArray(rawNavbar.data.links))
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    'Invalid config field "navbar.links"; the links were dropped.',
                path: configFile.path,
            })
        candidate.navbar = { ...rawNavbar.data, links }
    }

    const rawFooter = configObjectSchema.safeParse(candidate.footer)
    if (rawFooter.success && "links" in rawFooter.data) {
        const columns = Array.isArray(rawFooter.data.links)
            ? rawFooter.data.links.flatMap((column, columnIndex) => {
                  const parsedColumn = footerColumnSchema.safeParse(column)
                  if (!parsedColumn.success) {
                      diagnostics.push({
                          code: "field_invalid",
                          severity: "warn",
                          message: `Invalid config field "footer.links.${columnIndex}"; the column was dropped.`,
                          path: configFile.path,
                      })
                      return []
                  }
                  const items = parsedColumn.data.items.flatMap(
                      (item, itemIndex) => {
                          const parsedItem = footerItemSchema.safeParse(item)
                          if (
                              parsedItem.success &&
                              isAllowedUrl(parsedItem.data.href)
                          )
                              return [parsedItem.data]
                          diagnostics.push({
                              code: "field_invalid",
                              severity: "warn",
                              message: `Invalid config field "footer.links.${columnIndex}.items.${itemIndex}"; the item was dropped.`,
                              path: configFile.path,
                          })
                          return []
                      },
                  )
                  return [{ ...parsedColumn.data, items }]
              })
            : []
        if (!Array.isArray(rawFooter.data.links))
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    'Invalid config field "footer.links"; the columns were dropped.',
                path: configFile.path,
            })
        candidate.footer = { ...rawFooter.data, links: columns }
    }

    const rawThumbnails = configObjectSchema.safeParse(candidate.thumbnails)
    if (
        rawThumbnails.success &&
        typeof rawThumbnails.data.image === "string" &&
        !isAllowedUrl(rawThumbnails.data.image)
    ) {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message:
                'Invalid config field "thumbnails.image"; the generated Open Graph image will be used.',
            path: configFile.path,
        })
        candidate.thumbnails = Object.fromEntries(
            Object.entries(rawThumbnails.data).filter(
                ([key]) => key !== "image",
            ),
        )
    }

    // SEO identity is optional, but each authored override is admitted on its
    // own. One malformed URL must not discard a valid title, language, or the
    // rest of the config extension (the generic top-level recovery would drop it all).
    if (configExtensionObject.success && "seo" in configExtensionObject.data) {
        const rawSeo = configObjectSchema.safeParse(
            configExtensionObject.data.seo,
        )
        const sanitizedSeo: Record<string, unknown> = {}
        if (!rawSeo.success) {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo"; using zero-config SEO defaults.`,
                path: configFile.path,
            })
        } else {
            for (const [key, schema] of [
                ["titleTemplate", docsSeoTitleTemplateSchema],
                ["language", docsLocaleTagSchema],
            ] satisfies Array<[string, z.ZodType]>) {
                if (!(key in rawSeo.data)) continue
                const parsedField = schema.safeParse(rawSeo.data[key])
                if (parsedField.success) {
                    sanitizedSeo[key] = parsedField.data
                } else {
                    diagnostics.push({
                        code: "field_invalid",
                        severity: "warn",
                        message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.${key}"; using the zero-config default.`,
                        path: configFile.path,
                    })
                }
            }

            if ("publisher" in rawSeo.data) {
                const rawPublisher = configObjectSchema.safeParse(
                    rawSeo.data.publisher,
                )
                if (rawPublisher.success) {
                    const publisher: Record<string, unknown> = {}
                    const allowedPublisherFields = new Set([
                        "type",
                        "name",
                        "url",
                        "logoUrl",
                        "sameAs",
                    ])
                    for (const [key, value] of Object.entries(
                        rawPublisher.data,
                    )) {
                        if (!allowedPublisherFields.has(key)) {
                            diagnostics.push({
                                code: "unknown_field",
                                severity: "info",
                                message: `Unknown config field "${CONFIG_EXTENSION_KEY}.seo.publisher.${key}" is ignored.`,
                                path: configFile.path,
                            })
                            continue
                        }
                        const parsedField = docsSeoPublisherSchema.safeParse({
                            [key]: value,
                        })
                        if (parsedField.success) {
                            Object.assign(publisher, parsedField.data)
                        } else {
                            diagnostics.push({
                                code: "field_invalid",
                                severity: "warn",
                                message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.publisher.${key}"; using the site identity default.`,
                                path: configFile.path,
                            })
                        }
                    }
                    if (Object.keys(publisher).length > 0)
                        sanitizedSeo.publisher = publisher
                } else {
                    diagnostics.push({
                        code: "field_invalid",
                        severity: "warn",
                        message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.publisher"; using the site identity default.`,
                        path: configFile.path,
                    })
                }
            }

            if ("provenance" in rawSeo.data) {
                const rawProvenance = configObjectSchema.safeParse(
                    rawSeo.data.provenance,
                )
                if (rawProvenance.success) {
                    let provenance: Record<string, unknown> = rawProvenance.data
                    if ("license" in provenance) {
                        const license = docsSeoProvenanceSchema.shape.license
                            .unwrap()
                            .safeParse(provenance.license)
                        if (!license.success) {
                            diagnostics.push({
                                code: "field_invalid",
                                severity: "warn",
                                message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.provenance.license"; the license was dropped.`,
                                path: configFile.path,
                            })
                            provenance = Object.fromEntries(
                                Object.entries(provenance).filter(
                                    ([key]) => key !== "license",
                                ),
                            )
                        }
                    }
                    const parsedProvenance =
                        docsSeoProvenanceSchema.safeParse(provenance)
                    if (parsedProvenance.success) {
                        sanitizedSeo.provenance = parsedProvenance.data
                    } else {
                        diagnostics.push({
                            code: "field_invalid",
                            severity: "warn",
                            message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.provenance"; no upstream relationship will be inferred.`,
                            path: configFile.path,
                        })
                    }
                } else {
                    diagnostics.push({
                        code: "field_invalid",
                        severity: "warn",
                        message: `Invalid config field "${CONFIG_EXTENSION_KEY}.seo.provenance"; no upstream relationship will be inferred.`,
                        path: configFile.path,
                    })
                }
            }

            for (const key of Object.keys(rawSeo.data)) {
                if (
                    ![
                        "titleTemplate",
                        "language",
                        "publisher",
                        "provenance",
                    ].includes(key)
                )
                    diagnostics.push({
                        code: "unknown_field",
                        severity: "info",
                        message: `Unknown config field "${CONFIG_EXTENSION_KEY}.seo.${key}" is ignored.`,
                        path: configFile.path,
                    })
            }
        }
        candidate[CONFIG_EXTENSION_KEY] = {
            ...configExtensionObject.data,
            seo: sanitizedSeo,
        }
    }

    // docs.json seo.organization is admitted per-field like the config-extension
    // publisher above: one malformed URL must not discard the tenant's
    // metatags/indexing (the generic top-level recovery drops all of `seo`).
    const rawRootSeo = configObjectSchema.safeParse(candidate.seo)
    if (rawRootSeo.success && "organization" in rawRootSeo.data) {
        const rawOrganization = configObjectSchema.safeParse(
            rawRootSeo.data.organization,
        )
        if (!rawOrganization.success) {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message:
                    'Invalid config field "seo.organization"; using the site identity default.',
                path: configFile.path,
            })
            candidate.seo = Object.fromEntries(
                Object.entries(rawRootSeo.data).filter(
                    ([key]) => key !== "organization",
                ),
            )
        } else {
            const organization: Record<string, unknown> = {}
            const knownOrganizationKeys = new Set(
                Object.keys(docsSeoOrganizationSchema.shape),
            )
            for (const [key, value] of Object.entries(rawOrganization.data)) {
                if (!knownOrganizationKeys.has(key)) {
                    diagnostics.push({
                        code: "unknown_field",
                        severity: "info",
                        message: `Unknown config field "seo.organization.${key}" is ignored.`,
                        path: configFile.path,
                    })
                    continue
                }
                const parsedField = docsSeoOrganizationSchema.safeParse({
                    [key]: value,
                })
                if (parsedField.success) {
                    Object.assign(organization, parsedField.data)
                } else {
                    diagnostics.push({
                        code: "field_invalid",
                        severity: "warn",
                        message: `Invalid config field "seo.organization.${key}"; using the site identity default.`,
                        path: configFile.path,
                    })
                }
            }
            candidate.seo = { ...rawRootSeo.data, organization }
        }
    }
    // Recover integrations and styling field by field so one malformed value
    // cannot discard valid siblings. Drop an invalid field, preserve unknown
    // keys, and keep a parent when only an optional child is invalid.
    type FieldValidator = {
        safeParse(value: unknown): { success: boolean }
    }
    type FieldShape = Record<string, FieldValidator | undefined>
    const recoverFields = (input: {
        shape: FieldShape
        nested?: Record<string, FieldShape | undefined>
        value: Record<string, unknown>
        path: string
    }): Record<string, unknown> => {
        const sanitized: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(input.value)) {
            const fieldPath = `${input.path}.${key}`
            const fieldSchema = input.shape[key]
            if (!fieldSchema || fieldSchema.safeParse(value).success) {
                sanitized[key] = value
                continue
            }
            const subShape = input.nested?.[key]
            const record = configObjectSchema.safeParse(value)
            if (subShape && record.success) {
                const recovered = recoverFields({
                    shape: subShape,
                    value: record.data,
                    path: fieldPath,
                })
                if (fieldSchema.safeParse(recovered).success) {
                    sanitized[key] = recovered
                    continue
                }
            }
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid config field "${fieldPath}"; using the default.`,
                path: configFile.path,
            })
        }
        return sanitized
    }
    const rawIntegrations = configObjectSchema.safeParse(candidate.integrations)
    if (rawIntegrations.success) {
        // Every provider field is `.optional()`-wrapped; the unwrapped
        // object shapes drive the one-level recursion (mixpanel.region).
        const providerShapes: Record<string, FieldShape | undefined> = {}
        for (const [key, schema] of Object.entries(integrationsSchema.shape)) {
            const inner = schema.unwrap()
            if (inner instanceof z.ZodObject) providerShapes[key] = inner.shape
        }
        candidate.integrations = recoverFields({
            shape: integrationsSchema.shape,
            nested: providerShapes,
            value: rawIntegrations.data,
            path: "integrations",
        })
    }
    const rawStyling = configObjectSchema.safeParse(candidate.styling)
    if (rawStyling.success) {
        const stylingShape =
            docsConfigSupersetSchema.shape.styling.unwrap().shape
        // codeblocks is a union (mode string | object); its object branch
        // gets nested recovery so a bad optional `languages` value keeps a
        // valid `theme` instead of dropping the whole codeblocks block.
        const codeblocksObject = stylingShape.codeblocks
            .unwrap()
            .options.find((branch) => branch instanceof z.ZodObject)
        candidate.styling = recoverFields({
            shape: stylingShape,
            nested: {
                codeblocks:
                    codeblocksObject instanceof z.ZodObject
                        ? codeblocksObject.shape
                        : undefined,
            },
            value: rawStyling.data,
            path: "styling",
        })
    }
    // variations is admitted on its own: a malformed value (options as a
    // string, an empty array, an option missing id/label) drops with a warn
    // while sibling config survives untouched, and the message names the
    // consequence — the generic recovery below would say less.
    if (
        candidate.variations !== undefined &&
        !docsVariationsSchema.safeParse(candidate.variations).success
    ) {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message:
                'Invalid config field "variations"; View selector groups fall back to per-group defaults.',
            path: configFile.path,
        })
        candidate = Object.fromEntries(
            Object.entries(candidate).filter(([key]) => key !== "variations"),
        )
    }
    // seo.trailingSlash is admitted on its own for the same reason: a
    // malformed value ('true' as a string) must not discard the sibling
    // indexing/metatags through the generic top-level recovery.
    const rawSeoAfterOrganization = configObjectSchema.safeParse(candidate.seo)
    if (
        rawSeoAfterOrganization.success &&
        "trailingSlash" in rawSeoAfterOrganization.data &&
        typeof rawSeoAfterOrganization.data.trailingSlash !== "boolean"
    ) {
        diagnostics.push({
            code: "field_invalid",
            severity: "warn",
            message:
                'Invalid config field "seo.trailingSlash"; using the default.',
            path: configFile.path,
        })
        candidate.seo = Object.fromEntries(
            Object.entries(rawSeoAfterOrganization.data).filter(
                ([key]) => key !== "trailingSlash",
            ),
        )
    }

    // Ingest-computed HAST slots are NEVER accepted from the author: a
    // docs.json carrying banner.contentHast / errors.404.descriptionHast
    // would otherwise flow to the serve-side HAST renderer without passing
    // the compiler chain's sanitization. Scrub them before the parse; the
    // compile step recomputes the real values.
    const rawBanner = configObjectSchema.safeParse(candidate.banner)
    if (rawBanner.success && "contentHast" in rawBanner.data) {
        diagnostics.push({
            code: "unknown_field",
            severity: "info",
            message:
                'Config field "banner.contentHast" is ingest-computed and was ignored.',
            path: configFile.path,
        })
        candidate.banner = Object.fromEntries(
            Object.entries(rawBanner.data).filter(
                ([key]) => key !== "contentHast",
            ),
        )
    }
    const rawErrors = configObjectSchema.safeParse(candidate.errors)
    if (rawErrors.success) {
        const sanitizedErrors: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(rawErrors.data)) {
            if (key !== "404") {
                // Closed schema: an unknown error key ("500") would strip
                // silently — surface it instead.
                diagnostics.push({
                    code: "unknown_field",
                    severity: "info",
                    message: `Unknown config field "errors.${key}" is ignored.`,
                    path: configFile.path,
                })
                continue
            }
            const rawNotFound = configObjectSchema.safeParse(value)
            if (!rawNotFound.success) {
                sanitizedErrors[key] = value
                continue
            }
            // Each field is admitted on its own: one 256-char title must not
            // discard a valid redirect/description sibling through the
            // generic top-level recovery (which would drop all of `errors`).
            const entries = Object.entries(rawNotFound.data).flatMap(
                ([field, fieldValue]): Array<[string, unknown]> => {
                    const fieldSchema =
                        field === "redirect" ||
                        field === "title" ||
                        field === "description"
                            ? docsNotFoundErrorSchema.shape[field]
                            : null
                    if (!fieldSchema) {
                        diagnostics.push({
                            code: "unknown_field",
                            severity: "info",
                            message:
                                field === "descriptionHast"
                                    ? 'Config field "errors.404.descriptionHast" is ingest-computed and was ignored.'
                                    : `Unknown config field "errors.404.${field}" is ignored.`,
                            path: configFile.path,
                        })
                        return []
                    }
                    if (!fieldSchema.safeParse(fieldValue).success) {
                        diagnostics.push({
                            code: "field_invalid",
                            severity: "warn",
                            message: `Invalid config field "errors.404.${field}"; using the default.`,
                            path: configFile.path,
                        })
                        return []
                    }
                    return [[field, fieldValue]]
                },
            )
            sanitizedErrors[key] = Object.fromEntries(entries)
        }
        candidate.errors = sanitizedErrors
    }

    // docs.json api.* console block: sanitized field-by-field so one bad
    // value warns and falls back to its default instead of dropping the
    // whole `api` object (which also carries the OpenAPI registrations).
    // Serving resolves the surviving raw values through docsApiConfigSchema.
    const rawApiConsole = configObjectSchema.safeParse(candidate.api)
    if (rawApiConsole.success) {
        const strictApiFieldSchemas = {
            playground: z.object({
                display: z
                    .enum(["interactive", "simple", "none", "auth"])
                    .optional(),
                proxy: z.boolean().optional(),
                credentials: z.boolean().optional(),
            }),
            examples: z.object({
                languages: z.array(z.string()).optional(),
                defaults: z.enum(["required", "all"]).optional(),
                autogenerate: z.boolean().optional(),
                prefill: z.boolean().optional(),
            }),
            params: z.object({
                expanded: z.enum(["all", "closed"]).optional(),
                post: z.array(z.string()).optional(),
            }),
        } as const
        const sanitizedApi: Record<string, unknown> = {
            ...rawApiConsole.data,
        }
        for (const key of ["playground", "examples", "params"] as const) {
            if (!(key in sanitizedApi)) continue
            const rawGroup = configObjectSchema.safeParse(sanitizedApi[key])
            if (!rawGroup.success) {
                diagnostics.push({
                    code: "field_invalid",
                    severity: "warn",
                    message: `Invalid config field "api.${key}"; using the defaults.`,
                    path: configFile.path,
                })
                delete sanitizedApi[key]
                continue
            }
            // Field-by-field like the config extension seo: one malformed value must
            // not take its valid siblings down, and unknown subkeys surface
            // instead of stripping silently.
            const groupShape = strictApiFieldSchemas[key].shape
            const sanitizedGroup: Record<string, unknown> = {}
            for (const [subkey, value] of Object.entries(rawGroup.data)) {
                if (!(subkey in groupShape)) {
                    diagnostics.push({
                        code: "unknown_field",
                        severity: "info",
                        message: `Unknown config field "api.${key}.${subkey}" is ignored.`,
                        path: configFile.path,
                    })
                    continue
                }
                const parsedField = strictApiFieldSchemas[key].safeParse({
                    [subkey]: value,
                })
                if (parsedField.success) {
                    Object.assign(sanitizedGroup, parsedField.data)
                } else {
                    diagnostics.push({
                        code: "field_invalid",
                        severity: "warn",
                        message: `Invalid config field "api.${key}.${subkey}"; using the default.`,
                        path: configFile.path,
                    })
                }
            }
            sanitizedApi[key] = sanitizedGroup
        }
        const display = strictApiFieldSchemas.playground.safeParse(
            sanitizedApi.playground,
        )
        if (display.success && display.data.display === "auth") {
            diagnostics.push({
                code: "unsupported_field",
                severity: "info",
                message:
                    'api.playground.display "auth" behaves as "none": docs visitors have no auth concept, so every visitor is unauthenticated.',
                path: configFile.path,
            })
        }
        // docs.json semantics: credentials only apply to browser-DIRECT
        // playground requests; the proxy (default on) strips them — cookies
        // never ride a cross-origin proxied call.
        if (
            display.success &&
            display.data.credentials === true &&
            display.data.proxy !== false
        ) {
            diagnostics.push({
                code: "unsupported_field",
                severity: "info",
                message:
                    "api.playground.credentials has no effect while the playground proxy is enabled; requests only carry cookies when proxy is false.",
                path: configFile.path,
            })
        }
        const examplesGroup = strictApiFieldSchemas.examples.safeParse(
            sanitizedApi.examples,
        )
        // prefill:true is inherent (the fumadocs playground always seeds
        // fields from the selected example); only the false direction is
        // unimplementable without forking the playground internals.
        if (examplesGroup.success && examplesGroup.data.prefill === false) {
            diagnostics.push({
                code: "unsupported_field",
                severity: "warn",
                message:
                    "api.examples.prefill false is not supported: the playground always prefills fields from the selected example.",
                path: configFile.path,
            })
        }
        const paramsGroup = strictApiFieldSchemas.params.safeParse(
            sanitizedApi.params,
        )
        if (paramsGroup.success && paramsGroup.data.post !== undefined) {
            diagnostics.push({
                code: "unsupported_field",
                severity: "warn",
                message:
                    'Config field "api.params.post" is not supported yet and has no effect.',
                path: configFile.path,
            })
        }
        candidate.api = sanitizedApi
    }

    const sanitizedCandidate = sanitizeConfigHrefs({
        value: candidate,
        path: "",
        configPath: configFile.path,
        diagnostics,
    })
    candidate = configObjectSchema.parse(sanitizedCandidate)

    let configResult = docsConfigSupersetSchema.safeParse(candidate)
    while (!configResult.success) {
        const invalidKey = configResult.error.issues.find(
            (issue) => typeof issue.path[0] === "string",
        )?.path[0]

        if (typeof invalidKey !== "string") {
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: "Invalid config root; using defaults.",
                path: configFile.path,
            })
            candidate = {}
        } else {
            const issues = configResult.error.issues.filter(
                (issue) => issue.path[0] === invalidKey,
            )
            diagnostics.push({
                code: "field_invalid",
                severity: "warn",
                message: `Invalid config field "${invalidKey}" (${issues
                    .map((issue) =>
                        issue.path.length > 0
                            ? issue.path.join(".")
                            : invalidKey,
                    )
                    .join(", ")}); using the default.`,
                path: configFile.path,
            })
            candidate = Object.fromEntries(
                Object.entries(candidate).filter(([key]) => key !== invalidKey),
            )
        }
        configResult = docsConfigSupersetSchema.safeParse(candidate)
    }

    // ── Parsed-but-inert docs.json fields ─────────────────────────────────
    // The superset schema accepts these so authored configs round-trip, but
    // nothing consumes them yet. Each authored use warns so tenants see the
    // gap instead of a silently dead knob; entries leave this list as the
    // framework wires them up.
    const unsupportedField = (fieldPath: string) => {
        diagnostics.push({
            code: "unsupported_field",
            severity: "warn",
            message: `Config field "${fieldPath}" is not supported yet and has no effect.`,
            path: configFile.path,
        })
    }
    const resolved = configResult.data
    if (resolved.public !== undefined) unsupportedField("public")
    for (const key of ["mdx", "asyncapi"] as const) {
        if (resolved.api?.[key] !== undefined) unsupportedField(`api.${key}`)
    }
    // Navigation sources beyond OpenAPI (graphql/asyncapi node keys) parse
    // into the stored nav but generate nothing — one warn per key kind. `sdk`
    // left this list: typedoc artifacts generate pages (sdk.ts), and the
    // other sdk formats get their per-format diagnostics there too.
    const unsupportedNavKeys = new Set<string>()
    const navSweepStack: unknown[] = [resolved.navigation]
    while (navSweepStack.length > 0) {
        const node = navSweepStack.pop()
        if (Array.isArray(node)) {
            navSweepStack.push(...node)
            continue
        }
        const record = configObjectSchema.safeParse(node)
        if (!record.success) continue
        for (const key of ["graphql", "asyncapi"]) {
            if (record.data[key] !== undefined) unsupportedNavKeys.add(key)
        }
        navSweepStack.push(...Object.values(record.data))
    }
    for (const key of [...unsupportedNavKeys].sort()) {
        unsupportedField(`navigation.*.${key}`)
    }

    const navigation = configResult.data.navigation
    const navigationHasContent =
        navigation !== undefined &&
        Object.values(navigation).some((value) =>
            Array.isArray(value)
                ? value.length > 0
                : typeof value === "object" && value !== null
                  ? Object.keys(value).length > 0
                  : value !== undefined,
        )
    return {
        config: configResult.data,
        diagnostics,
        navSource: navigationHasContent ? "config" : "filesystem",
        fatal: null,
    }
}
