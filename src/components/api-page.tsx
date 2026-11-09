"use client"

import { createCodeUsageGeneratorRegistry } from "fumadocs-openapi/requests/generators"
import { registerDefault } from "fumadocs-openapi/requests/generators/all"
import type { OpenAPIPageProps_Spec } from "fumadocs-openapi/ui"
import { createOpenAPIPage } from "fumadocs-openapi/ui"
import { Heading } from "fumadocs-ui/components/heading"
import {
    Children,
    type ComponentProps,
    cloneElement,
    isValidElement,
    type ReactNode,
    use,
    useEffect,
    useMemo,
    useRef,
} from "react"
import {
    array,
    boolean,
    custom,
    looseObject,
    object,
    optional,
    record,
    string,
    unknown,
} from "zod/mini"
import { useApiPlayground } from "@/components/api-playground-state"
import { useChromeStrings } from "@/lib/chrome-strings"
import type { DocsApiConfig } from "@/types/docs"

/**
 * Serialized console behavior crossing the loader boundary — the resolved
 * docs.json api.* block (docs.ts resolveDocsApiConfig) plus nothing else.
 * "auth" behaves as "none": there is no docs-visitor auth concept, so every
 * visitor is unauthenticated (ingest emits the diagnostic naming this).
 */
export interface ApiConsoleConfig {
    display: DocsApiConfig["playground"]["display"]
    credentials: boolean
    examples: DocsApiConfig["examples"]
    paramsExpanded: "all" | "closed"
}

/**
 * Composes fumadocs-openapi operation slots into an API console.
 * The endpoint bar and the console share open-state, and generated samples
 * add auth headers because fumadocs does not derive them from OpenAPI
 * `security`. The docs route lazy-loads this client UI so MDX-only sites do
 * not download the OpenAPI bundle.
 */
function TryIt(props: {
    /** "METHOD /path" — the endpoint bar opens this operation's console. */
    endpoint: { method: string; path: string } | null
    playground: ReactNode
}) {
    const shared = useApiPlayground()
    const strings = useChromeStrings()
    const host = useRef<HTMLDivElement>(null)
    const ownTrigger = useRef<HTMLButtonElement>(null)
    // Only the operation named in the endpoint bar follows the bar; any
    // other operation on a composed page gets its own rail trigger.
    const barControlled =
        shared?.endpoint != null &&
        props.endpoint != null &&
        shared.endpoint.path === props.endpoint.path &&
        shared.endpoint.method.toLowerCase() ===
            props.endpoint.method.toLowerCase()
    const open = barControlled ? shared.open : false
    const setSharedOpen = barControlled ? shared.setOpen : null
    // fumadocs-openapi 12.3's playground slot is its own console: an
    // endpoint bar whose "Try in Playground" trigger opens a modal holding
    // the request form, Send and the response. The page already shows that
    // bar under the H1 (routes/$.tsx), so the slot renders hidden and the
    // framework's Try-it opens fumadocs' modal through its trigger — one
    // click to the form, never a modal inside a modal. Its open state is
    // internal, so the trigger's aria-expanded is the only signal of it.
    useEffect(() => {
        const trigger = host.current?.querySelector<HTMLButtonElement>(
            'button[aria-haspopup="dialog"]',
        )
        if (!trigger) return
        if (open && trigger.getAttribute("aria-expanded") !== "true")
            trigger.click()
        const observer = new MutationObserver(() => {
            const expanded = trigger.getAttribute("aria-expanded") === "true"
            const popup = document.getElementById(
                trigger.getAttribute("aria-controls") ?? "",
            )
            // Stable hook for the open console (tests, CSS).
            popup?.setAttribute("data-api-playground", "")
            if (expanded) return
            setSharedOpen?.(false)
            // The hidden trigger cannot take focus back: return it to the
            // visible button that opened the console.
            const opener = barControlled
                ? document.querySelector<HTMLElement>("[data-endpoint-try-it]")
                : ownTrigger.current
            if (opener && !opener.contains(document.activeElement))
                opener.focus()
        })
        observer.observe(trigger, {
            attributes: true,
            attributeFilter: ["aria-expanded"],
        })
        return () => observer.disconnect()
    }, [open, setSharedOpen, barControlled])
    return (
        <>
            {barControlled ? null : (
                <button
                    ref={ownTrigger}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() =>
                        host.current
                            ?.querySelector<HTMLButtonElement>(
                                'button[aria-haspopup="dialog"]',
                            )
                            ?.click()
                    }
                    className="inline-flex h-8 w-fit items-center gap-1.5 rounded-lg bg-fd-primary/10 px-3 font-medium text-fd-primary text-sm transition-colors hover:bg-fd-primary/20"
                >
                    {strings.tryIt}
                    <span aria-hidden className="text-[0.65rem]">
                        ▶
                    </span>
                </button>
            )}
            <div ref={host} hidden>
                {props.playground}
            </div>
        </>
    )
}

