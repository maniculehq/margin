# Configure documentation search

Set `x-margin.search.mode` in `docs.json` to choose the site's search interface. Use this configuration when selecting AI-assisted search, plain text search, or no search interface.

## Do this

Merge this fragment into the existing `docs.json`, preserving other fields, to select static search:

```json
{
  "x-margin": {
    "search": {
      "mode": "static"
    }
  }
}
```

Publish the change through the site's normal deployment process.

## Facts

- `x-margin.search` is an object with an optional `mode` field.
- `x-margin.search.mode` accepts exactly `ai`, `static`, or `off`.
- Omitting `x-margin.search.mode`, `x-margin.search`, or `x-margin` selects `ai`.
- `ai` provides documentation search and an assistant that cites source pages.
- `ai` falls back to the static interface when the deployment lacks assistant credentials.
- Self-hosted deployments outside Vercel use the server environment variable `AI_GATEWAY_API_KEY` for assistant access.
- Vercel deployments can use Vercel OIDC authentication and require AI Gateway access enabled for the deployment.
- Assistant credentials belong in the server environment, not `docs.json`.
- `static` searches indexed page titles, headings, and content without assistant controls or AI credentials.
- `off` removes the search dialog and assistant controls.
- Text search and the assistant's documentation search use the current page's version and locale scope.
- A recognized non-default locale prefix selects the search locale; a path without a locale prefix selects the default locale.
- A recognized version prefix selects the product version within the selected locale; an unprefixed path selects the locale's default version.
- Margin selects the first local version when no version is marked as default and a local version exists.
- Search includes pages assigned to the selected version and shared pages without a product-version assignment, within the selected locale.
- Search excludes pages assigned to other product versions or locales.
- Hidden pages marked `searchable` remain eligible for indexing; site-wide `seo.indexing: "all"` also includes hidden pages.
- Synthesized pages are excluded from search indexing.

## Not supported

- `x-margin.search.mode: "off"` does not disable `/api/search` and is not a content-access restriction.
- AI mode does not broaden documentation search to all product versions or locales.
- Search does not substitute default-locale pages for missing translations.
- Empty results do not trigger a search across other versions or locales.
- The missing-credential fallback does not guarantee that failed model requests become text-search results.
- Hiding a page from navigation does not necessarily remove the page from search.

## Verify

Open search on the deployed site and query a known page title. Static mode should return matching pages without assistant controls; AI mode with working AI Gateway access should also offer the assistant; off mode should have no search dialog.

Search for a term unique to one version or locale, switch the version or language, and repeat the query to confirm scope. Shared pages can appear in results for multiple product versions.
