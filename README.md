# Margin

Margin is a modern, agent-first framework for documentation. It turns a folder
of Markdown or MDX into a searchable site backed by Postgres, and serves the
same content to readers and to AI agents.

- **Zero config to start.** One `.mdx` file is a site. Navigation and titles
  come from your files, frontmatter, and optional `meta.json`.
- **Optional `docs.json`.** Colors, fonts, navigation, redirects, versions,
  and OpenAPI pages, compatible with Mintlify's `docs.json`.
- **Built for agents.** Markdown and PDF twins of every page, `llms.txt`, an
  MCP server, skills, and an optional AI assistant.
- **Safe by default.** MDX is validated at ingest and server-rendered in an
  isolate with no host access.
- **Immutable deployments.** Each commit becomes its own content version, so
  previews and rollbacks serve exactly what was built.

Built with TanStack Start, fumadocs, and Postgres.
Licensed under [Apache-2.0](LICENSE).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/maniculehq/margin&project-name=my-docs&repository-name=my-docs&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=SITE_NAME&envDescription=Display+name+of+your+documentation+site&envLink=https://github.com/maniculehq/margin/blob/main/docs/deploy/environment-variables.mdx)

The button clones this repository and provisions a Neon Postgres database.
Enter a `SITE_NAME` when asked. To publish, edit `docs/` in your copy and push.
You need no other accounts or credentials. See the
[deployment guide](docs/deploy/self-host.mdx) for self-hosting, retention, and rollbacks.

## Run locally

You need [Bun](https://bun.sh), Node.js 24 or newer, and Docker.

```bash
bun install
cp .env.example .env
docker compose up -d --wait postgres
bun run db:migrate
bun run dev
```

The site runs at `http://localhost:3000` and picks up edits to `docs/`.
Run `docker compose down` to stop the database.

## Configure

`docs.json` is optional:

```json
{
  "name": "Example Docs",
  "colors": { "primary": "#2563EB" },
  "navigation": { "groups": [{ "group": "Start", "pages": ["index", "deploy"] }] },
  "x-margin": { "search": { "mode": "static" } }
}
```

Margin-specific settings live under `x-margin`. Outside Vercel, the only
required environment variables are `DATABASE_URL` and `SITE_ORIGIN`.

## Documentation

- [Configuration](docs/settings/docs-json.mdx): files, `docs.json`, versions,
  icons, and environment variables
- [Deployment](docs/deploy/self-host.mdx): Vercel, self-hosting, content versions, and
  rollbacks
- [Extensions](docs/extend/extensions.mdx): replace request policy, site resolution,
  and telemetry
- [Agents](docs/agents/overview.mdx) and [link relations](docs/agents/link-relations.mdx):
  Markdown, LLM indexes, MCP, and skills
- [Deployment standard](spec/deployment-standard.md): every supported field and
  the MDX security contract

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md). Third-party fonts and icons are credited in
[NOTICE](NOTICE).

Originally built by Manicule.
