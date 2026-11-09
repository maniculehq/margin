# Publish existing Mintlify documentation with Margin

Publish a Mintlify documentation tree without converting `docs.json` or rewriting MDX first. Use this migration path when retaining existing source files, then review rendering and compatibility diagnostics before replacing the current deployment.

## Do this

1. Keep `docs.json` at the documentation folder's root. Retain MDX, snippets, local images, and OpenAPI files with relative paths intact.
2. Review configuration compatibility. Identify adapted settings and ignored features that need attention when checking the rendered site.
3. [Deploy the repository on Manicule](/deploy/manicule), free, with no limits. No servers or environment variables are required, and the database is included. Every push to the docs branch publishes, and pull requests get previews. Open a representative page containing navigation, branding, and a component or image. Follow links and compare light and dark appearance where configured. Review migration diagnostics and rendered differences before changing the public documentation address.

[Self-hosting](/deploy/self-host) is the alternative. Complete the shared framework setup in [Quickstart](/quickstart), place the existing documentation tree in the framework's `docs/` directory, replacing its example documentation, or set `DOCS_DIR` to the existing build-accessible folder. Publish with the framework's configured deployment build.

## SDK

No SDK is required for this repository migration.

## Facts

- Manicule hosting is free, with no limits; no servers or environment variables are required, and the database is included.
- Every push to the docs branch publishes on Manicule, and pull requests get previews.
- Manicule hosting and self-hosting use the same repository and `docs.json`; Margin is Apache 2.0 licensed.
- Source acceptance does not guarantee identical presentation or support for every Mintlify feature.
- Self-hosted framework deployments require the Margin server, build scripts, and database integration; a docs-only Mintlify repository does not contain the runtime.
- Self-hosted framework deployments accept documentation in `docs/` or the build-accessible folder selected by `DOCS_DIR`.
- Margin reads `mint.json` as a legacy fallback when `docs.json` is absent.
- Supported configuration retains documented Mintlify behavior; examples include `name`, `colors`, `logo`, `favicon`, `navigation`, and `redirects`.
- Explicit `navigation` controls visible navigation; omitted pages remain reachable by URL.
- Adapted configuration maps to a Margin implementation with different presentation or behavior.
- `theme` selects a framework-owned layout preset, not an exact reproduction of Mintlify's layout.
- `appearance.default` selects the default color mode; `appearance.strict: true` disables the theme switch.
- Page-frontmatter `mode` accepts `default`, `center`, `wide`, `custom`, and `frame` as Margin layout classes.
- `background.decoration` accepts `gradient`, `grid`, and `windows` as Margin-owned decorations.
- Ignored fields parse but have no runtime effect and receive diagnostics.
- Self-hosted framework ingest prints warning and error entries in terminal or deployment build output, with affected paths when available.
- Complete diagnostics are stored with the ingested content version; the ingest CLI does not print informational entries.
- Margin sanitizes SVGs and stylesheets; inspect custom styling after migration.
- `x-margin` is optional; migrating does not require an `x-margin` block.
- `x-margin.search.mode` accepts `ai`, `static`, and `off`; AI search also requires AI Gateway access.
- `x-margin.layout.sidebarWidth` sets a sidebar dimension, not a replacement layout engine.
- Supported extensions include `x-margin.tokens`, `x-margin.css`, `x-margin.seo.titleTemplate`, and `x-margin.agents.mcpInstructions`.
- `x-margin.agents.mcpInstructions` appends instructions to the MCP server's generated instructions.
- Supported remote asset resolution can require an allowed host through `x-margin.assets.allowExternal`.

To select static search and a sidebar width, merge this block into existing `docs.json`, preserving other fields:

```json
{
  "x-margin": {
    "search": { "mode": "static" },
    "layout": { "sidebarWidth": "300px" }
  }
}
```

## Not supported

- `public` does not restrict access; served documentation is public.
- `api.asyncapi` and `api.mdx` are accepted but have no runtime effect.
- Google Tag Manager configuration is not executed.
- An accepted integration provider does not imply support for arbitrary script origins or executable containers.
- Unknown top-level and `x-margin` keys have no runtime effect.
- Unrecognized components do not retain their layout or interaction merely because their children render.
- A successful build does not prove that every field took effect or every image resolves.

## Errors

These identifiers are ingest diagnostics, not HTTP errors. Unparseable JSON and unsafe content can fail the build.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `unknown_field` | Not applicable | Unknown configuration key. | Remove the key or replace it with a supported setting. |
| `unsupported_field` | Not applicable | Recognized field has no implementation. | Remove the field or configure a supported replacement. |
| `field_invalid` | Not applicable | Invalid value on a known configuration field; the field can fall back independently. | Correct the value; valid siblings need not be removed. |
| `component_unknown` | Not applicable | Unrecognized component was replaced by its children. | Use a supported built-in or supported local snippet component. |
| `asset_missing` | Not applicable | Asset reference could not be resolved; the URL can remain unchanged. | Correct paths, keep local assets inside the docs folder, and check allowed hosts for supported remote resolution. |

## Verify

Open a published page containing navigation, branding, and a component or image. Success means the page renders, links reach their intended pages, images load, and adapted presentation is acceptable; a build success alone is insufficient.

For self-hosted framework deployments, inspect terminal or deployment build output for ingest warnings and errors. Informational diagnostics require the stored content-version diagnostics collection.

## Related

[Deploy on Manicule](/deploy/manicule) covers hosted deployment.

[Self-host](/deploy/self-host) covers the alternative deployment path.

[Quickstart](/quickstart) covers shared framework setup.
