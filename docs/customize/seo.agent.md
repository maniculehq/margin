# Configure SEO and metadata

Configure generated page metadata, source attribution, and index membership through `docs.json` and page frontmatter. Use this when changing site identity, title formatting, static verification tags, or page discoverability.

## Do this

Run this command from the documentation repository to merge a title template, language, verification tag, and default indexing policy into `docs.json`. Replace `YOUR_VERIFICATION_TOKEN` before deploying; existing meta entries are preserved.

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path('docs.json')
config = json.loads(path.read_text())
seo = config.setdefault('seo', {})
seo['indexing'] = 'navigable'
seo['trailingSlash'] = False
extension = config.setdefault('x-margin', {})
extension.setdefault('seo', {}).update({
    'titleTemplate': '{page} | {site}',
    'language': 'en',
})
meta = extension.setdefault('head', {}).setdefault('meta', [])
meta[:] = [entry for entry in meta
           if entry.get('name') != 'google-site-verification']
meta.append({
    'name': 'google-site-verification',
    'content': 'YOUR_VERIFICATION_TOKEN',
})
path.write_text(json.dumps(config, indent=2) + '\n')
PY
```

Deploy the changed documentation using the existing deployment workflow.

## Facts

- Margin generates HTML titles, descriptions, Open Graph tags, Twitter tags, canonical links, Schema.org structured data, and a social card when no image override is supplied.
- Every property in `x-margin.seo` is optional: `titleTemplate`, `language`, `publisher`, and `provenance`.
- `x-margin.seo.titleTemplate` accepts 1–200 characters, requires `{page}` exactly once, permits `{site}` at most once, and rejects other brace tokens.
- The default title template is `{page} – {site}`. The default template avoids repeating the site name when the page title equals the site name.
- `{page}` expands to the page title. `{site}` expands to the site name.
- Page frontmatter `description` overrides the site description.
- `x-margin.seo.language` starts with 2–3 letters and permits hyphen-separated subtags of 2–8 letters or digits, such as `en-US`.
- Language precedence is active locale, configured default locale, `x-margin.seo.language`, then `en`.
- `x-margin.seo.publisher` accepts optional `type`, `name`, `legalName`, `url`, `logoUrl`, and `sameAs`.
- Publisher `type` accepts `Organization` (default) or `Person`. Publisher names accept 1–255 characters. Publisher `sameAs` is an array of identity URLs.
- Publisher name and URL default to site name and site URL; publisher logo defaults to the site logo. Footer social URLs contribute publisher identity links.
- Identity URLs require public absolute HTTP(S) URLs without credentials. Publisher `logoUrl` also accepts safe relative asset paths.
- Top-level `seo.organization` accepts `name`, `legalName`, `url`, `logo`, and `sameAs`; a populated `seo.organization` overrides `x-margin.seo.publisher`. Prefer `seo.organization` for new organization identity configuration.
- `x-margin.seo.provenance` requires `name` and `baseUrl`; optional `license` requires `name` and `url`. Source and license names accept 1–255 characters. Provenance `baseUrl` cannot have a query or fragment.
- Site provenance alone does not attribute pages. Page frontmatter `provenance: true` opts in and appends the served page path to the provenance base URL.
- Page frontmatter `provenance: { sourceUrl: "https://upstream.example.com/docs/install" }` specifies a different source URL. Both provenance forms require valid site provenance.
- Opted-in provenance emits visible source attribution and structured-data `isBasedOn`, with a license link when configured. Provenance never changes canonical URLs.
- `x-margin.head.meta` is an array of objects with required string `content` and optional string `name` and `property`.
- Static site meta tags render before generated page tags. Generated tags win conflicts on the same name or property.
- Canonical URLs combine the public site URL, deployment base path, and served page path, including locale and version prefixes.
- Top-level `seo.trailingSlash` defaults to `false`; `true` adds trailing slashes to page URLs.
- Markdown representations send an HTML canonical `Link` header and `X-Robots-Tag: noindex`.
- Top-level `seo.indexing` accepts exactly `navigable` (default) and `all`.
- Under `navigable`, non-hidden pages and hidden pages with frontmatter `searchable: true` are indexable.
- Under `navigable`, frontmatter `hidden: true` plus `searchable: false` excludes an authored page from indexing. Excluded pages remain reachable and crawlable, emit `noindex,follow`, and stay out of the XML sitemap, site search, and LLM indexes.
- Under `all`, all authored pages are indexable, including hidden pages. Synthesized landing pages remain non-indexable in either mode.
- `/sitemap.xml` contains absolute HTML URLs and modification timestamps for indexable pages across versions and locales; external-link redirect pages are excluded.
- With multiple visible locales, `/sitemap.xml` includes served language alternates.
- `/robots.txt` permits crawling and advertises the sitemap.
- Preview responses use `noindex,nofollow` and `no-store`.

## Not supported

- No per-page canonical URL override exists. `seo.metatags.canonical` is ignored.
- `seo.organization.id` cannot override generated structured-data identifiers.
- `x-margin.head.meta` cannot inject scripts, styles, or stylesheet links, or replace generated canonical links.
- Custom robots meta tags do not control sitemap, site-search, or LLM-index membership.
- Frontmatter `searchable: false` alone does not exclude a visible page.
- Frontmatter `hidden: true` does not exclude authored pages under `seo.indexing: "all"`.

## Errors

These identifiers are ingest diagnostics, not HTTP errors.

| Exact identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable | Invalid title template or malformed nested SEO property. | Use the documented shape; invalid templates fall back to the default and malformed nested properties are dropped independently. |
| `head_rejected` | Not applicable | Executable head markup or site-wide `seo.metatags.canonical`. | Use static meta data and generated per-page canonical URLs. |

## Verify

After deploying, replace the public docs root and page path, including a base path in `SITE_URL` when applicable. Fetch the rendered page and discovery files:

```bash
SITE_URL='https://docs.example.com'
PAGE_PATH='/guides/setup'
curl --fail --silent --show-error "$SITE_URL$PAGE_PATH"
curl --fail --silent --show-error "$SITE_URL/sitemap.xml"
curl --fail --silent --show-error "$SITE_URL/robots.txt"
```

Successful HTML contains the configured title, verification meta tag, and self-canonical link. An excluded page contains `noindex,follow` and has no URL entry in `/sitemap.xml`.
