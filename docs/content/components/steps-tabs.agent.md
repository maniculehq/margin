# Organize steps, tabs, and code groups

Use MDX components to sequence actions, separate alternatives, and collapse supplemental detail. Use this reference when authoring procedures or parallel examples in a documentation page.

## Do this

Paste this complete MDX passage into a page. The procedure creates `component-check.txt` in the current working directory; the write replaces any existing contents.

````mdx
<Steps>
  <Step title="Create a test file">
    Write a single line to `component-check.txt`.

    ```sh title="Create file"
    printf 'ready\n' > component-check.txt
    ```

    The command finishes without output and creates the file.
  </Step>
  <Step title="Read the test file">
    Print the file to confirm that the write succeeded.

    ```sh title="Read file"
    cat component-check.txt
    ```

    Expected output is `ready` on one line.
  </Step>
</Steps>

<Tabs defaultValue="Local">
  <Tab title="Local">
    Run the file check in a working directory on your machine.
  </Tab>
  <Tab title="Container">
    Run the file check inside the container whose filesystem you want to test.
  </Tab>
</Tabs>

Both language examples print `ready` followed by a newline.

<CodeGroup>

```js title="JavaScript"
console.log("ready");
```

```python title="Python"
print("ready")
```

</CodeGroup>

<Accordion title="Remove the test file" id="remove-test-file">
  Delete `component-check.txt` when the check is complete. Keep it if another example still needs it.
</Accordion>

<AccordionGroup type="single" defaultValue="location">
  <Accordion title="Where is the file?" value="location">
    The file is in the directory where the write command ran.
  </Accordion>
  <Accordion title="What if it already exists?" value="overwrite">
    The write command replaces its previous contents.
  </Accordion>
</AccordionGroup>

<Expandable title="file details">
  The test file contains the word `ready` and a trailing newline.
</Expandable>

<View title="Workstation">
  Run the file check in your local working directory.
</View>

<View title="Build environment">
  Run the file check in the build's working directory.
</View>
````

## Facts

- `Steps` accepts `children` only; place `Step` children directly inside `Steps`.
- `Step` accepts `children`, `title`, `icon`, `stepNumber`, and `titleSize`. A step can contain prose, code, or tabs.
- `Step.icon` replaces the number marker. `Step.stepNumber` accepts a positive number or numeric string; later steps continue counting from that number.
- `Step.titleSize="h2"` and `Step.titleSize="h3"` render heading labels; other or omitted `titleSize` values render paragraph labels.
- `Tabs` requires direct `Tab` children. `Tab.title` names the panel; distinct titles avoid ambiguity. `Tab.icon` appears before the label; `Tab.children` contains the panel content.
- `Tabs.defaultValue` accepts a child title or authored child `value`; the first tab is the default when `defaultValue` is absent.
- `Tab.value` supplies the label when `Tab.title` is absent; `Tabs` assigns the final panel value.
- `Tabs` groups with matching normalized label sets synchronize selection. `Tabs.groupId` overrides the automatic synchronization group.
- `Tabs.persist` defaults to enabled and saves selection across browser sessions. `persist={false}` still retains grouped selection in session storage. Saved selection can override the initial default.
- Inactive tab panels remain in HTML but are hidden visually.
- `CodeGroup` accepts `children` only. Place code fences directly inside `CodeGroup`, with `title="…"` on every fence; titles become tab labels.
- Code groups with matching label sets synchronize selection. Duplicate labels receive numeric suffixes.
- `Accordion` accepts `title`, `value`, `id`, `disabled`, and `children`. `Accordion.title` is a label, not a document heading.
- `Accordion.value` defaults to the string form of `title`; use unique values inside an accordion group.
- `Accordion.id` supplies an anchor and copy-link control. Loading the page with the corresponding hash opens the accordion.
- Standalone `Accordion` needs no group, starts closed, and permits closing after opening.
- `AccordionGroup` accepts `type`, `defaultValue`, and direct `Accordion` children.
- `AccordionGroup.type` values are `single` (default) and `multiple`. Single mode permits at most one open item and permits closing the open item; multiple mode permits several open items.
- `AccordionGroup.defaultValue` is a string value in single mode or an array of values in multiple mode. Omitted `defaultValue` starts all items closed. Example: `defaultValue={["location", "overwrite"]}`.
- `Expandable` accepts `title`, `defaultOpen`, and `children`. `title` defaults to `child attributes`; the disclosure prefixes the title with “Show” or “Hide”.
- `Expandable` starts closed unless `defaultOpen={true}`. `Expandable` uses a native details disclosure independent of accordion group state.
- `View` accepts `title`, `icon`, and `children`. `View.title` must be a nonempty literal string; `View.icon` supplies an optional selector icon.
- Consecutive block-level sibling `View` elements form one dropdown group. Blank lines do not split a group; intervening prose or another component does.
- Without `docs.json` variation options, view groups start with the first view and retain selection locally.
- With `docs.json` `variations.options`, view titles match option labels case-insensitively. Matching groups share the selected option across the site and save the selection in browser storage.
- The first configured variation option is the initial selection; a group without the selected option falls back to its first view.
- Matching view menu choices appear in configured option order, followed by unmatched views in source order. Selecting an unmatched view changes only that group.
- Views keep all alternatives in HTML and hide inactive passages. A link to a heading in a hidden view activates that view. Server-rendered HTML uses the default selection; saved browser selection applies after mount.

## Not supported

- Tabs and views are not access-control boundaries; hidden content remains in HTML.
- Required procedure actions and expected results must not be hidden inside optional disclosures.
- Do not author `ViewGroup`; the renderer creates view groups.
- Inline `View` elements inside paragraphs are unsupported and render as their children with a warning.
- Views select content variants, not human-versus-agent visibility.
- Missing, empty, or nonliteral `View.title` values produce a warning and fall back to `View 1`, `View 2`, and subsequent ordinal labels within each group.
- `CodeGroup` does not replace Markdown fence syntax.

## Verify

Preview the page: steps appear in order, tab and code labels select alternatives, disclosures open, and the consecutive views share one dropdown. Run both procedure commands from the same directory; `cat component-check.txt` must print `ready` on one line.

## Related

Code groups arrange examples written as Markdown fences. See [Format content](/content/formatting) for language identifiers and standalone code blocks.
