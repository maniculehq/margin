# Redirect moved pages

Preserve old documentation URLs by adding redirect rules to `docs.json`. Use redirects after moving pages or while temporarily routing visitors to another page.

## Do this

Publish `/quickstart` and remove the page at `/getting-started`. Merge this top-level field into the existing `docs.json`, then deploy the documentation:

```json
{
  "redirects": [
    {
      "source": "/getting-started",
      "destination": "/quickstart"
    }
  ]
}
```

Inspect ingest warnings before testing the deployed URL. The canonical rule returns HTTP `308` with a `Location` pointing to `/quickstart` on the documentation site.

## Facts

- `docs.json.redirects` is an array of objects with required string `source`, required string `destination`, and optional boolean `permanent`.
- Omitted `permanent` and `permanent: true` select HTTP `308`; `permanent: false` selects HTTP `307`.
- Permanent redirects suit completed page moves; temporary redirects suit moves where the original URL will be restored.
- Internal redirect paths use site-root paths without file extensions; ingest adds a leading slash and removes a trailing slash except for `/`.
- Internal destinations ending in `/index` normalize to the parent route.
- External destinations can use `http://` or `https://`.
- Destination queries and fragments are supported.
- Incoming query strings carry through unless the destination already has a query; the destination query takes precedence.
- Source matching is case-sensitive.
- `/old/:page` captures one nonempty segment; `/new/:page` substitutes the segment.
- `/old/:slug*` captures the remaining path, including multiple segments or an empty remainder; `/new/:slug*` substitutes the remainder.
- `/old/*` captures the remaining path, including an empty remainder; `/new/*` substitutes the remainder.
- `/old/article-*` captures the suffix after `article-` in the final segment; `/new/article-*` substitutes the suffix.
- Named captures start with a letter or underscore; remaining characters can include letters, digits, underscores, and hyphens.
- Rest captures and partial wildcards must occupy the final source segment.
- `:splat` is a rest capture. Rest captures support substitution with the original token, `*`, or `:splat`.
- Destination queries and fragments can reuse captured text; destinations can omit captures to collapse matching sources to one destination.
- Exact source matches precede patterns regardless of array position; the first matching pattern in declaration order wins.
- Duplicate exact sources use the first rule.
- An internal exact destination must resolve to a published page or a retained redirect.
- A destination pattern is admitted when at least one published page matches the destination pattern or the destination resolves through a retained redirect.
- Ingest drops invalid individual rules with warnings rather than stopping publication.
- Redirect loop validation uses a 32-rule traversal cap.

For a directory move with an exact exception, merge this alternative array into `docs.json`:

```json
{
  "redirects": [
    {
      "source": "/legacy/:slug*",
      "destination": "/guides/:slug*"
    },
    {
      "source": "/legacy/install",
      "destination": "/quickstart"
    }
  ]
}
```

The directory example maps `/legacy/install` to `/quickstart` and `/legacy/auth/setup` to `/guides/auth/setup`.

## Not supported

- Sources cannot contain URL schemes, queries, or fragments.
- Destination schemes other than HTTP and HTTPS, such as `mailto:` and `javascript:`, are rejected.
- `permanent` does not accept strings such as `"false"`.
- Rest wildcards cannot precede another source segment: `/old/*/details` is invalid.
- Destination paths cannot substitute absent captures: `/old/:page` to `/new/:missing` is invalid.
- Redirects cannot replace published pages; ingest drops any source pattern that matches a published page.
- Destination-pattern validation does not guarantee that every wildcard substitution names an existing page.
- External destinations are not checked for a published internal page; test external availability separately.

## Errors

Diagnostics occur during ingest, not as HTTP error responses. Inspect ingest output for the source or `redirects` array index.

| Exact diagnostic identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | N/A | Missing or non-string `source` or `destination`, or non-boolean `permanent` | Correct field types |
| `redirect_invalid` | N/A | Invalid scheme, source pattern, or destination capture mapping | Correct syntax and use captures present in the source |
| `redirect_invalid` | N/A | Missing internal destination | Publish the target or point to a retained redirect |
| `redirect_invalid` | N/A | Loop or chain reaching the 32-rule traversal cap | Point directly to the final destination |
| `redirect_shadows_page` | N/A | Source matches a published page | Remove or move the old page |

## Verify

Set `DOCS_ORIGIN` to the deployed documentation origin and request the old path without following redirects:

```sh
export DOCS_ORIGIN="https://docs.example.com"
curl --silent --show-error \
  --dump-header - \
  --output /dev/null \
  "$DOCS_ORIGIN/getting-started"
```

The canonical configuration returns status `308` and a `Location` header pointing to `/quickstart` on the documentation site. Setting `permanent: false` changes the expected status to `307`. Test a representative nested path for every wildcard rule and open each destination to confirm the page exists.
