# Retrieve Margin documentation for agents

Retrieve agent Markdown directly, discover the documentation corpus, or connect an MCP client for documentation tools. Use these interfaces when an agent needs documentation without parsing HTML navigation.

## Do this

Set `DOCS_URL` to the documentation site's base URL and fetch this page with an explicit Markdown preference:

```sh
export DOCS_URL="https://docs.example.com"
curl --fail --silent --show-error \
  --header 'Accept: text/markdown' \
  "$DOCS_URL/agents/overview"
```

Use `/llms.txt` to find other published page paths before fetching those pages.

## Facts

- Each documentation page has a human MDX rendition and an agent Markdown rendition; audience-specific content can differ between renditions.
- `/<page>.md`, `Accept: text/markdown` on a normal page URL, and `?format=markdown` on a normal page URL retrieve the same agent Markdown.
- Successful Markdown responses use `Content-Type: text/markdown; charset=utf-8`.
- `/<page>.pdf` downloads the human rendition with agent-only blocks excluded.
- `/index.md` and `/index.pdf` are the root page's alternate formats.
- `/llms.txt` indexes pages by title and description.
- `/sitemap.md` exposes the navigation structure as Markdown.
- `/llms-full.txt` serves documentation text together, subject to the configured serving budget.
- `/.well-known/llms-manifest.json` describes available corpus surfaces; HTTP `Link` headers and manifest links provide discovery paths.
- `/.well-known/api-catalog` exposes OpenAPI document discovery when OpenAPI documents are present.
- `/api/mcp` is the built-in MCP server, enabled by default, with Streamable HTTP transport for documentation search and retrieval.
- `/.well-known/mcp.json` provides MCP discovery.
- `/skill.md` provides the site-level documentation skill; `/AGENTS.md` provides site-level agent instructions.
- `/.well-known/agent-skills/index.json` lists published authored skills and links to `SKILL.md` files and supporting files.
- Ask AI is an optional reader-facing assistant that cites the documentation pages used in answers.
- Unmarked content is available to human and agent audiences.
- `<Agent>` and `<Visibility for="agents">` include content in agent Markdown and exclude content from the rendered human page and PDF.
- `<Human>` includes content in the human page and PDF and excludes content from agent Markdown.
- `x-margin.agents.contentSignals.search`, `x-margin.agents.contentSignals.aiInput`, and `x-margin.agents.contentSignals.aiTrain` in `docs.json` each default to `true`.
- Content signals are published in `robots.txt` and the `Content-Signal` response header.

## Not supported

- Agent Markdown is not necessarily identical to visible HTML with tags removed; audience-specific blocks can change the content.
- PDF downloads do not contain the agent rendition.
- Published skills do not install or execute server-side plugins.
- Markdown and MCP retrieval do not require a reader to start an Ask AI conversation.
- Visibility components and content signals do not enforce authorization or prevent copying public content.
- Hiding a page from navigation does not make the page private.
- Discovery surfaces do not guarantee external model recommendations or page rankings.

## Errors

| Error identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Page not found` | 404 | Requested Markdown page does not exist. | Read the Markdown explanation and suggested pages, or consult `/llms.txt` for a published path. |

## Verify

Inspect the response headers and body for the same page:

```sh
curl --fail --silent --show-error \
  --include \
  --header 'Accept: text/markdown' \
  "$DOCS_URL/agents/overview"
```

Expect a successful response with `Content-Type: text/markdown; charset=utf-8` and Markdown containing a page heading rather than an HTML document.

## Related

- [Markdown and PDF](/agents/markdown)
- [llms.txt](/agents/llms-txt)
- [Link relations](/agents/link-relations)
- [MCP](/agents/mcp)
- [Skills](/agents/skills)
- [Visibility controls](/content/visibility)
- [Content policy](/agents/content-policy)
