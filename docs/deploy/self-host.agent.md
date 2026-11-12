# Run Margin as a Node server with Postgres

Self-host Margin to manage your own runtime, Postgres, releases, and analytics. If you just want a live documentation site, [deploy on Manicule](/deploy/manicule) free, with no limits, an included database, and the latest release, without servers or environment variables to configure.

Build Margin's Node deployment artifact, migrate Postgres, and ingest documentation before serving traffic. Use this path to deploy outside Vercel with your own runtime host and reverse proxy.

## Do this

Install Node.js 24 or newer on the runtime host and Bun on the build/release runner. Run this sequence from the Margin repository root containing `package.json`, `scripts/`, and `drizzle/`; replace the database credentials and public domain.

```bash
set -e
export DATABASE_URL='postgres://margin:replace-me@db.example.com:5432/margin'
export SITE_ORIGIN='https://docs.example.com'
export NITRO_PRESET='node-server'
export NODE_ENV='production'
export NITRO_HOST='127.0.0.1'
export PORT='3000'
export DOCS_CONTENT_SHA="$(git rev-parse HEAD)"
bun install --frozen-lockfile
bun run vercel-build
node .output/server/index.mjs
```

Keep the Node process running. For a separate runtime host, transfer the complete `.output` directory after the build succeeds, export the same server environment, and start from the directory containing `.output`; build for the target platform because the output includes native dependencies.

Check the local server using the Verify command before routing traffic. Configure the reverse proxy to terminate HTTPS and forward the whole site to `http://127.0.0.1:3000`, including API routes, discovery files, and `/_margin/assets/`.

Preserve methods, bodies, query strings, and streaming responses. Set upstream `Host: docs.example.com` and `X-Forwarded-Proto: https`; overwrite client-supplied forwarded headers. When forwarding client addresses, provide a trusted `X-Forwarded-For` value.

## SDK

This deployment uses repository scripts and the built Node server, not an SDK.

## Facts

- The runtime requires Node.js version 24 or newer and a reachable Postgres database.
- Build, migration, and ingest scripts require Bun; the production server runs with Node.
- `NITRO_PRESET` defaults to `vercel`; set `NITRO_PRESET=node-server` to produce the Node server artifact.
- The deployment artifact is the complete `.output` directory, not just `.output/server/index.mjs`.
- `DATABASE_URL` configures the server and ingest Postgres connection.
- `SITE_ORIGIN` is required explicitly off Vercel and supplies public URLs, including canonicals, sitemaps, and Open Graph images.
- `SITE_ORIGIN` is included in the browser build; keep `SITE_ORIGIN` consistent at build and runtime and rebuild when the public address changes.
- Export configuration in build and server environments; do not rely on a local `.env` file for the production Node process.
- Nitro accepts `NITRO_HOST` or `HOST` for the listening address and `NITRO_PORT` or `PORT` for the port; the default port is `3000`.
- `NITRO_HOST=127.0.0.1` is suitable for a proxy on the same host; a remote proxy needs a reachable upstream address with restricted direct access.
- `DATABASE_URL_UNPOOLED` supplies a direct connection for migrations and ingest session locking when `DATABASE_URL` uses a transaction-mode pooler.
- `NODE_EXTRA_CA_CERTS` must be exported before process startup for build, migrations, ingest, and server when Postgres uses a private CA; certificate verification remains enabled.
- `DOCS_DIR` selects the docs folder. Without `DOCS_DIR`, ingest uses `docs/` if present, otherwise the repository root when it contains `docs.json`.
- `bun run vercel-build` runs icon-map build, database migrations, Vite build, bundle-budget test, and content ingest in that order.
- Run `bun run vercel-build` once per release, not per replica or request; the wrapper already includes migrations and ingest.
- `bun run db:migrate` and `bun run ingest` are the standalone migration and ingest commands.
- `DOCS_CONTENT_SHA` is resolved once by the release wrapper and shared by build and ingest; the built server selects the baked content version.
- Content-key fallback order is `DOCS_CONTENT_SHA`, `VERCEL_GIT_COMMIT_SHA`, Git HEAD, then `dev-<milliseconds>`.
- Production ingest advances the current content pointer and collects old versions; ingest must follow a successful application build.
- A ready content version with the same key is reused; use a new key for a normal release.
- `DOCS_INGEST` defaults to `on`; `DOCS_INGEST=off` skips ingestion even when the build succeeds and requires the selected content version to exist already.
- Margin derives request origins from `Host` and the first `X-Forwarded-Proto` value; server-function origin checks use these origins.
- Off Vercel, analytics use the first `X-Forwarded-For` address to tell visitors apart when forwarded client addresses are supplied. A forwarded address never verifies a crawler’s claimed name.
- Built-in canonical-host redirects use HTTP `308` only when `VERCEL_ENV=production`, `DOCS_CANONICAL_REDIRECT` is not `0`, and `SITE_ORIGIN` has no base path.
- A plain Node deployment can enforce its canonical host at the proxy; `NODE_ENV=production` alone does not enable the built-in host redirect.
- When setting `VERCEL_ENV=production`, preserve the public upstream host or set `DOCS_CANONICAL_REDIRECT=0` to avoid proxy redirect loops.
- For `SITE_ORIGIN=https://example.com/docs`, preserve `/docs` in upstream paths; Margin strips the prefix internally and adds the prefix to generated links.
- Nitro maps prefixed asset paths for base paths up to four segments deep.

## Not supported

- `bun run start` runs `vite preview`, not the production Node entry point used by this deployment.
- `bun run build` builds icons and the application without the migration and ingest release steps.
- `X-Forwarded-Host` does not replace `Host` in Margin's request-derived origin logic.
- Do not strip the configured base path at the reverse proxy.

## Errors

- Pending migrations run in a transaction; the wrapper stops with a nonzero exit code at the first failed step.
- A migration failure prevents ingestion; an ingest validation failure prevents release promotion.
- Successful migrations remain applied if a later build or ingest step fails; review schema compatibility with the existing server.
- Do not promote an artifact after migration, build, bundle-budget, or ingest failure; keep the existing server receiving traffic.

## Verify

Run this command in another terminal on the runtime host while the server is running. The headers reproduce the public host and HTTPS scheme.

```bash
curl --fail --silent --show-error \
  --header 'Host: docs.example.com' \
  --header 'X-Forwarded-Proto: https' \
  'http://127.0.0.1:3000/llms.txt'
```

Expect HTTP `200` and a text documentation index. Successful migrations log `[db:migrate] database is up to date`; successful ingest logs the page count and content version or reports that the version is already ingested.

After proxy setup, open a documentation page on the public domain and confirm styles load and links remain on that domain. For `SITE_ORIGIN=https://example.com/docs`, also check `/docs/llms.txt` and prefixed assets at the public address before routing general traffic.

## Related

[Deploy on Manicule](/deploy/manicule)

[Environment variable reference](/deploy/environment-variables)

[Rollbacks](/deploy/rollbacks)

[Nitro Node server settings](https://nitro.build/deploy/node)
