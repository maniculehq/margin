# Configure product documentation versions

Publish `v1` and `v2` documentation in separate directory-backed release trees and choose `v2` as the default. Use product versions when readers need documentation for different product releases, not when editing a paragraph.

## Do this

1. Inside the docs folder, create `v1/index.mdx`, `v1/guide.mdx`, `v2/index.mdx`, and `v2/guide.mdx` with release-appropriate content.
2. Set the version navigation and default in `docs.json`. Preserve unrelated configuration when editing an existing site.

Use this complete minimal configuration for a new site:

```json
{
  "name": "Acme",
  "navigation": {
    "versions": [
      {
        "version": "v1",
        "directory": "v1",
        "pages": ["v1/index", "v1/guide"]
      },
      {
        "version": "v2",
        "directory": "v2",
        "pages": ["v2/index", "v2/guide"]
      }
    ]
  },
  "x-margin": {
    "versions": {
      "default": "v2"
    }
  }
}
```

3. Remove competing `meta.json` default flags or navigation `default: true` fields if `x-margin.versions.default` should control selection.
4. Add the following relative link to both `v1/index.mdx` and `v2/index.mdx`.

The relative link resolves to the guide in the source file's release:

```md
[Read the guide](./guide)
```

5. On a self-hosted checkout with the database configured, run ingest from the checkout root.

This command ingests the `docs` folder:

```sh
bun run ingest \
  --dir ./docs
```

6. Inspect ingest warnings, correct missing targets in the named source files, and re-ingest.

## Facts

- A product version controls the documentation release tree and published URL prefix.
- A content version is an immutable documentation snapshot associated with a deployment; one content snapshot can contain multiple product versions.
- `navigation.versions[].version` is required and supplies the version label and URL segment.
- `navigation.versions[].directory` assigns files under a source directory to a product version.
- Navigation page references use source paths relative to the docs folder without file extensions, not paths relative to the version directory.
- Unlisted pages remain URL-reachable.
- Optional version fields are `href`, `default`, `hidden`, `tag`, `directory`, `openapi`, `asyncapi`, `languages`, `tabs`, `groups`, `pages`, and `global`.
- `hidden: true` removes a release from the switcher without disabling release URLs.
- `tag` adds a switcher badge.
- An external `href` without an assigned or discovered local directory links to an external documentation site.
- Margin also discovers version directories under `versions/`, explicit `meta.json` version markers, and sibling version directories such as `v1/` and `v2/`.
- `x-margin.versions.default` takes effect only when the value matches a discovered version label.
- Default priority is `meta.json` `x-margin-version-default: true`, then navigation `default: true`, then `x-margin.versions.default`, then the highest naturally sorted label.
- Multiple default flags at the winning priority select the highest naturally sorted flagged label.
- Directory-backed default releases retain the version prefix.
- Files outside version directories keep unprefixed URLs and are shared across version trees.
- A release spanning the docs root uses unprefixed URLs instead of directory-backed version URLs.
- The version switcher links to release landing pages, not counterpart pages; switching from `/v1/guide` to `v2` opens `/v2`, even without a counterpart guide.
- The switcher trigger label uses the default release or the first visible release when the default is not visible.
- Relative body links resolve against source directories and are rewritten to published URLs.
- `./guide` in `v1/index.mdx` becomes `/v1/guide`; `./guide` in `v2/index.mdx` becomes `/v2/guide`.
- `/v2/guide` explicitly targets `v2`; root-relative version URLs do not follow release selection.
- Ingest validates internal links against release-specific served URLs and shared pages, with fallback checks against the default release; existing explicit release URLs are also valid.
- A successful default-release fallback check does not prove that the target exists in the original release.

## Not supported

- `x-margin.versions.default` does not declare a new product version or create release files.
- Selecting a default directory-backed release does not remove the release URL prefix.
- Editing page content does not create a product release.
- The switcher does not preserve the current page path when selecting another release.
- Broken internal links do not fail ingest; broken internal links produce warnings.

## Errors

Diagnostics below are ingest diagnostics, not HTTP errors.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `version_no_default` | Not applicable | No matching explicit default; highest naturally sorted label inferred. Info severity. | Set `x-margin.versions.default` to a discovered label or mark one release default. |
| `version_multiple_default` | Not applicable | Multiple releases flagged default at the winning priority. Warning severity. | Retain one default flag at the winning priority. |
| `link_broken` | Not applicable | Internal link unresolved by release, shared, and fallback checks. Warning message is `broken internal link: <link>` with the source file path. | Add the missing release page or correct the link; use an explicit cross-release URL only intentionally. |

## Verify

Run `bun run ingest --dir ./docs` on the configured self-hosted checkout and inspect warnings. Then open these URLs with no language prefix:

| Source | Expected URL | Expected release |
| --- | --- | --- |
| `v1/index.mdx` | `/v1` | `v1` |
| `v1/guide.mdx` | `/v1/guide` | `v1` |
| `v2/index.mdx` | `/v2` | `v2`, default |
| `v2/guide.mdx` | `/v2/guide` | `v2`, default |

Confirm each sidebar lists the intended release pages. Follow the guide link in each landing page and confirm the destination URL and release content; select `v2` from `/v1/guide` and confirm navigation to `/v2`.

## Related

- [Configure languages](/organize/languages)
- [Generate API documentation](/organize/openapi)
