# Choose MDX components

Select built-in MDX components by purpose and insert supported source syntax into a documentation page. Use this reference when authoring or migrating an MDX page without importing built-in components.

## Do this

Insert the following complete MDX block into a documentation page to display a blue informational note:

```mdx
<Note>The page must be in navigation.</Note>
```

Choose a different component from the inventory when a note does not match the content. Linked Mintlify references provide longer syntax examples; the Margin behavior stated here takes precedence over Mintlify-specific props or layout behavior.

## Facts

- Built-in root component inventory: `Agent`, `Human`, `Visibility`, `Callout`, `Note`, `Info`, `Tip`, `Warning`, `Check`, `Accordion`, `AccordionGroup`, `Badge`, `Card`, `CardGroup`, `Image`, `ParamField`, `ResponseField`, `Tab`, `Tabs`, `CodeGroup`, `Columns`, `Frame`, `Snippet`, `Step`, `Steps`, `Tooltip`, `Update`, `Mermaid`, `Expandable`, `Icon`, `Prompt`, `Danger`, `RequestExample`, `ResponseExample`, `FileTree`, `Tree`, `PreviewButton`, `Panel`, `Tile`, `Color`, `View`, `GitHub`.
- Built-in components require no imports in MDX pages.
- Supported member component inventory: `Tree.File`, `Tree.Folder`, `FileTree.File`, `FileTree.Folder`, `Color.Item`, `Color.Row`, `GitHub.Repo`.
- `CardGroup` and `Columns` use the same responsive grid; `cols` accepts integers 1 through 4 and defaults to 2.
- Every code fence inside a code group needs a `title` for the tab label.
- Consecutive sibling `View` tags create selectable content variations.
- `RequestExample` and `ResponseExample` render inline as code groups.
- `Panel` renders children inline.
- `Image` supports click-to-zoom; image examples require an image at `images/preview.png` under the docs root.
- `Prompt` displays a description and copy control, not the prompt body as page prose.
- `GitHub.Repo` fetches public repository details in the visitor's browser and falls back to a repository link when details are unavailable.
- `Visibility` recognizes `for="agents"` and `for="humans"`; missing or unrecognized `for` values address both audiences.
- `Agent` aliases agent-only content; `Human` aliases human-only content.
- Agent-only content is absent from human HTML; human-only content is omitted from agent Markdown.
- Content outside audience wrappers remains available to both readers.
- `Snippet` expands reusable content during ingest; the referenced snippet file must exist under the docs root.

The component inventory below provides source examples. The API field examples describe a hypothetical API, not Margin endpoints.

| Component | Purpose | Source example |
| --- | --- | --- |
| Callout | General typed callout | `<Callout type="info">Changes apply on the next build.</Callout>` |
| Note | Blue informational note | `<Note>The page must be in navigation.</Note>` |
| Info | Neutral information | `<Info>The preview uses this branch.</Info>` |
| Tip | Optional recommendation | `<Tip>Reuse this block as a snippet.</Tip>` |
| Warning | Caution | `<Warning>Check the target branch before pushing.</Warning>` |
| Check | Successful result | `<Check>The build completed.</Check>` |
| Danger | Error or destructive-action warning | `<Danger>Deleting this file removes its content.</Danger>` |
| Card | Linked or unlinked content card | `<Card title="Source" href="https://github.com/maniculehq/margin">Read the framework code.</Card>` |
| CardGroup | Card grid | `<CardGroup cols="2"><Card title="Hosted">Publish on Manicule.</Card><Card title="Self-hosted">Run Margin yourself.</Card></CardGroup>` |
| Columns | Content grid | `<Columns cols="2"><div>Before</div><div>After</div></Columns>` |
| Image | Zoomable image | `<Image src="/images/preview.png" alt="Documentation preview" />` |
| Frame | Media caption | `<Frame caption="Documentation preview"><Image src="/images/preview.png" alt="Documentation preview" /></Frame>` |
| Panel | Inline compatibility wrapper | `<Panel>Related deployment information.</Panel>` |
| Tile | Preview card | `<Tile title="Preview" description="Open the source repository." href="https://github.com/maniculehq/margin">Margin</Tile>` |
| PreviewButton | Button-styled link | `<PreviewButton href="https://github.com/maniculehq/margin">Open source</PreviewButton>` |
| Steps, Step | Numbered procedure and action | `<Steps><Step title="Publish">Push the documentation change.</Step></Steps>` |
| Tabs, Tab | Alternative instructions | `<Tabs><Tab title="Hosted">Connect the repository.</Tab><Tab title="Self-hosted">Deploy Margin.</Tab></Tabs>` |
| Accordion | Standalone collapsible detail | `<Accordion title="Troubleshooting">Check the build diagnostics.</Accordion>` |
| AccordionGroup | Related collapsible blocks | `<AccordionGroup><Accordion title="Build">Check diagnostics.</Accordion><Accordion title="Links">Check destinations.</Accordion></AccordionGroup>` |
| Expandable | Collapsible child attributes | `<Expandable title="child attributes">Describe nested fields here.</Expandable>` |
| View | Content variations | `<View title="Hosted">Connect the repository on Manicule.</View>` followed by `<View title="Self-hosted">Deploy the Margin application.</View>` |
| ParamField | Input name, location, type | `<ParamField query="limit" type="integer">Number of results requested.</ParamField>` |
| ResponseField | Output field | `<ResponseField name="items" type="array">Returned results.</ResponseField>` |
| Mermaid | Browser-rendered diagram | `<Mermaid chart="graph LR; Source-->Build;" />` |
| Icon | Inline icon | `<Icon icon="terminal" />` |
| Badge | Neutral status label | `<Badge>Beta</Badge>` |
| Tooltip | Hover/focus definition | `<Tooltip tip="The branch used for publishing">Deploy branch</Tooltip>` |
| Update | Changelog entry | `<Update label="2026-01-01" description="Documentation update">Added a setup guide.</Update>` |
| Prompt | Copyable prompt | `<Prompt description="Review a page">Find broken links in this page.</Prompt>` |
| Tree | File hierarchy | `<Tree><Tree.Folder name="docs"><Tree.File name="index.mdx" /></Tree.Folder></Tree>` |
| FileTree | File hierarchy alias | `<FileTree><FileTree.Folder name="docs"><FileTree.File name="index.mdx" /></FileTree.Folder></FileTree>` |
| Color | Copyable swatches | `<Color><Color.Row title="Brand"><Color.Item name="Primary" value="#2563EB" /></Color.Row></Color>` |
| GitHub | Public repository card through member | `<GitHub.Repo repo="maniculehq/margin" />` |
| Visibility | Explicit audience selection | `<Visibility for="agents">Read the Markdown rendition.</Visibility>` |
| Agent | Agent-only alias | `<Agent>Read the Markdown rendition.</Agent>` |
| Human | Human-only alias | `<Human>Use the navigation sidebar.</Human>` |
| Snippet | Reusable content | `<Snippet file="snippets/shared-note.mdx" />` |

