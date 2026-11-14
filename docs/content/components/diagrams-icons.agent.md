# Add diagrams, icons, and annotations

Add visual components to a Margin MDX page without imports. Use diagrams for relationships, tooltips for short definitions, and file trees for directory layouts.

## Do this

Paste this MDX into a documentation page body and open the rendered page in a browser:

```mdx
<Mermaid chart="flowchart LR; Client --> API; API --> Worker;" />

<Icon icon="arrow-right" size={20} /> Continue
<Icon icon="envelope" size={20} color="#2563eb" /> Email

<Badge>Preview</Badge>

<Tooltip tip="A request identifier used to correlate logs.">
  Request ID
</Tooltip>

<Color variant="table">
  <Color.Row title="Interface">
    <Color.Item name="Accent" value={{ light: "#2563eb", dark: "#60a5fa" }} />
    <Color.Item name="Success" value="#16a34a" />
  </Color.Row>
</Color>

<Tree>
  <Tree.Folder name="docs" defaultOpen={true}>
    <Tree.File name="index.mdx" />
  </Tree.Folder>
  <Tree.File name="docs.json" />
</Tree>

<FileTree>
  <FileTree.Folder name="images">
    <FileTree.File name="logo.svg" />
  </FileTree.Folder>
</FileTree>

<GitHub>
  <GitHub.Repo repo="maniculehq/margin" variant="inset" />
</GitHub>

<Prompt description="Review a retry policy" actions={["copy", "claude", "codex", "cursor"]}>
  Review the retry policy for this API client. Identify requests that
  cannot be retried safely and explain how to handle them.
</Prompt>

<Update label="2026-01-15" description="Retry controls" tags={["API"]}>
  Configure retry behavior for the API client.
</Update>
```

## Facts

- A `mermaid` code fence and `<Mermaid chart="..." />` both render Mermaid source. The demonstrated relationship is Client to API to Worker.
- `Mermaid.chart` is a string; missing or empty `chart` renders nothing.
- Mermaid rendering runs in the browser, follows the site's light/dark theme, and displays source in a code block if rendering fails. Include the relationship in nearby prose for readers without JavaScript.
- `docs.json` setting `icons.library` accepts `lucide`, `fontawesome`, or `tabler`; the default is `fontawesome`.
- Lucide and Font Awesome names resolve through Margin's mapped icon set. Mapped glyphs may differ visually from the original library's glyphs. Library selection does not block mapped aliases.
- `tabler` uses best-effort name resolution through the same map and produces a warning about the library setting.
- `Icon.icon` accepts a mapped name, local image path, or permitted image URL. Lucide example: `arrow-right`. Font Awesome example: `envelope`.
- Icon names `ArrowRight`, `arrow_right`, and `lucide-arrow-right-icon` normalize to `arrow-right`. Use bare names, not `fa-solid`, `fa-`, or `tabler:` prefixes.
- `Icon.size` accepts a number or numeric string in pixels. Default: `16`. Positive values up to `128` are accepted; other values fall back to `16`.
- `Icon.color` accepts a CSS color string and colors SVG icons, not image icons. `Icon.iconType` is accepted for compatibility but has no style effect.
- Unknown literal icon names use a default file glyph and emit `icon_unresolved` during ingest.
- `Badge` takes child content and renders a neutral label.
- `Tooltip.tip` is a string; children form the visible trigger with a dotted underline. Hover or keyboard focus reveals the tooltip. Keep required instructions in the body.
- `Color` renders a clickable palette. `Color.variant="table"` selects table layout; omitted or other values select compact layout.
- `Color.Row` groups children and takes an optional `title` string.
- `Color.Item` takes an optional `name` and a `value` that is a CSS color string or an object containing both `light` and `dark` strings. Missing or unsupported values render nothing.
- Clicking `Color.Item` copies the active theme's value.
- `Tree` and `FileTree` are aliases. Both accept children and expose `.File` and `.Folder` members.
- `Tree.File` and `FileTree.File` take `name` for a file entry.
- `Tree.Folder` and `FileTree.Folder` take `name`, child entries, `defaultOpen` (boolean, default `false`), and `disabled` (boolean, disables the toggle).
- `GitHub` only passes through children. Use `GitHub.Repo` for a repository card.
- `GitHub.Repo.repo` accepts `owner/name` or a GitHub repository URL. Missing or invalid values render nothing.
- `GitHub.Repo.variant="flat"` removes the border treatment. Omitted or other values use inset treatment. `GitHub.Repo.className` adds CSS classes to the repository link.
- `GitHub.Repo` fetches public repository description, stars, and forks in the visitor's browser and caches metadata for the session. Loading or refused requests leave a repository-name link.
- `Prompt.description` is the visible label and defaults to `Prompt`. Children supply the hidden prompt body used by actions.
- `Prompt.actions` is an array of `copy`, `claude`, `codex`, and `cursor`, default `["copy"]`. Invalid arrays fall back to `["copy"]`. Copy is always visible. `claude` adds Open in Claude Code (`claude://code/new?q=`), `codex` adds Open in Codex (`codex://threads/new?prompt=`), and `cursor` adds Open in Cursor (`cursor://anysphere.cursor-deeplink/prompt?text=`), each with the full prompt text, in the order listed.
- `Update` places release metadata beside the body on wider screens and above the body on narrow screens.
- `Update.label` supplies the displayed label and anchor source. `Update.date` is the fallback when `label` is omitted. `Update.description` supplies the short release description; children supply the body.
- `Update.tags` accepts an array of strings. Missing or invalid arrays use an empty array.
- Update anchors lowercase the label or fallback date, replace non-alphanumeric runs with hyphens, and trim edge hyphens. Label `2026-01-15` produces `#2026-01-15`.

## Not supported

- `Mermaid` does not render diagrams without browser JavaScript.
- `icons.library="tabler"` does not load the Tabler catalog.
- Authored inline SVG markup is not a valid `Icon.icon` value. Use image files for visuals absent from the mapped set.
- `Badge` does not implement color or size variants.
- `Color` does not style arbitrary text.
- `Tree` and `FileTree` do not take a text `tree` prop or Markdown lists as entry syntax; use member components.
- `GitHub` alone does not create a card. `GitHub.Repo` does not configure private-repository access.
- `Prompt` does not display the prompt body, run model requests, or display model responses.

## Errors

| Identifier | HTTP status | Cause | Fix |
| :--- | :--- | :--- | :--- |
| `icon_unresolved` (ingest warning) | Not applicable | Unknown literal icon name or authored inline SVG markup in `icon`. | Use a mapped bare name or an image file. |

## Verify

Open the rendered page in a browser with JavaScript enabled. Expect a Client to API to Worker diagram, a Preview badge, and an initially open `docs` folder. Focus Request ID to show its tooltip; click the Accent swatch to copy the active theme's value. Click Copy prompt to copy the full hidden prompt text. The Update entry is addressable at `#2026-01-15`.

## Related

- [Publish changelogs](/content/changelogs)