const operationContextSchema = object({
    path: optional(string()),
    method: optional(string()),
    operation: object({
        summary: optional(string()),
        deprecated: optional(boolean()),
        responses: optional(record(string(), unknown())),
        "x-codeSamples": optional(array(unknown())),
    }),
})

/**
 * docs.json api.params.expanded "all": fumadocs-openapi has no expand-all
 * option and its schema collapsibles are Radix state — this wrapper clicks
 * every closed trigger inside it as content mounts (bounded observer), and
 * is deliberately the ONLY place that knows about that DOM so upgrades
 * break one component, not the layout.
 */
function ExpandAllSections(props: { children: ReactNode }) {
    const rootRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const root = rootRef.current
        if (!root) return
        const expand = () => {
            for (const trigger of root.querySelectorAll(
                'button[aria-expanded="false"][data-state="closed"]',
            )) {
                if (trigger instanceof HTMLElement) trigger.click()
            }
        }
        expand()
        const observer = new MutationObserver(expand)
        observer.observe(root, { childList: true, subtree: true })
        const timer = window.setTimeout(() => observer.disconnect(), 2000)
        return () => {
            observer.disconnect()
            window.clearTimeout(timer)
        }
    }, [])
    return <div ref={rootRef}>{props.children}</div>
}

export function consoleOptions(
    console: ApiConsoleConfig,
    /** No proxy configured — playground requests go browser-direct. */
    direct: boolean,
    codeUsages?: ReturnType<typeof createCodeUsageGeneratorRegistry>,
) {
    const playgroundEnabled = console.display === "interactive"
    // An explicitly-passed EMPTY registry (autogenerate:false) means no
    // generated request samples; absent means fumadocs registers defaults.
    const registryHasGenerators =
        codeUsages === undefined || codeUsages.map().size > 0
    // Playground presence and the examples rail are SEPARATE knobs
    // (deployment-standard: api.examples control the rail): every display
    // mode keeps the generated/authored examples column — "simple", "none",
    // and "auth" (≡ none here, see ApiConsoleConfig) differ from
    // "interactive" only by dropping the Try-it console.
    return {
        playground: {
            enabled: playgroundEnabled,
            ...(console.credentials && direct
                ? {
                      // docs.json api.playground.credentials: browser-DIRECT
                      // requests carry cookies (proxy-less same-site APIs).
                      // With the proxy on, cookies would ride to the proxy
                      // origin instead of the API — never attach them there
                      // (ingest diagnoses the proxy+credentials combination).
                      fetchOptions: {
                          onRequestInit: (init: RequestInit): RequestInit => ({
                              ...init,
                              credentials: "include",
                          }),
                      },
                  }
                : {}),
        },
        ...(codeUsages ? { codeUsages } : {}),
        components: {
            // Outline depth: ingest hides the operation title, so the
            // page's H1 is the only heading above fumadocs-openapi's
            // sections — Authorization/Parameters/Body/Responses stay H2
            // (ruled section headings, api-console CSS), and
            // nested schema headings follow one level down.
            // biome-ignore lint/correctness/noComponentHookFactories: the page memoizes these options per console config, so Heading keeps its identity across renders.
            Heading: ({
                depth,
                ...heading
            }: ComponentProps<"h1"> & { id: string; depth: number }) => {
                const as =
                    depth <= 2
                        ? "h2"
                        : depth === 3
                          ? "h3"
                          : depth === 4
                            ? "h4"
                            : "h5"
                return <Heading as={as} {...heading} />
            },
        },
        content: {
            // Example rail: the request sample in one card whose
            // header carries the variant selector, the response sample in a
            // second card — fumadocs stacks bare tab groups.
            renderAPIExampleLayout: (slots: {
                selector: ReactNode
                usageTabs: ReactNode
                responseTabs: ReactNode
            }) => (
                <div className="api-example-rail flex flex-col gap-4">
                    <div className="api-example-card overflow-hidden rounded-xl border bg-fd-card">
                        {slots.selector ? (
                            <div className="flex items-center justify-end gap-2 border-b px-3 py-2">
                                {slots.selector}
                            </div>
                        ) : null}
                        {slots.usageTabs}
                    </div>
                    {slots.responseTabs ? (
                        <div className="api-example-card overflow-hidden rounded-xl border bg-fd-card">
                            {slots.responseTabs}
                        </div>
                    ) : null}
                </div>
            ),
            renderOperationLayout: (
                slots: {
                    header: ReactNode
                    description: ReactNode
                    apiExample: ReactNode
                    apiPlayground: ReactNode
                    authSchemes: ReactNode
                    parameters: ReactNode
                    body: ReactNode
                    responses: ReactNode
                    callbacks: ReactNode
                },
                context: unknown,
            ) => {
                const parsed = operationContextSchema.safeParse(context)
                const statuses = parsed.success
                    ? Object.keys(parsed.data.operation.responses ?? {})
                    : []
                // Default-open the success response accordion (2xx schema
                // docs render inline; fumadocs collapses every status). slots.responses is a Fragment of [Heading,
                // <Accordions type="multiple">…] — the Accordions wrapper
                // accepts a defaultValue fumadocs never sets, so a shallow
                // guarded clone adds it; unrecognized shapes pass through.
                const success = statuses.find((status) => /^2/.test(status))
                let responses = slots.responses
                if (
                    success &&
                    isValidElement<{ children?: ReactNode }>(responses) &&
                    responses.props.children !== null &&
                    responses.props.children !== undefined
                ) {
                    responses = Children.map(
                        responses.props.children,
                        (child) =>
                            isValidElement<{
                                type?: string
                                defaultValue?: string[]
                            }>(child) && child.props.type === "multiple"
                                ? cloneElement(child, {
                                      defaultValue: [success],
                                  })
                                : child,
                    )
                }
                const parameters =
                    console.paramsExpanded === "all" ? (
                        <ExpandAllSections>
                            {slots.parameters}
                            {slots.body}
                        </ExpandAllSections>
                    ) : (
                        <>
                            {slots.parameters}
                            {slots.body}
                        </>
                    )
                // Collapse the rail only when there is no playground, request
                // sample, authored x-codeSample, or response tab to display.
                // Keep the two-column layout for unrecognized contexts.
                const railHasContent =
                    playgroundEnabled ||
                    registryHasGenerators ||
                    !parsed.success ||
                    (parsed.data.operation["x-codeSamples"]?.length ?? 0) > 0 ||
                    statuses.length > 0
                const centerColumn = (
                    <div className="flex min-w-0 flex-col gap-6">
                        {slots.description}
                        {slots.authSchemes}
                        {parameters}
                        {responses}
                        {slots.callbacks}
                    </div>
                )
                return (
                    <div className="api-console flex flex-col gap-6">
                        {/* No header row: normal operations get a null
                            header slot (ingest sets showTitle false), and
                            deprecated ones only an empty warn callout — the
                            method/path/deprecated chrome renders in the
                            endpoint bar under the H1 (routes/$.tsx). */}
                        {railHasContent ? (
                            <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
                                {centerColumn}
                                <div className="flex flex-col gap-4 xl:sticky xl:top-[calc(var(--fd-banner-height,0px)+7rem)]">
                                    {slots.apiExample}
                                    {playgroundEnabled &&
                                    slots.apiPlayground ? (
                                        <TryIt
                                            endpoint={
                                                parsed.success &&
                                                parsed.data.path &&
                                                parsed.data.method
                                                    ? {
                                                          method: parsed.data
                                                              .method,
                                                          path: parsed.data
                                                              .path,
                                                      }
                                                    : null
                                            }
                                            playground={slots.apiPlayground}
                                        />
                                    ) : null}
                                </div>
                            </div>
                        ) : (
                            centerColumn
                        )}
                    </div>
                )
            },
        },
    }
}

