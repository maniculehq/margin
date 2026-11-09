# Discover pages with llms.txt

Fetch a scoped page index or an aggregate Markdown export from a Margin documentation site. Use the index to choose relevant pages, or the full export when the task needs many page bodies.

## Do this

Replace the example URL with the documentation site's public URL, including its base path if configured, then download the site-root index:

```sh
DOCS_URL='https://docs.example.com'
curl --fail --silent --show-error \
  "$DOCS_URL/llms.txt" \
  --output llms.txt
cat llms.txt
```

Read the returned descriptions and fetch the returned page links relevant to the task. Follow version, language, and sub-index links exactly as returned instead of deriving their names.

## Facts

- Margin generates `/llms.txt` and `/llms-full.txt` by default.
- `/llms.txt` lists indexable pages with titles, links, and page descriptions when available; URL reachability alone does not guarantee inclusion.
- `/llms.txt` starts with the site name and the site description when configured.
- `/llms.txt` groups entries by navigation and preserves authored navigation order rather than alphabetical order.
- Local page entries in `/llms.txt` link to `.md` routes; external-pointer entries link directly to their destinations.
- `/llms.txt` lists release-history links under `Optional`, alongside the full-export link and recent-changes link when enabled.
- The site-root `/llms.txt` links configured alternate versions and languages through scoped indexes.
- `/llms.txt` links available OpenAPI documents under `API specifications` unless `markdown.schema` is `false`.
- An index exceeding 100,000 characters becomes a directory of sub-index links under the scope's `/_llms/` path; sub-indexes can split further, and flat lists can split into numbered parts.
- `/llms-full.txt` aggregates agent-facing Markdown with a 4,000,000-character budget, stops between pages, and places release-history pages last.
- A truncated `/llms-full.txt` contains a comment with `llms-full.txt truncated`; fetch omitted pages individually using `/llms.txt`.
- `/llms.txt` and `/llms-full.txt` support path-segment scoping; scoped files include only indexable pages whose served URL begins with the requested segment sequence.
- `/v1/llms.txt` and `/v1/llms-full.txt` illustrate version scoping for a configured `v1` label.
- `/fr/llms.txt` and `/fr/llms-full.txt` illustrate locale scoping for a configured non-default `fr` locale.
- `/fr/v1/llms.txt` and `/fr/v1/llms-full.txt` illustrate combined scoping with locale before version.
- `/guides/llms.txt` and `/guides/llms-full.txt` illustrate documentation-subtree scoping.
- Version scope uses the public version label, not the source-directory name.
- A leading configured non-default locale tag selects the locale; otherwise Margin uses the default locale. Locale tags take precedence over same-named version labels.
- After locale selection, a matching leading local version label selects the version. Otherwise Margin selects the configured default version, or the first local version when no default is marked.
- A default version spanning the repository root uses the unprefixed tree.
- Locale and version selection defaults do not remove the requested path filter.
- `x-margin.agents.indexPreamble` in `docs.json` defaults to `true` and controls the generated `Documentation Index` blockquote at the beginning of standalone Markdown page responses.
- The Markdown index preamble links the page's own version-and-locale index and full export, plus the MCP server and agent-surface manifest.

Merge this fragment into `docs.json` to disable the standalone Markdown index preamble:

```json
{
  "x-margin": {
    "agents": {
      "indexPreamble": false
    }
  }
}
```

## Not supported

- `x-margin.agents.indexPreamble` accepts a boolean, not custom preamble text.
- `x-margin.agents.indexPreamble: false` does not disable `/llms.txt` or `/llms-full.txt` and does not change their page listings.
- A successful `/llms-full.txt` download does not guarantee that every indexed page fit within the export budget.
- An unknown scoped prefix does not fall back to the unscoped index.

## Errors

| Exact response body | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Not Found` | 404 | No indexable pages exist beneath the requested nonempty scope. | Fetch `/llms.txt` and follow a returned scope link. |

## Verify

Inspect the downloaded index for the site heading and page or sub-index links:

```sh
head -n 30 llms.txt
```

A successful index starts with `#` and the site name. Page entries have the form `- [Title](URL): Description`, with the description omitted when absent; a split index links sub-indexes instead of listing every page.
