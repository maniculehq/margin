# Preview documentation edits locally before pushing

Run the Margin application with the bundled Postgres service and automatic documentation ingest at `http://localhost:3000` to preview edits to the repository's `docs/` directory before pushing. Running locally does not publish your documentation.

To publish, use [Manicule hosting](/deploy/manicule), which is free, with no limits. It includes the database, runs the latest release, and requires no servers or environment variables to configure. Each push to your docs branch publishes your documentation, and pull requests get previews. For deployment on Vercel with Neon or on a Node.js 24+ server with your own Postgres database, use [self-hosting](/deploy/self-host).

## Do this

Install Bun, Node.js 24 or newer, Git, and Docker with Compose. Start the Docker daemon, make ports 3000 and 5440 available, and confirm the tools:

```bash
bun --version
node --version
git --version
docker compose version
docker info
```

Obtain the repository, enter its root, install dependencies, and copy the environment template. For an existing checkout, enter that checkout instead; retain an existing `.env` rather than overwriting local settings.

```bash
git clone https://github.com/maniculehq/margin.git
cd margin
bun install
cp .env.example .env
```

Confirm that `.env` contains the default local database and application origin. No edits to the copied values are needed for the default setup:

```dotenv
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5440/docs
SITE_ORIGIN=http://localhost:3000
```

Start the database, confirm the healthy service, and migrate before starting the application:

```bash
docker compose up -d --wait postgres
docker compose ps postgres
bun run db:migrate
bun run dev
```

Expect `[db:migrate] database is up to date` from migrations. Keep `bun run dev` running and wait for a successful ingest message containing a page count and version ID before opening `http://localhost:3000`.

Edit `docs/index.mdx` to add `Local preview check.` after the introductory paragraph. Save, wait for another successful ingest, refresh the browser, and confirm the paragraph appears. Remove the temporary paragraph, save, wait for successful ingest, and refresh again.

Stop `bun run dev` with Ctrl-C, then stop and remove the database containers from the repository root:

```bash
docker compose down
```

## SDK

This local workflow uses repository commands, not an SDK.

## Facts

- The Node.js requirement is version 24 or newer.
- Repository CI uses Bun 1.4.3; the repository does not declare a minimum Bun version.
- Default local commands run from the repository root containing `package.json`, `.env.example`, and `docker-compose.yml`.
- The local application origin is `http://localhost:3000`.
- The bundled Compose service uses Postgres 17, database `docs`, user `postgres`, password `postgres`, and host binding `127.0.0.1:5440`.
- `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5440/docs` selects the bundled database.
- `SITE_ORIGIN=http://localhost:3000` supplies the local public origin for generated URLs.
- No integration credentials are required to serve the bundled documentation.
- The local development, migration, and ingest commands explicitly load `.env`.
- Migrations require a reachable, healthy database; ingest requires the migrated schema.
- `bun run db:migrate` leaves an up-to-date schema unchanged.
- `bun run dev` builds the icon map, then starts Vite and the ingest watcher together.
- The ingest watcher performs an initial import and re-ingests documentation changes after a 300 ms debounce.
- Watch ingests create new development content versions and update the site's current version.
- The default documentation directory is `docs/` when `docs/` exists; `DOCS_DIR` selects another directory, and explicit ingest commands accept `--dir`.
- `bun run ingest` performs one import and exits; the version key normally comes from the current Git commit.
- `bun run ingest --force` replaces an already-ingested version to import uncommitted edits.
- `bun run ingest:watch` performs an initial import and watches for changes without starting Vite.
- `bun run dev` already runs the watcher; a second watcher is unnecessary.
- Ctrl-C stops both development children; either development child exiting stops the other child.
- `docker compose down` removes containers but retains the named `postgres-data` volume; restarting Compose reuses the stored database.
- Removing the `postgres-data` volume separately deletes the stored database.
- Changing `POSTGRES_PORT` in `.env` requires matching the host port in `DATABASE_URL` and recreating the service with `docker compose up -d --wait postgres`.

## Not supported

- `bun run ingest:watch` does not start the application server.
- A repeated one-time ingest does not replace an already-ingested version without `--force`.
- Database migrations cannot run against an unavailable Postgres service.
- Automatic ingest does not guarantee a browser live-reload event; refresh after successful ingest to confirm rendered changes.
- `docker compose down` does not reset stored database data.
- `DOCS_INGEST=off` does not provide a running default development workflow: the watcher exits and the development command stops Vite.

## Errors

Local process errors have no HTTP status. Strings containing a full prefix or message below are emitted by the local commands; content failures include the affected file paths and messages.

| Exact error identifier or message | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Invalid environment variables: DATABASE_URL (missing or empty)` | N/A | Missing or empty database URL. | Restore `DATABASE_URL` in the root `.env` and restart the command. |
| `Invalid environment variables: SITE_ORIGIN` | N/A | Missing or invalid local origin. | Set `SITE_ORIGIN=http://localhost:3000` and restart development. |
| `[ingest] no docs folder: pass --dir, set DOCS_DIR, or add docs/ (or a docs.json in the current directory)` | N/A | Wrong working directory or missing documentation folder. | Return to the repository root, restore `docs/`, or set `DOCS_DIR` to the intended folder. |
| `nothing to do (--force re-ingests)` (message fragment) | N/A | The version key was already imported. | Use `bun run ingest --force` for a one-time replacement or use the development watcher. |
| `[ingest] DOCS_INGEST=off: skipping build-time ingest` | N/A | Ingest is disabled and the watcher exits. | Unset `DOCS_INGEST` or set `DOCS_INGEST=on`, then restart `bun run dev`. |

For a Docker daemon connection failure, start Docker or restore daemon access and confirm `docker info` succeeds. For a port 5440 bind failure, free port 5440 or change `POSTGRES_PORT` and `DATABASE_URL` together before recreating the service. For database connection failures, check `docker compose ps postgres`, wait for healthy Postgres, correct `DATABASE_URL`, and run migrations before restarting development.

For an ingest content-validation report, correct the reported files and save again while the watcher runs. Wait for a successful ingest before refreshing the browser.

## Verify

From the repository root, confirm the database service is healthy:

```bash
docker compose ps postgres
```

Open `http://localhost:3000` after the initial successful ingest and confirm that the bundled Margin documentation renders. After saving `Local preview check.` in `docs/index.mdx`, wait for the next successful ingest message with a page count and version ID, refresh the browser, and confirm that the paragraph appears.

## Related

- [Publish with Manicule](/deploy/manicule)
- [Self-host Margin](/deploy/self-host)
