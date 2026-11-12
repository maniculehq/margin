# Replace deployment behavior with extensions

Select a trusted host-integration module without changing Margin’s core. Use an extension for deployment-specific site selection, request policy, or telemetry, not site-authored MDX.

## Do this

Create `extensions.ts` at the Margin repository root. The module must export the named `extensions` object with required members `resolveSite`, `requestPolicy`, and `telemetry`; the example retains single-site resolution, adds a temporary probe, and adds a telemetry property.

```ts
import type { DocsExtensions } from "./src/extensions/types"
import { extensions as defaults } from "./src/extensions/default"

export const extensions: DocsExtensions = {
    async resolveSite(request) {
        return defaults.resolveSite(request)
    },
    requestPolicy(request) {
        const policy = defaults.requestPolicy(request)
        if (new URL(request.url).pathname !== "/_extension-health") {
            return policy
        }
        return {
            ...policy,
            shortCircuit: new Response("Extension ready\n", {
                headers: { "Cache-Control": "private, no-store" },
            }),
        }
    },
    telemetry: {
        eventProperties(request) {
            return { docsHost: new URL(request.url).host }
        },
    },
}
```

Set the module in the build environment and rebuild from the Margin repository root:

```sh
DOCS_EXTENSIONS=./extensions.ts bun run build
```

Deploy the rebuilt application. Verify the temporary probe below, then remove the probe and rebuild; `/_extension-health` exists only in this example, not in Margin’s built-in routes.

## Facts

- The extension interface is `DocsExtensions` in `src/extensions/types.ts`; the default implementation is `src/extensions/default.ts`.
- `vite.config.ts` and `vitest.config.ts` alias `#docs-extensions` to `DOCS_EXTENSIONS`, resolved against the framework root for relative paths. An unset `DOCS_EXTENSIONS` selects `src/extensions/default.ts`.
- TypeScript’s `#docs-extensions` path points to the default implementation. Declare the custom export as `DocsExtensions` to check the replacement contract.
- Tests importing `#docs-extensions` use `DOCS_EXTENSIONS`; tests importing the default file directly do not.
- `resolveSite(request: Request): Promise<SiteResolution>` selects an existing ingested site. `DocsSite` requires `id`, `slug`, `name`, `description`, `repo`, `analyticsEnabled`, and `webmcpEnabled`.
- `DocsSite.id` is the database site ID. `DocsSite.slug` is the public analytics, cache-tag, and URL identifier. `DocsSite.repo` is `{ owner, name, branch, subdir }` or `null`.
- `DocsSite.analyticsEnabled: false` suppresses configured site analytics integrations. Display branding is resolved separately from deployment settings and selected docs configuration.
- `SiteResolution` requires `site`, `versionSelector`, `preview`, `canonicalHost`, `basePath`, and `publicOrigin`; `sharedClientAddress` is optional.
- `SiteResolution.site` is `DocsSite | null`. A missing site yields a 404 outside previews; previews can render an empty, uncacheable page.
- `SiteResolution.versionSelector` is `"current" | { kind: "commit"; sha: string } | { kind: "preview"; shaPrefix: string }`.
- `"current"` follows the active site’s current ready version. Exact-commit selection accepts ready or superseded versions of the deployment’s kind (`preview` or `production`). Preview-prefix selection requires one ready preview match and 1–64 lowercase hexadecimal characters; invalid or ambiguous prefixes select no version.
- Margin rechecks live site status before serving content. Cached site metadata cannot bypass suspension.
- `SiteResolution.canonicalHost` is a host string or `null`. A different non-local request host redirects with 308 when `canonicalHost` is set.
- `SiteResolution.basePath` is `""` or a prefix such as `"/docs"` without a trailing slash. The server redirects paths outside the prefix with 308 and strips the prefix before routing.
- `SiteResolution.publicOrigin` is an origin without a path, or `null` to use the request origin.
- `SiteResolution.sharedClientAddress` defaults to `false`. Set `true` when a site owner’s proxy hides visitor addresses. Crawler names are then not checked against their operators’ address ranges: a real crawler behind the proxy stays unverified, not an impersonator. The built-in resolution sets it on Vercel when `SITE_ORIGIN` has a path; elsewhere the proxy’s forwarded header still tells visitors apart.
- `resolveSite` can run in server base-path resolution, content-context loading, and post-response telemetry. Make custom resolution repeatable and cache expensive registry reads when appropriate.
- The default resolves one `docs_site` row using `SITE_SLUG`, default `docs`, for every hostname.
- The default uses `{ kind: "commit", sha: DOCS_CONTENT_SHA }` when `DOCS_CONTENT_SHA` is set, otherwise `"current"`.
- The default caches found and missing sites for 30 seconds, coalesces concurrent lookups, and caches failures for 5 seconds before rethrowing the failures. Failures never serve stale site data.
- The default derives `basePath` from `SITE_ORIGIN`; a nonempty base path sets `publicOrigin` to the configured origin and disables canonical-host redirection.
- Without a base path, the default sets the canonical host from `SITE_ORIGIN` in production unless `DOCS_CANONICAL_REDIRECT=0`. Development and preview deployments do not set a canonical host.
- `requestPolicy(request: Request): RequestPolicy` is synchronous, database-free, and called by several middleware layers. Initial server site resolution occurs before middleware, including short-circuit handling.
- `RequestPolicy` requires `hstsPreload: boolean`, `cacheTag: string | null`, `preview: boolean`, and `shortCircuit: Response | null`.
- `hstsPreload: false` sends `Strict-Transport-Security: max-age=31536000`; `true` sends `max-age=63072000; includeSubDomains; preload`. Enable preload only for domains whose subdomains the deployment operator controls.
- `cacheTag` sets `Vercel-Cache-Tag` on eligible purgeable responses. A tag over 256 characters or containing a comma is dropped, not truncated. `null` adds no tag.
- `RequestPolicy.preview: true` applies `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Keep request-policy and site-resolution preview decisions consistent.
- `RequestPolicy.shortCircuit` skips route handling when non-null and sees a base-path-stripped pathname. A short-circuit response does not bypass initial server site resolution.
- The default request policy uses `hstsPreload: false`, `cacheTag: "site-<SITE_SLUG>"`, `shortCircuit: null`, and preview when `VERCEL_ENV=preview`. Replace the single-site tag when multi-site deployments need separate purge scopes.
- `telemetry` has type `TelemetryHooks`; the default is `{}`. Empty telemetry does not disable Margin’s configured event delivery.
- Telemetry hooks receive a reconstructed bodiless request after the response. Site lookup failure can produce `resolution: null`.
- `telemetry.eventProperties(request: Request, resolution: SiteResolution | null): Record<string, unknown>` adds properties with precedence on key collisions.
- `telemetry.groups(resolution: SiteResolution | null, request?: Request): { groupType: string; groupKey: string; properties?: Record<string, unknown> } | null` supplies PostHog grouping and group-identify properties when configured PostHog delivery runs.
- `telemetry.onEvent(event: Record<string, unknown>): void` replaces the `agentConfig.observability.onEvent` tap. A thrown tap error is caught so PostHog capture can continue.
- `telemetry.visitorKey(request: Request, resolution: SiteResolution | null): string` supplies a stable site-identity input for visitor/session hashes. Default: served site slug, then request host when no site resolves.
- `webmcpRollout?(site: DocsSite, posthog: PostHog | undefined): boolean` uses `PostHog` from `posthog-node`, must answer synchronously from cache, and is ORed with `site.webmcpEnabled`. Omission leaves the site flag as the decision.
- `rateLimitScope?(site: DocsSite): string` changes the identity on which the public chat and feedback limiters count each site’s daily ceiling; the default is `site.id`.
- `clientIp?(request: Request): string | undefined` supplies the caller’s address, which verifies a crawler’s claimed name against its operator’s address ranges and tells visitors apart in analytics. Omission or an empty result falls back to the first `x-vercel-forwarded-for` address, then the first `x-forwarded-for` address. The Vercel fallback verifies only on a request without a `CDN-Loop` header (a CDN in front adds one and connects from its own address); a forwarded header never verifies. Trust alternative proxy headers only on requests known to come through that proxy.
- `headMeta?: readonly HeadMeta[]` adds deployment-owned meta tags at the top of each document head. `HeadMeta` is `{ httpEquiv: string; content: string } | { name: string; content: string }`; omission adds no extension-owned tags.
- `pageViewCheck?: PageViewCheck` labels each browser page-view report (`docs_page_viewed`, sent once per page load and in-site navigation, never for a missing page) and never blocks or changes a response. `enabled(site, resolution, posthog): boolean` runs at render time, must answer from cache (a throw reads as `false`), and makes pages send reports through the browser module's `sendPageView`. `verify(request, resolution, posthog): Promise<PageViewVerdict>` returns `{ verdict: "human" | "bot" | "skipped"; properties?: Record<string, unknown> }`; `request` is the report as it arrived, body unread; Margin waits at most one second and records `skipped` on timeout or rejection. `bot` on a browser's report records it as automation. Omission records every report as `skipped`.
- The browser module `#docs-browser-extensions` (build-time `DOCS_BROWSER_EXTENSIONS`; default `src/extensions/browser-default.ts`, empty) exports `browserExtensions: DocsBrowserExtensions`. Its optional `sendPageView(url: string, body: string): Promise<void>` sends a report in place of Margin's beacon; pages import the module lazily and only when `pageViewCheck.enabled` is `true`. A rejection falls back to the beacon, as does a sender still pending after eight seconds; both attempts share one `view_id`, so a report that arrives twice records one view.

