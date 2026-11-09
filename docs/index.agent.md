# Choose where to start with Margin

Bring your Mintlify docs as they are. Host them free on Manicule, or run them yourself.

Margin publishes a folder of Markdown or MDX as a searchable, versioned documentation site backed by Postgres. Use this overview to choose deployment, local development, MDX components, or agent integration documentation.

## Do this

Use [Manicule hosting](/deploy/manicule) as the default publishing path. Follow the [Quickstart](/quickstart) to get a live docs site hosted free on Manicule. Alternatively, choose [self-hosting](/deploy/self-host); the same repository and `docs.json` work in either direction.

## SDK

This overview covers documentation publishing and agent interfaces, not SDK usage.

## Facts

- Margin is an open-source, agent-first documentation framework, licensed under Apache 2.0 with either hosting choice.
- Hosting on Manicule is free, with no limits. Manicule includes the database and runs the latest release; you do not need to manage servers or environment variables.
- One `.mdx` file is enough to define a Margin site.
- Margin derives page titles, URLs, navigation, and a default appearance from content files without requiring `docs.json`.
- Optional Mintlify-compatible `docs.json` configures supported navigation, colors, fonts, redirects, product versions, and OpenAPI references.
- Margin-specific configuration lives under `x-margin` in `docs.json`.
- Unknown `docs.json` fields produce diagnostics.
- Margin theme presets approximate Mintlify layouts rather than reproduce Mintlify layouts pixel for pixel.
- Every Margin page has Markdown and PDF representations.
- `/llms.txt` provides an index of documentation pages.
- `/llms-full.txt` provides a combined text corpus within the configured serving budget.
- The built-in MCP server at `/api/mcp` supports documentation search and reads.
- Markdown, discovery indexes, and MCP select the same published content version as browser pages.
- Margin validates MDX during ingest and server-renders executable content in an isolate without host access.
- Margin sanitizes SVGs and CSS before serving.
- Pages omitted from navigation remain reachable by URL.
- A normal deployment uses a commit-specific content version; a deployed server reads the content key baked into the deployment.
- Preview ingest does not advance the production pointer, even when preview and production share a database.
- Validation failures stop deployment; ingest runs after the build so a failed build does not advance the production pointer.
- Retention can remove older content versions.
- Forced ingest replaces content under an existing key; a normal immutable publish uses a new content key.

## Not supported

- Mintlify compatibility does not guarantee pixel-identical theme rendering.
- Navigation visibility does not enforce private access to public documentation.
- Immutable deployments do not guarantee permanent retention of every content version.
- Forced ingest does not preserve the previous content under the replaced key.

## Errors

Validation failures stop deployment. Unknown `docs.json` fields produce diagnostics; see [configuration](/settings/docs-json) for supported behavior.

## Verify

Confirm that a preview does not replace production content and that browser pages and agent interfaces select the same published content version. See [deployment](/deploy/rollbacks) for retention and rollback behavior.

## Related

| Task | Documentation |
| --- | --- |
| Preview docs locally and see edits | [Run locally: repository instructions](/local-development) |
| Find built-in MDX components | [Components: implementation listing](/content/components) |
| Connect agents to Markdown, indexes, and MCP | [Agents](/agents/overview) |
| Configure supported Mintlify fields and Margin options | [Configuration](/settings/docs-json) |