// ── Auth headers for generated code samples ──────────────────────────────────

const securitySchemeSchema = object({
    type: string(),
    name: optional(string()),
    in: optional(string()),
    scheme: optional(string()),
})
const securityRequirementsSchema = array(record(string(), unknown()))
// Level-by-level probing, never one strict whole-document parse: path items
// carry non-operation keys (`parameters: [...]` arrays) that would fail a
// nested object schema and silently zero out auth for the whole spec
// Otherwise a rendered example can silently lose its Bearer header.
const documentSecuritySchema = object({
    security: optional(securityRequirementsSchema),
    components: optional(
        object({
            securitySchemes: optional(record(string(), unknown())),
        }),
    ),
    // Values stay unknown: a Paths Object may carry primitive specification
    // extensions ("x-internal": true); rejecting those would erase auth
    // for the entire document.
    // Only the selected path item is parsed, below.
    paths: optional(record(string(), unknown())),
    // Webhooks are named path items — same probing rules as `paths`.
    webhooks: optional(record(string(), unknown())),
})

/**
 * One rendered request target, normalized for security/parameter probing:
 * operations live at `paths[path][method]`, webhooks at
 * `webhooks[name][method]` (a webhook is a named Path Item Object).
 */
export type SelectedRequest = { method: string } & (
    | { path: string }
    | { webhook: string }
)
const operationSecuritySchema = object({
    security: optional(securityRequirementsSchema),
})

