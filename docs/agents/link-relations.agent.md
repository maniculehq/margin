# Discover resources through link relations

Find documentation indexes, the MCP Server Card, and the skill manifest from HTTP `Link` headers. Use discovery when resource paths or the site's base path should not be hard-coded.

## Do this

Request a documentation page with GET, save response headers, and record the final response URL after redirects. Replace the example URL with the documentation page to inspect.

```bash
DOCS_URL='https://margin.manicule.com/'
curl --silent --show-error --location \
  --dump-header /tmp/margin-discovery.headers \
  --output /dev/null \
  --write-out '%{url_effective}\n' \
  "$DOCS_URL"
cat /tmp/margin-discovery.headers
```

Read the final response's `Link` fields. Select a link whose space-separated `rel` identifiers include the desired bare token or complete extension relation URI. Use an RFC 8288-aware parser for automation; do not split blindly on commas or compare the whole `rel` string to one identifier.

The following illustrative header advertises the compact index:

```http
Link: </llms.txt>; rel="describedby llms-txt https://github.com/maniculehq/margin/blob/main/docs/link-relations.md#llms-txt"; type="text/plain"; title="LLM index"
```

Copy the selected target without angle brackets into `LINK_TARGET`; copy the final response URL into `RESPONSE_URL`. The values below correspond to the illustrative header and must be replaced with the actual response values. Resolve the target and fetch the resource:

```bash
RESPONSE_URL='https://margin.manicule.com/'
LINK_TARGET='/llms.txt'
TARGET_URL="$(python3 -c \
  'import sys; from urllib.parse import urljoin; print(urljoin(sys.argv[1], sys.argv[2]))' \
  "$RESPONSE_URL" "$LINK_TARGET")"
curl --fail --silent --show-error --location \
  "$TARGET_URL"
```

## Facts

- Margin emits bare compatibility tokens and complete extension relation URIs in each applicable `rel` parameter.
- An extension relation URI equals `DOCS_LINK_RELATION_BASE` followed by the bare token.
- The default `DOCS_LINK_RELATION_BASE` is `https://github.com/maniculehq/margin/blob/main/docs/link-relations.md#`.
- Complete extension relation URIs must be compared as whole values, not by fragment alone.
- A deployment can change `DOCS_LINK_RELATION_BASE` without changing resource routes.
- `Link` fields can be separate or combined; one quoted `rel` parameter can contain multiple space-separated identifiers.
- Margin emits root-relative targets including the site's base path; `/llms.txt` becomes `/docs/llms.txt` for a site mounted at `/docs`.
- Relative targets resolve against the final response URL after redirects. Root-relative targets replace the path; path-relative targets resolve from the response URL's directory; absolute targets already name their location.
- Margin adds discovery links to GET and HEAD responses with status codes from 200 through 299 and content types containing `text/html`, `text/markdown`, or `text/plain`.
- Disabled surfaces are omitted from discovery links.

Exact relation tokens and default root-mounted targets are:

| Bare token and URI suffix | Target | Media type | Resource |
| --- | --- | --- | --- |
| `llms-txt` | `/llms.txt` | `text/plain` | Compact index with page links and summaries; also has relation `describedby`. |
| `llms-full-txt` | `/llms-full.txt` | `text/plain` | Documentation bodies; serving budgets can limit coverage. |
| `mcp-server-card` | `/api/mcp/server-card` | `application/mcp-server-card+json` | Card describing the public Streamable HTTP endpoint. |
| `agent-skills` | `/.well-known/agent-skills/index.json` | `application/json` | Manifest linking to admitted `SKILL.md` files and supporting content. |

## Not supported

- Discovery headers are not guaranteed on JSON API responses, redirects, or errors.
- An absent relation is not proof that a resource does not exist. Retry on a successful documentation page; consult site configuration or documentation if the relation remains absent.
- Relation URIs identify purpose, not the resource URL to fetch. Fetch the angle-bracketed target.
- `describedby` alone does not uniquely select `/llms.txt`; Margin also uses `describedby` for the JSON corpus manifest.
- The MCP Server Card is not a fixed live-tool list. Discover live tools through MCP.

## Verify

Repeat the resolved target fetch and inspect the returned content:

```bash
curl --fail --silent --show-error --location \
  "$TARGET_URL"
```

The `llms-txt` target returns plain text containing documentation links. The `mcp-server-card` and `agent-skills` targets return their respective JSON resources.
