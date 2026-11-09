# Control documentation navigation

Configure Margin's sidebar from files and per-directory metadata, or replace that structure with an explicit `docs.json.navigation` block. Use explicit navigation when reader-facing groups do not match the directory tree.

## Do this

Run from the documentation root containing `index.mdx`, `guides/quickstart.mdx`, and `guides/authentication.mdx`. The command preserves other `docs.json` fields and replaces the entire `navigation` value; review existing navigation before running it.

```sh
python3 - <<'PY'
import json
from pathlib import Path

for name in ('index.mdx', 'guides/quickstart.mdx', 'guides/authentication.mdx'):
    if not Path(name).is_file():
        raise SystemExit(f'Missing required page: {name}')

path = Path('docs.json')
config = json.loads(path.read_text()) if path.exists() else {}
config['navigation'] = {
    'groups': [{
        'group': 'Start',
        'pages': [
            'index',
            'guides/quickstart',
            {'group': 'Account', 'pages': ['guides/authentication']}
        ]
    }]
}
path.write_text(json.dumps(config, indent=2) + '\n')
PY
```

Deploy the changed documentation configuration using the existing deployment workflow.

## Facts

- `docs.json` belongs at the documentation root.
- An absent `docs.json.navigation` uses filesystem navigation; the existence of `docs.json` alone does not select explicit navigation.
- A present `docs.json.navigation` replaces filesystem and `meta.json` navigation structure site-wide, including membership, order, folder labels, icons, and tab definitions.
- An empty `docs.json.navigation` object does not request filesystem navigation; remove the property to restore filesystem navigation.
- Navigation configuration does not rename page URLs or override per-page frontmatter.
- Filesystem navigation sorts entries by title, case-insensitively, with the directory's `index` page first.
- Filesystem folder labels use `meta.json.title`, otherwise a humanized directory name.
- `meta.json.pages` references are relative to the containing directory and omit file extensions; a folder name references a child folder.
- `meta.json` affects its containing directory, not sibling directories.
- `meta.json.pages` entries support named references, `...` for remaining entries, `z...a` for reversed remaining entries, `...folder` for flattening, and `!name` for exclusion.
- `meta.json.pages` supports `---Label---` and `---` separators and `[Text](https://example.com)` links.
- Without a rest entry in `meta.json.pages`, unlisted pages disappear from navigation but remain reachable by URL.
- Filesystem folder settings include `icon`, `defaultOpen`, `collapsible`, and `root`; explicit navigation supplies its own structure instead.
- `navigation.pages` declares ungrouped ordered entries; `navigation.groups` declares labeled groups.
- A group uses `group` for its label and `pages` for ordered children; group options include `root` (landing-page reference), `icon`, `expanded`, `hidden`, and `searchable`.
- Explicit navigation page references are extensionless paths relative to the documentation root, such as `guides/quickstart`.
- Explicit navigation `pages` entries accept strings, `{ "href": "…" }` references, or nested group objects.
- An omitted explicit-navigation page remains URL-reachable but is hidden from navigation.
- `hidden: true` in page frontmatter hides the page even when explicit navigation lists the page.
- A configured group's or tab's `hidden: true` hides the container's pages without removing their URLs.
- Page frontmatter `hidden: true` with `searchable: true` keeps an unlisted page eligible for search; a group's `searchable` setting can keep its hidden pages eligible for search.
- A leading-underscore draft folder is unpublished unless explicitly referenced in `navigation` or `meta.json.pages`.
- Filesystem `meta.json.root: true` makes a directory a tab; no tab roots or configured tabs means a single sidebar.
- Configured tabs use the required `tab` label and can contain `groups` or `pages`; tab options include `icon`, `hidden`, and external `href`.
- A tab with external `href` renders as a link rather than a content section.
- Tabs appear in the top bar by default; `x-margin.layout.tabMode: "auto"` places tabs in the sidebar.
- Anchors use the required `anchor` label; anchor options include `href`, `icon`, `color`, and `hidden`.
- An anchor containing only `href` is a navigation link; an anchor containing `groups` or `pages` behaves as a documentation section like a tab.
- `navigation.global.anchors` supplies persistent links across sections.
- Dropdowns use the required `dropdown` label and support child `groups`, `pages`, `tabs`, and `anchors`; dropdown options include `icon`, `description`, `color`, `hidden`, and `href`.
- An `href`-only dropdown renders as a plain link, not an empty menu.

## Not supported

- Navigation hiding is not access control; omitted and hidden published pages remain available by URL.
- Explicit navigation does not merge filesystem or `meta.json` structure into unconfigured portions of the sidebar.
- A reference in navigation does not create a missing page.
- Leading-underscore folders do not guarantee confidentiality: explicit references can publish their pages.

## Errors

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` with `Navigation references a page that does not exist: <reference>.` | Not applicable; build warning | A navigation page reference does not resolve. | Correct the root-relative path or add the page file. |

## Verify

After deployment, replace the example origin and retrieve the navigation as Markdown:

```sh
curl --fail --silent --show-error 'https://docs.example.com/sitemap.md'
```

A successful response contains Markdown links for visible pages. Open each configured tab or dropdown to check the destination and sidebar order; open an omitted page's direct URL separately to confirm that omission did not remove the route. If a listed page is absent, inspect page frontmatter and ancestor containers for `hidden: true`, then inspect build diagnostics for missing references.
