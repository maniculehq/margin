# Configure documentation languages

Publish separate authored pages and navigation trees for each locale with `navigation.languages` in `docs.json`. Use matching relative page paths to support language switching, including pages within product versions.

## Do this

Create separate locale roots in the documentation source directory, with a home page and an introduction in each root:

```text
docs.json
en/
  index.mdx
  intro.mdx
es/
  index.mdx
  intro.mdx
```

Set the following configuration in `docs.json`:

```json
{
  "name": "Example docs",
  "navigation": {
    "languages": [
      {
        "language": "en",
        "default": true,
        "directory": "en",
        "groups": [
          { "group": "Start", "pages": ["en/index", "en/intro"] }
        ]
      },
      {
        "language": "es",
        "directory": "es",
        "groups": [
          { "group": "Primeros pasos", "pages": ["es/index", "es/intro"] }
        ]
      }
    ]
  }
}
```

Author English content in `en/` and Spanish content in `es/`, then publish. Keep the relative filename `intro.mdx` in both roots even if the titles differ.

## Facts

- `navigation.languages[].language` identifies the locale; non-default locales use the language tag as the first URL segment.
- `navigation.languages[].directory` identifies the source root; page references remain documentation-root-relative, such as `es/intro`, not locale-root-relative.
- Language entries can contain `groups`, `pages`, `tabs`, and `versions` navigation children.
- The first language entry with `default: true` is selected as the default locale; without an explicit default, the first language entry is selected.
- The default locale has no locale prefix, including when the default locale has an explicit source directory.
- An omitted `directory` is inferred from the common directory of page references, including references nested under versions.
- A non-default locale with no derivable content directory is skipped from locale serving with a `locale_unpartitioned` warning.
- Product-version configuration belongs inside each language entry when each locale needs its own version tree.
- URL prefix order is locale tag, then product-version label, then remaining page path.
- A default product version in its own directory retains the version prefix; a default product version spanning the locale root has no version prefix.
- Published paths are relative to the documentation origin and any site base path.
- Counterparts match the page path remaining after locale and version prefixes are removed.
- Locale switching prefers the same version label in the destination locale. If the current page belongs to the default version and the label is unavailable, counterpart matching uses the destination locale's default version.
- Unversioned pages remain unversioned during counterpart matching.
- A missing non-default version does not fall back to another release's counterpart.
- Only existing pages qualify as translated counterparts.
- A missing counterpart sends the language selector to the destination locale home; a non-default locale without an authored home uses its first navigation landing link.
- Only existing counterparts receive `hreflang` alternates. Home-page fallbacks are not translation alternates.
- `hidden: true` on a locale omits the locale from the language selector and counterpart alternates.

With English as the default locale, use these mappings. Versioned rows require a version labeled `v1` in the indicated directory:

| Source file | Published path |
| --- | --- |
| `en/intro.mdx` | `/intro` |
| `es/intro.mdx` | `/es/intro` |
| `en/v1/intro.mdx` | `/v1/intro` |
| `es/v1/intro.mdx` | `/es/v1/intro` |

## Not supported

- Locale directories do not automatically translate authored content.
- Counterpart matching does not require translation-link frontmatter or a component.
- Different relative page names, such as `intro` and `introduccion`, do not automatically match as translated counterparts.
- Source directories are not necessarily the published URL prefixes.

## Verify

Replace the example base URL with the documentation origin and any site base path, then request the unversioned pages:

```sh
DOCS_BASE_URL="https://docs.example.com"
curl --fail --location "$DOCS_BASE_URL/intro"
curl --fail --location "$DOCS_BASE_URL/es/intro"
```

Both requests should return rendered page HTML. In a browser, confirm each page has the intended language and sidebar, and test the language selector in both directions.

For directory-backed `v1` pages, open `/v1/intro` and `/es/v1/intro` and repeat the selector test. Also test a page without a translation: the selector should reach the destination locale home or navigation landing page, not a nonexistent counterpart.

## Related

[Configure documentation versions](/organize/versions)
