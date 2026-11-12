# Configure environment variables

Environment variable configuration applies to self-hosted sites; [Manicule-hosted sites](/deploy/manicule) set no environment variables.

Configure Margin's build, ingest, and runtime environments without assuming defaults. Use this reference before deploying or changing an existing deployment's settings.

## Do this

For a standalone Node deployment, use Node.js 24 or newer, Bun for build commands, and a reachable Postgres database. Export the database URL and public site URL in the build environment and again in the runtime environment; replace the placeholders before running these commands from the repository root.

```bash
export DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE'
export SITE_ORIGIN='https://docs.example.com'
export NITRO_PRESET='node-server'
bun run vercel-build
node .output/server/index.mjs
```

The deployment build runs icon generation, migrations, server build, bundle-budget checks, and ingest. Supply a direct database connection for a transaction-mode pooler, and export a private CA path before starting any affected process.

## SDK

Configuration uses environment variables and repository commands, not an SDK.

## Facts

- `DATABASE_URL` / `POSTGRES_URL`: required for migrations, ingest, and database-backed serving; first non-empty value in that order wins; no built-in connection URL. Read during migrations, ingest, and runtime. User or database integration supplies the URL.
- `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING`: first non-empty value in that order wins; default is the main connection URL. Supply a direct connection when the main URL uses a transaction-mode pooler. Read by migrations and the ingest advisory lock.
- `DATABASE_POOL_MAX`: optional integer from `1` through `20`, default `2`; read at database pool creation, including runtime and ingest.
- `NODE_EXTRA_CA_CERTS`: optional PEM CA bundle path for a private database CA; default is Node's built-in CA list. Read at process startup for build, migrations, ingest, and server. Remote database certificates remain verified.
- `POSTGRES_PORT`: optional local Compose database host port, default `5440`; read at Compose startup. Changing `POSTGRES_PORT` does not update the connection URL.
- `SITE_ORIGIN`: absolute public site URL, optionally including a base path; required when Vercel URL inference is unavailable. Explicit value overrides inference. Production inference uses `https://` plus `VERCEL_PROJECT_PRODUCTION_URL`; otherwise inference uses `https://` plus `VERCEL_URL`. Read at build and runtime; keep both values identical.
- `SITE_SLUG`: database site slug and cache tag for the built-in single-site extension; default `docs`; lowercase letters, digits, and inner hyphens, at most 55 characters. Read by ingest and runtime; both must match.
- `SITE_NAME`: optional display-name override, inlined at build into client and server; fallback is content's `docs.json` name, then stored site name or slug. Before site resolution, the application fallback is `Docs`.
- `DOCS_DIR`: ingest folder containing `docs.json` and MDX; CLI `--dir` overrides the variable. Default is `docs/` when present, otherwise `.` when `docs.json` exists; an explicit folder is required when neither exists.
- `DOCS_CONTENT_SHA`: deployment content-version key, baked at build and used by ingest. `bun run vercel-build` resolves `DOCS_CONTENT_SHA`, then `VERCEL_GIT_COMMIT_SHA`, then git HEAD, then `dev-<unix ms>`. Without a baked key, development follows the current pointer.
- `DOCS_INGEST`: ingest control; enum `on`, `off`, `force`, default `on`. `off` skips ingest; `force` replaces an existing key. CLI `--force` overrides `off`.
- `DOCS_KEEP_VERSIONS`: ingest garbage-collection retention count for other production versions, alongside age-based and protected versions; integer of at least `1`, default `20`.
- `DOCS_CANONICAL_REDIRECT`: runtime enum `0` or `1`, default `1`. `0` disables production canonical-host redirects. Built-in redirects require `VERCEL_ENV=production` and no base path; previews never redirect.
- `DOCS_CHAT_MODEL`: runtime AI Gateway model, default `openai/gpt-5.6-terra`.
- `AI_GATEWAY_API_KEY`: assistant credential required outside Vercel; checked at runtime call time. Without a credential outside Vercel, the assistant is disabled and static search remains available. Vercel can use deployment OIDC with Gateway access.
- `DOCS_LINK_RELATION_BASE`: runtime discovery link-relation base URI, default `https://github.com/maniculehq/margin/blob/main/docs/link-relations.md#`.
- `BLOB_READ_WRITE_TOKEN`: optional ingest and garbage-collection credential for Vercel Blob. Without the token, assets and search corpus remain in Postgres within ingest size caps; versions with blobs remain when cleanup cannot safely delete the blobs.
- `HUGEICONS_PRO_TOKEN`: optional icon-build credential; unset uses Free icons.
- `HUGEICONS_PRO_STYLE`: optional icon-build Pro style used with a token; default `stroke-rounded`.
- `GITHUB_TOKEN`: optional runtime GitHub credential for the repository stars widget; unset uses unauthenticated requests.
- `POSTHOG_KEY`: optional runtime agent-journey analytics credential; unset disables agent-journey analytics.
- `POSTHOG_HOST`: optional runtime PostHog ingestion host; default `https://us.i.posthog.com`; used with `POSTHOG_KEY`.
- `SENTRY_DSN`: optional runtime server error-reporting credential and build upload gate; unset disables Sentry. Development stays silent unless `SENTRY_ENVIRONMENT` is set.
- `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`: build upload settings; source-map uploads and release creation require all three plus `SENTRY_DSN`. Missing any value omits the upload plugin.
- `SENTRY_ENVIRONMENT`: optional runtime Sentry label, default `VERCEL_ENV`, otherwise `NODE_ENV`; explicit value also opts local development into reporting.
- `SENTRY_RELEASE`: optional runtime Sentry release override; no application-defined fallback; SDK/platform detection may supply a release.
- `DOCS_EXTENSIONS`: optional build-time path to a module exporting `extensions: DocsExtensions`; default is the built-in single-site module. Relative paths resolve from the repository root.
- `DOCS_BROWSER_EXTENSIONS`: optional build-time path to a browser module exporting `browserExtensions: DocsBrowserExtensions`; default is the built-in empty module. Relative paths resolve from the repository root.
- `NITRO_PRESET`: build target, default `vercel`; set `node-server` for the supported standalone Node deployment.
- `PORT`: optional positive integer for Vite dev/preview startup; unset uses Vite's default. The generated Node server also accepts `PORT` at startup.
- `NODE_ENV`: build/runtime environment supplied by tooling or user; enum `development`, `test`, `production`, default `development`.
- `VERCEL`: platform-provided runtime signal for assistant availability; unset supplies no Vercel signal. The signal alone does not grant Gateway access.
- `VERCEL_ENV`: Vercel-provided build, ingest, and runtime environment; enum `development`, `preview`, `production`; unset off Vercel. Deployment environment falls back to `NODE_ENV`.
- `VERCEL_URL`: Vercel-provided deployment hostname for build/runtime origin inference; no fallback hostname.
- `VERCEL_PROJECT_PRODUCTION_URL`: Vercel-provided production hostname for build/runtime origin inference; fallback is `VERCEL_URL`.
- `VERCEL_GIT_COMMIT_SHA`: Vercel-provided content-key fallback and agent-surface commit metadata; consumed at build, ingest, and runtime metadata. Deployment build falls back to git HEAD, then a generated development key.
- `VERCEL_GIT_PULL_REQUEST_ID`: Vercel-provided preview-ingest PR metadata; optional positive integer, unset means no PR metadata.
- `VERCEL_OIDC_TOKEN`: Vercel-provided runtime identity for Gateway authentication without an API key; refreshed during instance lifetime; unset supplies no OIDC credential.
- `CI`: runner-provided build signal; Sentry's upload plugin is silent when no CI signal is present.
- `AGENT_DOCTOR_URL`: maintenance-command public target URL; required for the doctor when `--url` is absent; `--url` takes precedence; no default.
- Empty strings count as unset in Margin's validated application, database, and ingest settings.
- The `dev`, `start`, `db:migrate`, and `ingest` package scripts explicitly load `.env`; the direct Node server command does not load `.env`.
- Build-time configuration changes require rebuild and redeploy. Runtime configuration changes require server restart; changed Vercel project settings require another deployment.
- Docs-folder, site-slug, asset-storage, and retention changes require ingest. Ready content keys are reused unless forced. Use a new content key for a normal publish; forced ingest replaces content for every deployment pinned to the same key.
- A database URL change requires migrating and populating the destination database before switching the server.
- Build-only source-map upload credentials and Pro icon tokens do not need to be installed on a standalone runtime.

## Not supported

- Restarting the server does not update build-time `SITE_NAME` or the deployment's baked content key.
- Changing ingest inputs does not rewrite a ready content version without forced ingest or a new key.
- CI does not replace deployment database or site-origin requirements.
- `VERCEL` alone does not grant AI Gateway access.
- Test-only switches and internal debugging switches are not deployment settings.
- Analytics options configured only through `docs.json` do not acquire environment-variable interfaces.

## Errors

The HTTP doctor exits `1` if any check fails; investigate the failed checks before treating the deployment as ready.

## Verify

Run the HTTP doctor against the deployed public URL from the repository:

```bash
bun run doctor --url=https://docs.example.com
```

Success prints a check report with every check passing and exits `0`.

## Related

[Deployment procedures, migrations, and retention](/deploy/self-host)

[Configure analytics](/deploy/analytics)
