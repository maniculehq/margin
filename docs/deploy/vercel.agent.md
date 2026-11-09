# Deploy Margin to Vercel with Neon

Vercel with Neon is a self-hosting option for Margin. If you just want a live site, [deploy free on Manicule](/deploy/manicule), with no limits, no servers or environment variables to manage, an included database, and the latest release.

Deploy a Margin repository to Vercel with build-time content ingestion into Neon Postgres. Use this procedure to publish a site and verify that a branch preview serves its own commit without replacing production content.

## Do this

1. Open [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https://github.com/maniculehq/margin&project-name=my-docs&repository-name=my-docs&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=SITE_NAME&envDescription=Display+name+of+your+documentation+site&envLink=https://github.com/maniculehq/margin/blob/main/docs/deploy/environment-variables.mdx). Complete the repository and project prompts with an account permitted to create both resources. The button copies `maniculehq/margin` and suggests `my-docs` for the repository and project names.
2. Keep the repository root as the Vercel project root. Use a Node.js runtime of version 24 or newer. Keep install command `bun install` and build command `bun run vercel-build`.
3. Complete the Neon Marketplace integration. Connect Neon to both Production and Preview environments. Keep the environment-variable prefix unchanged. Confirm that `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are available in both environments.
4. Supply the site display name through Vercel's `SITE_NAME` environment variable. Use this example value:

```dotenv
SITE_NAME="Acme Docs"
```

5. Replace the example documentation in the repository's `docs/` directory and start the deployment.
6. Inspect the build log for `[vercel-build] content version` and a successful final `[ingest]` result. A repeated key can report `is already ingested`. Do not treat an ingest skip as a successful fresh content ingest.
7. Open the completed deployment URL. Confirm the edited text and site name, follow a navigation link, and open a page with an image if the documentation includes images.
8. Create a branch in the connected repository. Change a sentence on an existing page to `Preview content check` and push the branch.
9. Open the branch's Preview deployment. Confirm the source commit and a `preview` ingest result. Confirm the changed sentence on the preview URL and unchanged text on the production URL.

## SDK

This deployment procedure uses the Vercel dashboard, not an SDK.

## Facts

- Margin requires Node.js 24 or newer.
- The Vercel install command is `bun install`.
- The Vercel build command is `bun run vercel-build`.
- The Neon integration supplies pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` connections; migrations use the direct connection.
- `SITE_NAME` overrides the `docs.json` name; the site slug is the fallback when neither name is supplied.
- `SITE_NAME` is read at build time; changes to `SITE_NAME` require redeployment.
- The deployment build resolves a content key, builds icons, runs database migrations, builds the server, checks the bundle budget, and ingests content last.
- The server build and ingest use the same content key.
- Without a `DOCS_CONTENT_SHA` override, Vercel builds use `VERCEL_GIT_COMMIT_SHA` as the content key.
- Preview deployments use `VERCEL_ENV=preview` and ingest content with kind `preview`.
- Preview ingest does not advance the production content pointer, even when preview and production share a database.
- Each deployed server selects the content key baked into the server build.
- Production requests can redirect to the canonical host; preview requests do not redirect to the canonical host.
- Vercel deployment URLs supply the inferred public origin; `SITE_ORIGIN` can explicitly set a custom canonical origin.

## Not supported

- A successful server build alone does not confirm completed content ingestion.
- Preview ingest does not replace production content through the production pointer.
- A deployed server does not automatically select the most recently ingested content.
- Ordinary documentation deployment does not require a Blob store.

## Errors

If the log contains `[ingest] DOCS_INGEST=off: skipping build-time ingest`, remove the `DOCS_INGEST=off` override for this workflow. If validation fails, fix the reported content and push again. If Postgres connectivity fails, check the Neon connection and environment scope in Vercel. Leave `DOCS_CONTENT_SHA` unset for ordinary branch previews.

## Verify

The deployment workflow requires Vercel project setup through the dashboard. Verify completion through the build log and rendered pages.

| Check | Success condition |
| --- | --- |
| Build log | `[vercel-build] content version` records the content key. |
| Ingest log | A successful fresh result records site, key, kind, page and asset counts, and a version identifier; an existing version can report `is already ingested`. |
| Production URL | The edited documentation and expected site name render; navigation and documented images load. |
| Preview deployment | The source commit matches the branch commit and ingest reports kind `preview`. |
| Preview URL | The changed page contains `Preview content check`. |
| Production isolation | The same page on the production URL retains the production text. |

## Related

- [Environment variables](/deploy/environment-variables)
- [Self-hosting](/deploy/self-host)
- [Rollbacks](/deploy/rollbacks)

For the full content-selection model, see [the version-selection page](/deploy/rollbacks).
