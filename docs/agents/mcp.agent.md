# Connect an MCP client

Connect an MCP client to search and read a Margin site's published documentation. Use this server when an agent needs page content or code examples from that site.

## Do this

Set `DOCS_URL` to the docs site's URL, including any base path. Request one page reference through the stateless Streamable HTTP endpoint without credentials:

```bash
export DOCS_URL="https://docs.example.com"
curl --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2025-06-18' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_docs","arguments":{"limit":1}}}' \
  "$DOCS_URL/api/mcp"
```

The JSON-RPC response may be carried in an SSE `data:` line. Extract the listing from `result.structuredContent` or parse JSON text in `result.content`; pass the first `pages[].url` to the client's `read_page` tool to retrieve Markdown.

## Facts

- `/api/mcp` is enabled by default, uses Streamable HTTP, is stateless, and requires no authentication, API key, or OAuth.
- Plain `GET /api/mcp` returns discovery JSON with `transport`, `url`, `instructions`, and client-specific `connect` configurations; a successful GET does not prove a tool request succeeded.
- All MCP tools operate on the connected site's published documentation.
- Structured tools return the object in `structuredContent` and as JSON text in `content`; `read_page` returns Markdown text.

The tool contracts use `?` for optional inputs:

| Tool | Inputs | Output and constraints |
| --- | --- | --- |
| `list_docs` | `url?`, `prefix?`, `limit?`, `cursor?` | `pages`, `total`, `nextCursor`, unscoped `otherScopes`; page fields: `title`, `url`, `markdownUrl`, nullable `description`, `section`. Navigation order, optional prefix filtering. Integer `limit`: 1 to 500, default 200; integer `cursor`: nonnegative, default 0. Continue with `cursor: nextCursor` until `nextCursor` is `null`. |
| `search_docs` | `query`, `limit?`, `url?`, `locale?`, `version?` | `results` with `id`, `url`, `type`, `content`, and possible additional search fields. Trimmed `query` must be nonempty. Integer `limit`: 1 to 50, default 10. |
| `read_page` | `url` | Clean agent Markdown; accepts slug, site-root path, or trailing `.md` URL; follows site redirects. URL selects locale/version. |
| `get_code_examples` | `url`, `language?` | `examples` with `language`, `code`, optional `title`, `meta`, `alternativesGroup`. Exact language filter; same page lookup as `read_page`. Matching `alternativesGroup` values mean alternative blocks, not sequential steps. |
| `get_navigation` | `url?` | `site`, `sections` containing `section` and `pages`; page fields: `title`, `url`, `markdownUrl`; unscoped `otherScopes`. Uses `docs.json` order. |
| `query_docs_filesystem` | `command`, `url?`, `locale?`, `version?` | `stdout`, `stderr`, integer `exitCode`, boolean `truncated`; `command` length: 1 to 2,000 characters. Read-only virtual filesystem. |
| `submit_feedback` | `url`, `kind`, `message`, `suggestedFix?` | `received`, `pageExists`; only available when feedback is enabled. `url` length: 1 to 2,048; `message` length: 1 to 2,000; `suggestedFix` maximum length: 2,000. `kind`: `incorrect`, `missing`, `outdated`, `unclear`, `other`. Reports can name missing pages. |