## Not supported

- Changing `DOCS_EXTENSIONS` only at runtime does not replace the module in an existing build.
- Returning a `DocsSite` does not create a database site or ingest content.
- `webmcpRollout` returning `false` cannot disable `site.webmcpEnabled: true`.
- Adding telemetry hooks does not provision an analytics destination or configure a PostHog client.
- The example module does not implement multi-site resolution; replace the delegated `resolveSite` and single-site cache tag for that task.
- Site-authored MDX is not the execution context for trusted deployment extensions.

## Errors

The following failures or rejected inputs are defined by the default module and serving contract. A missing identifier means no fixed error string is specified here.

| Error identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Invalid environment variables: SITE_SLUG (one DNS label: lowercase letters, digits and hyphens, at most 55 characters)` | Not applicable; module initialization | Invalid default-extension `SITE_SLUG` | Use one DNS label with lowercase letters, digits, and hyphens, at most 55 characters. |
| No fixed identifier | 404 outside previews | `resolveSite` returns `site: null` | Resolve an existing ingested site; check the default `SITE_SLUG`. |
| Original database error | Not specified | Default site lookup fails | Restore database access; the default retains the failure for 5 seconds and does not serve stale site data. |
| No fixed identifier | No fixed status specified | Invalid or ambiguous preview prefix | Use 1–64 lowercase hexadecimal characters selecting exactly one ready preview version. |

## Verify

With the example module deployed, request the probe; include the `SITE_ORIGIN` base path before `/_extension-health` if configured:

```sh
curl -i 'https://YOUR_DOCS_HOST/_extension-health'
```

Success is status `200`, `Cache-Control: private, no-store`, and body `Extension ready`. This verifies module selection and request-policy execution, not content ingestion or database health.

## Related

[Content execution boundary](/extend/security)
