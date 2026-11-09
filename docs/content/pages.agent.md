# Create pages with frontmatter

Create a Markdown page with the intended title, URL, and navigation visibility. Use this when adding a `.md` or `.mdx` file to a Margin docs folder.

## Do this

Run this in the repository with `DOCS_DIR` set to the folder Margin ingests. The command creates `/guides/first-request` with an explicit heading and description.

```sh
: "${DOCS_DIR:?Set DOCS_DIR to the docs folder}"
mkdir -p "${DOCS_DIR}/guides"
cat > "${DOCS_DIR}/guides/first-request.mdx" <<'EOF'
---
title: Make your first request
description: Send a request and inspect the response.
---

Run the request from your terminal, then inspect the response body.
EOF
```

Publish the file through the site's existing deployment workflow. Open `/guides/first-request` and confirm the heading is “Make your first request” and the subtitle is “Send a request and inspect the response.”

## Facts

- Margin publishes `.md` and `.mdx` files from `DOCS_DIR`; `.mdx` supports components.
- One content file is enough for a site. `docs.json`, `meta.json`, and frontmatter are optional.
- YAML frontmatter starts at the beginning of the file and uses opening and closing `---` delimiters.
- Page title precedence is frontmatter `title`, then first Markdown H1, then humanized filename.
- Filename titles split hyphens and underscores into spaces and capitalize words; recognized acronyms such as API and SDK stay uppercase.
- An `index.md` or `index.mdx` without a title or H1 uses the humanized parent directory name; root `index` falls back to `Overview`.
- URL derivation preserves directories, strips `.md` or `.mdx`, and drops a trailing `index` segment.
- `guides/first-request.mdx` resolves to `/guides/first-request`; `guides/index.mdx` resolves to `/guides`; `index.md` resolves to `/`.
- Filename `api-reference.mdx` without a title or H1 produces title `API Reference` at `/api-reference`.
- Parenthesized folders are transparent in filesystem-derived navigation: `api/(rest)/users.mdx` resolves to `/api/users`. An explicit `docs.json` navigation or `meta.json` page-list reference preserves the authored parenthesized segment.
- Leading-underscore folders are unpublished drafts unless explicitly referenced.
- Version and language roots follow configured routing prefixes.
- All derived page URLs must be unique.
- `title`: optional string, 1–255 characters; overrides the page heading.
- `sidebarTitle`: optional string, 1–255 characters; defaults to page title and changes only the navigation label.
- `description`: optional string, up to 2,000 characters; an authored value renders as a subtitle. Without `description`, the first prose paragraph supplies a shortened metadata/search excerpt, not a subtitle.
- `icon`: optional string, up to 255 characters; defaults to unset; accepts an icon name or image path for navigation.
- `tag`: optional string, 1–24 characters; defaults to unset; adds a sidebar badge.
- `hidden`: optional boolean, default `false`; `true` removes navigation visibility but keeps the URL published.
- Frontmatter `hidden: true` wins even when an explicit navigation configuration lists the page.
- `searchable`: optional boolean, default `false`; `true` keeps a hidden page eligible for search and agent indexes. Visible pages need no `searchable: true` opt-in.
- Default indexing excludes hidden pages unless `searchable: true`; a site-wide indexing policy can include hidden pages.
- `mode`: optional enum `default`, `center`, `wide`, `custom`, `frame`; defaults to `default` on ordinary pages and `wide` on API-console pages.
- `timestamp`: optional boolean; inherits `docs.json` `metadata.timestamp`, default off; controls the git-derived last-modified date.
- `sidebar_position` and `order`: optional numbers accepted in frontmatter; use `meta.json` or `docs.json` navigation for explicit sidebar order.
- `api`: optional string, default unset; `GET /users` adds a sidebar method badge only.
- `openapi`: optional string, default unset; operation forms are `[spec path] METHOD /path` and `[spec path] webhook name`, with optional spec path; attaches an API console beside authored content.
- `ogImage`: optional string; defaults to a generated Open Graph image; accepts an admitted image path or URL.
- `url`: optional string, default unset; an admitted external HTTP(S) destination becomes the navigation link and receives an HTTP `307` redirect from the internal HTML route.
- `provenance`: optional `true` or object containing `sourceUrl`; default unset; requires site `x-margin.seo.provenance`. `true` uses the configured source base URL; `sourceUrl` must be an absolute public HTTP(S) URL. Provenance does not change the canonical URL.
- `contextual`: optional object; inherits the site contextual menu unless overridden. A page override replaces the site setting. `options` accepts an array of strings or custom-option objects; `display` accepts `header` or `toc`; `options: []` disables the menu for the page.
- YAML boolean fields require booleans, such as `hidden: true`, not quoted strings.
- Unknown frontmatter keys are retained without built-in behavior.
- Explicit navigation can leave a new file unlisted without making the file URL-unreachable.

## Not supported

- Frontmatter has no supported `slug` override. Rename or move a file to change the URL; changing `title` does not change the URL.
- Frontmatter `url` does not rename the internal route; an admitted external HTTP(S) `url` redirects the HTML route.
- `api` alone does not create an API console; use an `openapi` operation reference for a console.
- `hidden: true` and index exclusion do not restrict URL access. Do not publish confidential content in a public docs folder.

## Errors

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable; ingest warning | Invalid known frontmatter value is dropped and the derived default is used. | Correct the field type, length, or admitted value. |
| `openapi_ref_unresolved` | Not applicable; ingest warning | An operation reference cannot be resolved; the page has no API console. | Correct the `openapi` operation reference. |

## Verify

After publishing, set `SITE_ORIGIN` to the docs origin and request the new route:

```sh
: "${SITE_ORIGIN:?Set SITE_ORIGIN to the docs origin}"
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  "${SITE_ORIGIN}/guides/first-request"
```

Expected output is `200`. For a hidden page, also confirm the published route loads while the sidebar omits the page.

## Related

[Configure navigation](/content/navigation)
