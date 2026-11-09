# Contributing

Contributions to Margin are welcome. Read the [code of conduct](CODE_OF_CONDUCT.md)
and check existing issues before starting a substantial change. Discuss changes
to public behavior or the deployment standard in an issue first.

## Set up

Use Bun for dependency installation, scripts, and one-off package tools.
Install Node.js 24 or newer and Docker with Compose.

```bash
bun install
cp .env.example .env
docker compose up -d --wait postgres
bun run db:migrate
bun run dev
```

The bundled docs are the development site. Keep credentials in your environment
or an ignored `.env`. The database must be reachable for ingest and DB-backed
tests. A private-CA Postgres provider needs `NODE_EXTRA_CA_CERTS` exported before
process startup; retain TLS verification.

## Make a change

Keep each change focused. Update the docs and changelog when public behavior
changes. Use the real TypeScript types or Zod validation instead of casts or
`any`. Prefer existing module boundaries and components. The framework keeps
the type scale that docs.json content is written against (for example
`text-base` for card titles and body text); keep new UI on that scale. Avoid
adding a helper that only forwards a call or duplicating a contract's existing
tests.

`src/types/docs.ts` defines content contracts; `src/extensions/types.ts` defines
the server extension interface. Changes to MDX validation, isolate globals,
render limits, assets, or CSS sanitization require an explicit security review.
The server process must never evaluate authored MDX with host access.

For schema changes, edit `src/db/schema/`, run `bun run db:generate`, inspect
the generated migration under `drizzle/`, and validate it on a disposable
database. Name foreign keys explicitly. Never use a production database for tests.

## Validate

Run independent checks in parallel. The basic gates are:

```bash
bun run typecheck &
bun run lint &
bunx vitest run tests/conventions &
wait
```

Check each command's exit status; a shell's final `wait` is not a combined test
result. Run the relevant behavior tests and the full suite before requesting
review:

```bash
bun run test
bun run test:e2e
```

The e2e script owns a separate Compose project and database. `bun run test`
ignores `.env`, so a local setting cannot change test results; without an
exported `DATABASE_URL` it skips the database-backed suites. For the full suite
against your development database, run `bun run test:db`, which starts the
Compose Postgres, migrates it, and runs the suite with `.env` loaded. For documentation changes,
exercise the real ingest path too:

```bash
bun run ingest --dir docs --slug docs --force
```

Add tests for observable behavior or a credible regression. Each assertion must
fail for the behavior it claims to protect; verify a regression by temporarily
making the production change the test should catch. Prefer real flows and
services to mocks of internal logic. For behavior a test cannot hold
still, such as request counts, bundle sizes, or timings, include a before and
after measurement instead.

## Submit

Use a Conventional Commit such as `docs(framework): explain content retention`
or `fix(framework): preserve the selected version`. Explain the problem,
resulting behavior, and validation in the pull request template. Include
screenshots for visual changes. A PR should contain no tokens, private content,
generated Pro glyphs, or unrelated dependency changes.

Contributions are licensed under Apache-2.0. Preserve third-party notices and
update [NOTICE](NOTICE) when an asset or patch changes. Report vulnerabilities
through the private process in [SECURITY.md](SECURITY.md).