/**
 * Placeholder auth headers for the operation's FIRST security requirement,
 * (`X-API-Key: <api-key>`, `Authorization: Bearer <token>`).
 * fumadocs' sample builder reads OpenAPI `parameters` only, never
 * `security` — without this every copied request fails auth.
 */
/**
 * Follow ONE local JSON pointer ("#/components/pathItems/…") — bundled
 * documents keep path-item $refs that ingest supports (derefPathItem in
 * docs-ingest/openapi.ts), and reading security through the raw node would
 * miss the referenced operation. Non-local/unresolvable refs
 * return the node unchanged.
 */
function followLocalRef(doc: unknown, node: unknown): unknown {
    const ref = object({ $ref: string() }).safeParse(node)
    if (!ref.success || !ref.data.$ref.startsWith("#/")) return node
    let current: unknown = doc
    for (const segment of ref.data.$ref.slice(2).split("/")) {
        const entry = record(string(), unknown()).safeParse(current)
        if (!entry.success) return node
        current =
            entry.data[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
    }
    return current ?? node
}

/**
 * followLocalRef + OpenAPI sibling semantics: fields authored NEXT TO a
 * local $ref override the referenced target (parameters, security, an
 * operation override on a shared webhook). Used by both derivations and
 * mirrored by the endpoint bar in routes/$.tsx.
 */
function followLocalRefMerging(doc: unknown, node: unknown): unknown {
    const parsed = record(string(), unknown()).safeParse(node)
    if (!parsed.success || typeof parsed.data.$ref !== "string")
        return followLocalRef(doc, node)
    const resolved = record(string(), unknown()).safeParse(
        followLocalRef(doc, node),
    )
    if (!resolved.success) return followLocalRef(doc, node)
    const { $ref: _ref, ...siblings } = parsed.data
    return { ...resolved.data, ...siblings }
}

export interface DerivedAuth {
    header: Record<string, { value: string }>
    cookie: Record<string, { value: string }>
    query: Record<string, { values: string[] }>
}

export function deriveAuthHeaders(
    bundled: unknown,
    selected: SelectedRequest[] | undefined,
): DerivedAuth {
    const auth: DerivedAuth = { header: {}, cookie: {}, query: {} }
    const target = selected?.[0]
    const parsed = documentSecuritySchema.safeParse(bundled)
    if (!target || !parsed.success) return auth
    const doc = parsed.data
    const pathItem = record(string(), unknown()).safeParse(
        followLocalRefMerging(
            bundled,
            // Webhooks are named Path Item Objects under `webhooks`.
            "webhook" in target
                ? doc.webhooks?.[target.webhook]
                : doc.paths?.[target.path],
        ),
    )
    const operationSpec = operationSecuritySchema.safeParse(
        pathItem.success
            ? followLocalRefMerging(
                  bundled,
                  pathItem.data[target.method.toLowerCase()],
              )
            : undefined,
    )
    const requirements =
        (operationSpec.success ? operationSpec.data.security : undefined) ??
        doc.security ??
        []
    const schemes = doc.components?.securitySchemes ?? {}
    for (const name of Object.keys(requirements[0] ?? {})) {
        // A requirement may name a scheme stored as a local Reference
        // Object — dereference before parsing.
        const schemeParsed = securitySchemeSchema.safeParse(
            followLocalRef(bundled, schemes[name]),
        )
        if (!schemeParsed.success) continue
        const scheme = schemeParsed.data
        // HTTP auth scheme names are case-insensitive (RFC 9110) — specs
        // legitimately spell "Bearer"/"Basic".
        const httpScheme = scheme.scheme?.toLowerCase()
        if (scheme.type === "apiKey" && scheme.name) {
            // apiKey placement is part of the scheme contract: header,
            // query, or cookie.
            if (scheme.in === "header")
                auth.header[scheme.name] = { value: "<api-key>" }
            else if (scheme.in === "query")
                auth.query[scheme.name] = { values: ["<api-key>"] }
            else if (scheme.in === "cookie")
                auth.cookie[scheme.name] = { value: "<api-key>" }
        } else if (scheme.type === "http" && httpScheme === "basic")
            auth.header.Authorization = { value: "Basic <credentials>" }
        else if (
            (scheme.type === "http" && httpScheme === "bearer") ||
            scheme.type === "oauth2" ||
            scheme.type === "openIdConnect"
        )
            auth.header.Authorization = { value: "Bearer <token>" }
    }
    return auth
}

/**
 * Required parameter names (by location) and required top-level JSON body
 * properties for the operation — docs.json examples.defaults "required"
 * omits everything else from generated snippets. Null body set = leave the
 * body untouched (non-object schemas, non-JSON media, no requestBody).
 */
export function deriveRequiredParams(
    bundled: unknown,
    selected: SelectedRequest[] | undefined,
): {
    query: Set<string>
    header: Set<string>
    cookie: Set<string>
    body: Set<string> | null
    omitBody: boolean
} {
    const empty = {
        query: new Set<string>(),
        header: new Set<string>(),
        cookie: new Set<string>(),
        body: null,
        omitBody: false,
    }
    const target = selected?.[0]
    const doc = documentSecuritySchema.safeParse(bundled)
    if (!target || !doc.success) return empty
    const recordOf = (value: unknown) =>
        record(string(), unknown()).safeParse(value)
    const pathItem = recordOf(
        followLocalRefMerging(
            bundled,
            "webhook" in target
                ? doc.data.webhooks?.[target.webhook]
                : doc.data.paths?.[target.path],
        ),
    )
    if (!pathItem.success) return empty
    const operationSpec = recordOf(
        followLocalRefMerging(
            bundled,
            pathItem.data[target.method.toLowerCase()],
        ),
    )
    const parameterSchema = object({
        name: string(),
        in: string(),
        required: optional(boolean()),
    })
    const result: {
        query: Set<string>
        header: Set<string>
        cookie: Set<string>
        body: Set<string> | null
        /** Optional requestBody (OpenAPI default): omit the body entirely. */
        omitBody: boolean
    } = {
        query: new Set(),
        header: new Set(),
        cookie: new Set(),
        body: null,
        omitBody: false,
    }
    const parameterLists = [
        pathItem.data.parameters,
        operationSpec.success ? operationSpec.data.parameters : undefined,
    ]
    // OpenAPI: an operation-level parameter with the same (name, in)
    // OVERRIDES the path-item one — a nested Map (location, then name) keys
    // the merge collision-free, so a path-level required:true never survives
    // an operation-level optional override.
    const parameterByLocation = new Map<
        string,
        Map<string, { name: string; in: string; required: boolean }>
    >()
    for (const list of parameterLists) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
            const parameter = parameterSchema.safeParse(
                followLocalRef(bundled, entry),
            )
            if (!parameter.success) continue
            const byName =
                parameterByLocation.get(parameter.data.in) ??
                new Map<
                    string,
                    { name: string; in: string; required: boolean }
                >()
            byName.set(parameter.data.name, {
                name: parameter.data.name,
                in: parameter.data.in,
                required: parameter.data.required === true,
            })
            parameterByLocation.set(parameter.data.in, byName)
        }
    }
    for (const byName of parameterByLocation.values()) {
        for (const parameter of byName.values()) {
            if (!parameter.required) continue
            if (parameter.in === "query") result.query.add(parameter.name)
            else if (parameter.in === "header")
                result.header.add(parameter.name)
            else if (parameter.in === "cookie")
                result.cookie.add(parameter.name)
        }
    }
    if (operationSpec.success) {
        const requestBody = recordOf(
            followLocalRef(bundled, operationSpec.data.requestBody),
        )
        // requestBody.required defaults to FALSE in OpenAPI — an optional
        // body leaves generated required-only snippets entirely.
        if (
            requestBody.success &&
            operationSpec.data.requestBody !== undefined &&
            requestBody.data.required !== true
        )
            result.omitBody = true
        const content = requestBody.success
            ? recordOf(requestBody.data.content)
            : null
        const jsonMedia = content?.success
            ? recordOf(
                  Object.entries(content.data).find(([key]) =>
                      key.includes("json"),
                  )?.[1],
              )
            : null
        const bodySchema = jsonMedia?.success
            ? recordOf(followLocalRef(bundled, jsonMedia.data.schema))
            : null
        const requiredList = array(string()).safeParse(
            bodySchema?.success ? bodySchema.data.required : null,
        )
        if (requiredList.success) {
            result.body = new Set(requiredList.data)
        } else if (
            bodySchema?.success &&
            (bodySchema.data.type === "object" ||
                bodySchema.data.properties !== undefined)
        ) {
            // An OBJECT schema with no schema-level `required` array means
            // nothing is required — the required-only sample is {}. Only
            // non-object shapes (compositions, arrays, primitives) keep the
            // generated body, where property-filtering has no meaning.
            result.body = new Set()
        }
    }
    return result
}