`CodeGroup`, `RequestExample`, and `ResponseExample` each accept fenced code. Replace `CodeGroup` with either example wrapper to use the same source structure:

````mdx
<CodeGroup>

```json title="docs.json"
{"name": "Acme"}
```

```md title="index.mdx"
# Welcome
```

</CodeGroup>
````

## Not supported

- An allowed root component does not imply support for every Mintlify prop or layout behavior.
- `Panel` does not replace the table-of-contents column.
- `RequestExample` and `ResponseExample` do not render in a separate right-hand example column.
- `ParamField` and `ResponseField` do not send requests or enforce validation.
- Audience wrappers do not enforce access permissions.
- An authored `ViewGroup` wrapper is not supported; write consecutive sibling `View` tags.
- Unsupported member tags do not inherit support from a built-in root name.
- Unknown capitalized components do not preserve component-specific layout or behavior; ingest keeps only children.
- Unknown self-closing components have no children to preserve.

## Errors

| Exact identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `component_unknown` | Not an HTTP error; ingest warning | Unknown capitalized component or unsupported member tag | Replace the tag with a built-in component; check rendered output and build diagnostics. |

## Verify

Inspect the rendered page and build diagnostics after ingest. The canonical `Note` example should display a blue informational note without a `component_unknown` warning. An unknown wrapper such as `<CustomBox>Check the build diagnostics.</CustomBox>` leaves only `Check the build diagnostics.` and records a `component_unknown` warning rather than failing for the unknown name.

## Related

The following links are Mintlify syntax references; Margin-specific coverage and exceptions are stated above.

- [Callouts](https://www.mintlify.com/docs/components/callouts), [cards](https://www.mintlify.com/docs/components/cards), [columns](https://www.mintlify.com/docs/components/columns), [frames](https://www.mintlify.com/docs/components/frames), [images](https://www.mintlify.com/docs/create/image-embeds), [panel](https://www.mintlify.com/docs/components/panel), [tiles](https://www.mintlify.com/docs/components/tiles).
- [Steps](https://www.mintlify.com/docs/components/steps), [tabs](https://www.mintlify.com/docs/components/tabs), [accordions](https://www.mintlify.com/docs/components/accordions), [expandables](https://www.mintlify.com/docs/components/expandables), [code groups](https://www.mintlify.com/docs/components/code-groups), [views](https://www.mintlify.com/docs/components/view).
- [Fields](https://www.mintlify.com/docs/components/fields), [response fields](https://www.mintlify.com/docs/components/responses), [examples](https://www.mintlify.com/docs/components/examples).
- [Mermaid](https://www.mintlify.com/docs/components/mermaid-diagrams), [icons](https://www.mintlify.com/docs/components/icons), [badges](https://www.mintlify.com/docs/components/badge), [tooltips](https://www.mintlify.com/docs/components/tooltips), [updates](https://www.mintlify.com/docs/components/update), [prompts](https://www.mintlify.com/docs/components/prompt), [trees](https://www.mintlify.com/docs/components/tree), [colors](https://www.mintlify.com/docs/components/color), [GitHub](https://www.mintlify.com/docs/components/github).
- [Visibility](https://www.mintlify.com/docs/components/visibility), [reusable snippets](https://www.mintlify.com/docs/create/reusable-snippets).
