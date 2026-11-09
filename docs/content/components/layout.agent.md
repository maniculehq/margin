# Add callouts, cards, and layouts

Insert supported MDX components to emphasize messages, link to related pages, or arrange content. Use this reference when editing an MDX documentation page and selecting component properties.

## Do this

Insert this MDX into a documentation page to add a warning and a two-column card group. The first card links within the documentation site; the second card links to an external website.

```mdx
<Warning title="Check destinations">
Check the destination before publishing a linked card.
</Warning>

<CardGroup cols="2">
  <Card title="Add media" href="/content/media" icon="image" cta="Read the guide">
    Add images and videos to a page.
  </Card>
  <Card title="Manicule" href="https://manicule.com" icon="globe" horizontal="true">
    Visit the Manicule website.
  </Card>
</CardGroup>
```

## Facts

- The message components are `Callout`, `Note`, `Info`, `Tip`, `Warning`, `Danger`, and `Check`.
- `Note` is blue with an information icon; `Info` is neutral gray with an information icon.
- `Tip` is green with a lightbulb icon; `Warning` uses a warning style and alert icon; `Danger` uses an error style and error icon; `Check` uses a success style and check icon.
- Every callout accepts `children` (MDX body, empty by default), `title` (text or content, absent by default), and `className` (additional CSS classes, absent by default).
- Callout bodies accept paragraphs, lists, code, and links. Use blank lines around block content inside a callout.
- `Callout.type` defaults to `info`; supported types are `info`, `warn`, `warning`, `error`, `success`, and `idea`. `warn` aliases `warning`.
- `Callout.tone` defaults to the supplied `type`, or `info`; `tone` selects the visual tone and icon independently of the semantic color selected by `type`.
- `Callout.tone` supports the named tones `note`, `info`, `tip`, `warning`, `check`, `success`, `error`, and `idea`.
- `Note`, `Info`, `Tip`, `Warning`, `Danger`, and `Check` fix their own type and visual tone.
- Callout bodies are not automatically links; use Markdown links inside callouts.
- `Card.title` accepts text or content, defaults to absent, and appears above the description and body.
- `Card.description` accepts text or content, defaults to absent, and appears above the body.
- `Card.children` accepts MDX content and defaults to empty.
- `Card.href` is an optional string. Supplying `Card.href` makes the whole card a link; omitting `Card.href` produces a non-linked container.
- `Card.icon` accepts an icon name, image reference, or content and defaults to absent. Unknown icon names render no icon.
- `Card.iconType` accepts a string for compatibility and has no visual effect.
- `Card.color` accepts a CSS color string, defaults to absent, and tints the icon.
- `Card.img` accepts a string, defaults to absent, and supplies an ingested thumbnail asset on non-horizontal cards. Media source and loading details belong to `/content/media`.
- `Card.cta` accepts text or content, defaults to absent, and displays an action label using the card destination.
- `Card.horizontal` accepts a boolean or string, defaults to false, and places the icon beside the text.
- `Card.arrow` accepts a boolean or string. The arrow appears by default for HTTP(S) destinations and stays hidden by default otherwise.
- `Card.className` accepts a string of additional CSS classes and defaults to absent.
- `Card.horizontal` and `Card.arrow` accept a bare property, `true`, or `"true"` to turn the option on; `"false"` turns the option off.
- Hiding `Card.arrow` does not change the link behavior.
- Internal card destinations open within the site. External HTTP(S) card destinations open in a new tab with `rel="noreferrer noopener"`.
- Internal documentation destinations must be extensionless paths with `/`, `./`, or `../` prefixes. Same-page anchors start with `#`; external destinations use full URLs.
- `Card` titles are display text, not page-outline headings.
- `CardGroup` and `Columns` use the same layout behavior and accept `cols` (string or number) and `children` (MDX content, empty by default).
- `CardGroup.cols` and `Columns.cols` accept integers `1`, `2`, `3`, or `4`; omitted or invalid values fall back to `2`. Use `cols="2"` for two-column examples.
- Direct children of `CardGroup` and `Columns` become grid items. Wrap content that must stay together in one container.
- `CardGroup` accepts non-card content and does not add titles or destinations to children.
- A one-column grid stays at one column. Two-column grids start at one column. Three- and four-column grids start at one column, pass through two columns, and reach the requested maximum as the container widens.
- Cards span the full grid width in narrow containers.
- A nested grid arranges only its own direct children; nested grids do not share a grid.
- `Tile` renders a fixed-height preview above a centered title and description. Use `Columns` to arrange multiple tiles.
- `Tile` accepts optional string properties `title`, `description`, and `href`, plus MDX `children` for the preview. All string properties default to absent; children default to empty.
- A tile without `href` is a non-linked container. A valid `Tile.href` links the whole tile.
- Internal tile links stay within the site; external HTTP(S) tile links open in a new tab. Unsafe schemes and protocol-relative tile destinations do not make a tile clickable.
- Linked cards and linked tiles must not contain nested links, buttons, or other interactive controls. Omit the card's `href` when the card body needs separate destinations.
- `Panel` accepts only MDX `children`, empty by default, and supplies no border or padding.
- A top-level `Panel` supplies desktop right-column content instead of the table of contents. Smaller screens and layouts that suppress the right column show panel content inline at the authored position.
- A nested `Panel` stays inline. A top-level `Panel` supplies right-column content instead of standalone `RequestExample` or `ResponseExample` blocks.
- `Frame` accepts MDX `children` (empty by default) and optional string properties `caption` and `hint` (absent by default).
- `Frame` clips children to rounded corners without a padded card border. Images and videos inside `Frame` fill the wrapper width.
- `Frame.caption` renders centered text below the content; `Frame.hint` renders a smaller muted line below the caption.

## Not supported

- `icon` cannot override the icon selected by Margin for a callout.
- `type` cannot change the fixed style of `Note`, `Info`, `Tip`, `Warning`, `Danger`, or `Check`.
- `Card` does not expose `target` or `rel` overrides.
- `CardGroup` and `Columns` do not expose gap or per-item span properties.
- `CardGroup.href` does not set destinations on child cards; set `Card.href` individually.
- `Tile` does not expose `arrow`, `horizontal`, `icon`, or `target` properties.
- `Frame.src` does not load media; place a media element inside `Frame`.
- A nested `Panel` does not populate the desktop right column.

## Verify

Render the MDX page and check the warning style and card destinations. At sufficient container width, the card group has two columns; at narrow widths, the cards stack. The `/content/media` card stays within the site, and the `https://manicule.com` card opens a new tab.

## Related

- [Add media](/content/media)
