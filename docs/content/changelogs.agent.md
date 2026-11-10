# Publish a changelog

Create an MDX page with dated release entries, tag filters, and an RSS feed. Use this workflow to publish release notes readers can browse by category.

## Do this

Create `changelog.mdx` at the documentation source root with this complete content. The release changes are sample content to replace before publication.

```mdx
---
title: "Changelog"
description: "Release notes for the API and dashboard."
---

<Update
  label="October 28, 2026"
  description="v2.4.0"
  tags={["API"]}
>
  ## Retry failed deliveries

  Failed webhook deliveries now retry for 24 hours.
</Update>

<Update
  label="October 14, 2026"
  description="v2.3.0"
  tags={["Dashboard"]}
>
  ## Export delivery history

  Download delivery history as a CSV from the dashboard.
</Update>
```

Add a Releases group to `navigation.groups` in the existing `docs.json`, preserving other groups. The group entry is:

```json
{
  "group": "Releases",
  "pages": ["changelog"]
}
```

Publish through the site's existing documentation workflow.

## Facts

- `Update` accepts Markdown content as the entry body.
- `Update` metadata is optional.
- `Update.label` is a string used as the visible label and source of the entry anchor.
- `Update.date` is a string used as the label only when `Update.label` is absent.
- `Update.description` is a string shown as a short release title or version beside the label.
- `Update.tags` is an array of strings used for visible tag labels and filter choices.
- `Update.rss` is a static object with optional string fields `title` and `description`; `Update.rss` affects feed metadata rather than visible release metadata.
- Metadata must use literal strings, arrays, or objects rather than runtime variables or function calls.
- Entries appear in authored order on the page and in the RSS feed; place newer entries first manually.
- Entry anchors lowercase `label`, replace runs of non-alphanumeric characters with hyphens, and remove leading and trailing hyphens; `date` supplies the anchor source when `label` is absent.
- `label="October 28, 2026"` produces the anchor `#october-28-2026`.
- Distinct labels prevent duplicate entry anchors.
- Entry metadata appears beside the body on wider screens and above the body on smaller screens.
- Filter choices are the distinct entry tag strings in first-appearance order; no separate filter declaration is required.
- Filter tag matching is exact and case-sensitive; a comma inside a tag string does not split the tag.
- With no selected filters, every entry is visible.
- With selected filters, an entry is visible if any entry tag matches any selected tag.
- Untagged entries are hidden while any filter is selected.
- Selecting an active tag removes that selection; clearing all selections restores every entry.
- The Filters panel replaces the right-hand table of contents on tagged Update pages.
- The Filters panel is hidden below the extra-large layout breakpoint; entries remain readable on smaller screens.
- Navigating to another page resets the filter selection.
- The page at `/changelog` has an RSS feed at `/changelog.rss.xml`; other page paths receive their own `.rss.xml` feeds.
- The Open RSS feed action opens the page's feed.
- Each authored entry produces one RSS item; entry tags become RSS categories.
- RSS item titles fall back from `rss.title` to `description`, then to the chosen label, then to `Update`.
- `rss.description` supplies the RSS item description; entry body content is not copied into the RSS description.
- RSS publication dates require the chosen label to be a date that includes its year (`2026-09-01`, not `1.4.0`); when `label` and `date` are both supplied, `label` is used.
- Browser filter selections do not change the RSS feed.

## Not supported

- No mandatory changelog filename, special route, changelog-specific frontmatter, import, or wrapper is required.
- Entries are not automatically sorted by date or version.
- Multiple selected tags do not require all tags to match; matching any selected tag is sufficient.
- Pages without entry tags do not have a Filters panel.
- The Filters panel does not provide a mobile filtering control.
- Function calls and runtime variables are not supported for calculated tags or RSS metadata.

## Verify

Open the published `/changelog` page on a wide screen. Confirm that the October 28 entry precedes October 14, that `API` shows only the first entry, that `Dashboard` shows only the second entry, and that selecting both shows both entries. Clear both filters to restore all entries, then resize to a narrow screen to check metadata readability.

Open the page's Open RSS feed action and confirm that `/changelog.rss.xml` contains two items in source order with `API` and `Dashboard` categories. The default feed titles are `v2.4.0` and `v2.3.0`.
