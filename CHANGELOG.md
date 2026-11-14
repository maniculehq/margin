# Changelog

All notable changes to Margin are recorded here. Releases will use
Semantic Versioning once a stable public API is published.

## Unreleased

### Added

- A page's `<page>.agent.md` sibling is its agent rendition. The `.md` URL,
  `Accept: text/markdown`, `?format=markdown`, `llms-full.txt`, Copy page
  and the MCP server's `read_page` return it in place of the Markdown
  derived from the page, under the same title line, frontmatter and index
  preamble. It never becomes a page, and one with no page beside it raises
  an `agent_rendition_orphaned` ingest warning. See "Write an agent
  rendition" in the Markdown guide. Sites re-ingest once to pick it up.
- `<Prompt>` takes `claude` and `codex` actions beside `copy` and `cursor`,
  which open the prompt in Claude Code and Codex.
- Site stylesheets can target page regions and components by the common
  `docs.json` hooks: `#navbar`, `#sidebar`, `#content-area`,
  `#table-of-contents`, `#pagination` and `#footer`; `.card`, `.callout`,
  `.code-block`, `.code-group` and `.frame`; `data-component-part` values
  such as `card-title`; and `html[data-current-path]`. Redefining
  `--rounded-lg`, `--rounded-xl` or `--rounded-2xl` on `:root` reshapes
  cards, code blocks, callouts and sidebar rows. See "Target page regions
  and components" in the CSS guide.
- A section prefix with no page of its own, such as `/guides`, redirects to
  the first page under it in navigation order.
- The MCP server also answers `POST /mcp`, for clients configured with that
  path.

### Changed

- The default theme and every layout preset now follow their Mintlify
  counterparts: white pages with near-black dark mode, a framework palette
  per `theme`, Mintlify's type scale, a 65–75 character reading measure, and
  each theme's header, sidebar and table-of-contents treatment.
- Text holds WCAG AA contrast in light and dark mode for every preset. An
  accent from `colors` or a logo that would fall below 4.5:1 is darkened or
  lightened until it passes; `colors.light` sets the dark-mode accent and
  `colors.dark` the button fill, as in Mintlify.
- Heading anchors turn punctuation into hyphens instead of dropping it, keep
  symbols such as `&` and `/`, and number a repeated heading from 2:
  `decision.id` is `#decision-id`, and a second `Install` is `#install-2`.
  A link to an anchor in the former form still scrolls to its heading.
- A site that sets `"theme": "mint"` gets a text column up to 45rem wide,
  white cards and code blocks in light mode, 14px callouts, baseline-aligned
  tables with regular-weight headers, a padded `Frame`, a solid navbar
  button and plain previous/next links.
- A stylesheet rule that reads the root's state and styles a descendant,
  such as `html[data-current-path^="/api"] #banner { display: none }`, is
  kept. It used to be dropped as a global layout rule.
- A Google Fonts `@import` at the top of any stylesheet is loaded, not only
  one in the first file.
- The header omits its tab row when navigation has a single content tab.
  A lone link-only or menu tab, such as a `navigation.global.tabs` link to
  support, keeps the row.

### Fixed

- The open assistant panel stays below the docs header and ends at the
  bottom of the window. It used to be a header's height too tall, which hid
  the question box until the page was scrolled, and it slid under the header
  on scroll.
- A site name, page title or analytics key containing `</script>` no longer
  ends the page's JSON-LD or analytics script early. Both write `<`, `>`,
  `&`, U+2028 and U+2029 as `\u` escapes, which JSON and JavaScript read
  back as the same characters.
- The `comment`, `comments` and `message` icon names render speech bubbles
  instead of a reply arrow.
- Changelog RSS feeds no longer date entries whose label is not a date: a
  label such as `1.4.0` or `Release 7` used to get a publication date in 2000
  or 2001. An entry now gets a date only when its label includes its
  four-digit year; a bare year is dated 1 January.
- `/changes.md?since=` answers 400 for a value that is not a date instead of
  failing with a 500, and says no pages changed since that date when none
  did, instead of blaming missing git history.
- `/changes.md?since=` answers 400 for a value that is not an ISO 8601 date,
  such as `1.4.0`, `Release 7` or `2026-02-30`, instead of reading it as some
  other date and returning the whole feed. A time must now name its zone
  (`Z` or an offset such as `+02:00`); one without used to be read in the
  server's zone.
- `POST /api/agent/feedback` refuses an `incorrect`, `missing`, `outdated`,
  `unclear` or `other` report without a `message` with HTTP `400`, matching
  the MCP `submit_feedback` tool. Both trim the message first, so one of only
  whitespace is refused too. Page and answer votes need no message.

### Fixed

- A host that names no site answers 404 on every route. Only its HTML pages
  did; `robots.txt`, sitemaps, `llms.txt`, `.md` pages, OG images, MCP and
  trailing-slash URLs answered 500.

### Added

- Standalone single-site TanStack Start application with Postgres-backed,
  build-time documentation ingest and commit-pinned content versions.
- Mintlify-compatible configuration with an `x-margin` extension namespace,
  folder navigation, themes, OpenAPI pages, and agent discovery surfaces.
- Typed server extensions, optional telemetry and AI Gateway integration,
  Free icons with a licensed Pro opt-in, and self-hosted OFL fonts.
- Public deployment standard, contributor guidance, license notices, and
  documentation served by the framework itself.

### Fixed

- Ingest now warns (`link_broken`) about a broken bare relative link such as
  `[next](quickstart)`, as it already did for `./quickstart` and
  `/quickstart`.