- `search_docs` and `query_docs_filesystem` scope precedence: explicit `url`, otherwise `locale` and `version` URL segments, otherwise site default.
- `list_docs` and `get_navigation` use `url` to select another locale/version tree. Unscoped `otherScopes` entries have `kind` (`version` or `locale`), `label`, optional `tag`, `url`, and page count `pages`.
- Six retrieval tools are read-only. `submit_feedback` records a report for review and does not immediately change documentation.
- `query_docs_filesystem` maps documentation URLs to paths plus `.md`; the home page is `/index.md`. Discover paths with `tree / -L 2`. Commands support pipes; each request starts at `/`.
- MCP prompts are `answer_from_docs(question)` and `implement_with_docs(task)`.
- MCP page resources use `docs://page/{path}`. OpenAPI resources use `openapi://{docId}` when specs exist. Skill resources use `skill://{name}` when skills are enabled.
- MCP `tools/list` discovers live tools; MCP `resources/list` discovers resources.
- Claude Code registration uses `claude mcp add --transport http example-docs https://docs.example.com/api/mcp`. Default scope is local to the current project for the current user. Enter `/mcp` in Claude Code to inspect the connection.
- Claude web and Claude Desktop use a remote custom connector under Customize > Connectors, with the `/api/mcp` URL and no sign-in or headers. Team/Enterprise owners add the connector under Organization settings > Connectors before members connect. Hosted connectors require a reachable server, not a laptop-only URL.
- Cursor reads project `.cursor/mcp.json` or global `~/.cursor/mcp.json`. The server entry is `{"mcpServers":{"example-docs":{"url":"https://docs.example.com/api/mcp"}}}`. Enable the server and approve tool requests if prompted.
- Other clients need remote Streamable HTTP support. Client configuration formats are not interchangeable. Plain `GET /api/mcp` provides configurations for Claude Code, Cursor, Codex, and VS Code.
- `x-margin.agents.mcpInstructions` in `docs.json` is a string of at most 4,000 characters. Generated instructions come first, authored `mcpInstructions` follows, then configured `markdown.instructions`. Inspect the combined `instructions` through plain `GET /api/mcp` after publishing.

Merge site-specific instructions into `docs.json`:

```json
{
  "x-margin": {
    "agents": {
      "mcpInstructions": "Include the documented API version when answering API questions."
    }
  }
}
```

- `/api/mcp/server-card` is the standard card, served as `application/mcp-server-card+json`, with server identity, remote endpoint, and supported protocol versions.
- `/.well-known/mcp.json` points to `/api/mcp` and `/api/mcp/server-card`.
- Compatibility cards at `/.well-known/mcp/server-card.json` and `/.well-known/mcp/server-cards.json` include tool definitions for earlier-format clients. Use live `tools/list` for active contracts.
- The site's `Link` header advertises the card through the `mcp-server-card` relation. Changing the relation URI base does not move routes.

## Not supported

- `/api/mcp` is not a local stdio server. A client limited to stdio cannot connect directly.
- `query_docs_filesystem` is not a host shell, has no network access, and cannot persist filesystem changes.
- `submit_feedback` does not edit a page immediately.
- `x-margin.agents.mcpInstructions` does not replace generated instructions, edit page content, change tool schemas, or enforce access control. Clients decide how to follow instruction text.
- The standard `/api/mcp/server-card` is not the tool endpoint and does not contain the live tool list.
- Cursor's configuration object is not a Claude Desktop configuration file.

## Errors

| Exact identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Not Found` | 404 | Wrong endpoint host/base path, or MCP disabled on deployment | Check full docs URL and MCP availability. |
| `not_found` | Tool result; not necessarily HTTP 404 | `read_page` or `get_code_examples` could not resolve the page | Discover a URL with `list_docs`; inspect `read_page` candidates or external `redirectsTo`. Tool result has `isError: true`. |
| `exitCode` nonzero | Tool result | Virtual filesystem command failed | Inspect `stderr` and discover actual paths. Tool result may set `isError: true`. |

## Verify

Probe discovery without sending an MCP tool request:

```bash
curl --silent --show-error "$DOCS_URL/api/mcp"
```

Success returns JSON with `transport: "streamable-http"`, the server `url`, `instructions`, and generated `connect` examples. Prove documentation retrieval separately by requesting `list_docs` with `{"limit":1}` and then `read_page` with the returned page URL; confirm the Markdown and URL belong to the expected site. An empty `pages` array does not confirm page retrieval.

## Related

- [Link relations](/agents/link-relations#mcp-server-card)
- [Claude Code MCP reference](https://code.claude.com/docs/en/mcp)
- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Cursor MCP reference](https://cursor.com/docs/context/mcp)