type BundledDocument = OpenAPIPageProps_Spec["payload"]["bundled"]

// Root-shape check only — ingest validated the document; fumadocs reads the
// rest defensively.
const bundledDocumentSchema = custom<BundledDocument>(
    (value) => looseObject({ openapi: string() }).safeParse(value).success,
)

/**
 * Specs fetched once per tab, keyed by /api/spec URL: every operation page of
 * one spec shares a single request (and the CDN entry behind it). A failed
 * fetch is evicted so the next render retries.
 */
const specs = new Map<string, Promise<BundledDocument>>()

export default function OpenApiBody(
    props: Omit<OpenAPIPageProps_Spec, "payload"> & {
        specUrl: string
        proxyUrl: string | undefined
        console: ApiConsoleConfig
    },
) {
    const {
        console: consoleConfig,
        specUrl,
        proxyUrl,
        ...generatedProps
    } = props
    let spec = specs.get(specUrl)
    if (!spec) {
        spec = fetch(specUrl).then(async (response) => {
            if (!response.ok)
                throw new Error(`spec fetch failed: ${response.status}`)
            return bundledDocumentSchema.parse(await response.json())
        })
        spec.catch(() => specs.delete(specUrl))
        specs.set(specUrl, spec)
    }
    // Suspends inside the route's <ClientOnly><Suspense> skeleton.
    const bundled = use(spec)
    const pageProps: OpenAPIPageProps_Spec = {
        ...generatedProps,
        payload: { bundled, proxyUrl },
    }
    const operations = props.operations
    const webhooks = props.webhooks
    // No proxy → the playground fetches browser-direct, where the
    // api.playground.credentials semantics apply (consoleOptions).
    const direct = proxyUrl === undefined
    // Memo on the loader-stable field identities, NOT the spread object —
    // rebuilding createOpenAPIPage remounts the console and would discard
    // playground state on every parent re-render.
    const OpenAPIPage = useMemo(() => {
        // Operations and webhooks share the derivation pipeline: webhook
        // pages get the same security-derived sample auth and required-only
        // example filtering (a webhook is a named Path Item Object).
        const selected: SelectedRequest[] = [
            ...(operations ?? []),
            ...(webhooks ?? []).map((hook) => ({
                webhook: hook.name,
                method: hook.method,
            })),
        ]
        const auth = deriveAuthHeaders(bundled, selected)
        const hasAuth =
            Object.keys(auth.header).length > 0 ||
            Object.keys(auth.cookie).length > 0 ||
            Object.keys(auth.query).length > 0
        const required =
            consoleConfig.examples.defaults === "required"
                ? deriveRequiredParams(bundled, selected)
                : null
        const languages = consoleConfig.examples.languages
        if (!consoleConfig.examples.autogenerate) {
            // autogenerate:false — an EMPTY registry; authored x-codeSamples
            // still render (fumadocs adds them independently).
            return createOpenAPIPage(
                consoleOptions(
                    consoleConfig,
                    direct,
                    createCodeUsageGeneratorRegistry(),
                ),
            )
        }
        if (!hasAuth && required === null && !languages?.length)
            return createOpenAPIPage(consoleOptions(consoleConfig, direct))
        // Add credentials to each generated sample at the declared location.
        // The security-derived placeholder overrides same-name parameters;
        // remove authored Authorization variants first because header names
        // are case-insensitive. Inject after defaults drop optional fields.
        const authHeaderKeys = new Set(
            Object.keys(auth.header).map((key) => key.toLowerCase()),
        )
        const registry = createCodeUsageGeneratorRegistry()
        const defaults = registerDefault(
            createCodeUsageGeneratorRegistry(),
        ).map()
        // docs.json language names → fumadocs generator ids.
        const LANGUAGE_ALIASES: Record<string, string> = {
            javascript: "js",
            typescript: "ts",
            node: "js",
            shell: "curl",
            bash: "curl",
        }
        const ids = languages?.length
            ? [
                  ...new Set(
                      languages.map(
                          (id) => LANGUAGE_ALIASES[id.toLowerCase()] ?? id,
                      ),
                  ),
              ].filter((id) => defaults.has(id))
            : [...defaults.keys()]
        for (const id of ids) {
            const generator = defaults.get(id)
            if (!generator) continue
            registry.add(id, {
                ...generator,
                generate: (data, context) => {
                    const requiredOnly = required
                        ? {
                              ...data,
                              query: Object.fromEntries(
                                  Object.entries(data.query).filter(([key]) =>
                                      required.query.has(key),
                                  ),
                              ),
                              header: Object.fromEntries(
                                  Object.entries(data.header).filter(([key]) =>
                                      required.header.has(key),
                                  ),
                              ),
                              cookie: Object.fromEntries(
                                  Object.entries(data.cookie).filter(([key]) =>
                                      required.cookie.has(key),
                                  ),
                              ),
                              body: (() => {
                                  if (required.omitBody) return undefined
                                  const body = record(
                                      string(),
                                      unknown(),
                                  ).safeParse(data.body)
                                  if (!required.body || !body.success)
                                      return data.body
                                  return Object.fromEntries(
                                      Object.entries(body.data).filter(
                                          ([key]) => required.body?.has(key),
                                      ),
                                  )
                              })(),
                          }
                        : data
                    return generator.generate(
                        // nosemgrep: javascript.express.security.express-wkhtml-injection.express-wkhtmltoimage-injection -- fumadocs-openapi code-sample generator building snippet text in the browser; no wkhtmltoimage, no express request
                        {
                            ...requiredOnly,
                            header: {
                                ...Object.fromEntries(
                                    Object.entries(requiredOnly.header).filter(
                                        ([key]) =>
                                            !authHeaderKeys.has(
                                                key.toLowerCase(),
                                            ),
                                    ),
                                ),
                                ...auth.header,
                            },
                            cookie: {
                                ...requiredOnly.cookie,
                                ...auth.cookie,
                            },
                            query: { ...requiredOnly.query, ...auth.query },
                        },
                        context,
                    )
                },
            })
        }
        return createOpenAPIPage(
            consoleOptions(consoleConfig, direct, registry),
        )
    }, [consoleConfig, bundled, operations, webhooks, direct])
    return <OpenAPIPage {...pageProps} />
}
