# Changelog

All notable changes to Margin are recorded here. Releases will use
Semantic Versioning once a stable public API is published.

## Unreleased

### Changed

- The default theme and every layout preset now follow their Mintlify
  counterparts: white pages with near-black dark mode, a framework palette
  per `theme`, Mintlify's type scale, a 65–75 character reading measure, and
  each theme's header, sidebar and table-of-contents treatment.
- Text holds WCAG AA contrast in light and dark mode for every preset. An
  accent from `colors` or a logo that would fall below 4.5:1 is darkened or
  lightened until it passes; `colors.light` sets the dark-mode accent and
  `colors.dark` the button fill, as in Mintlify.
- The header omits its tab row when navigation has a single content tab.
  A lone link-only or menu tab, such as a `navigation.global.tabs` link to
  support, keeps the row.

### Fixed

- Changelog RSS feeds no longer date entries whose label is not a date: a
  label such as `1.4.0` or `Release 7` used to get a publication date in 2000
  or 2001. An entry now gets a date only when its label includes its
  four-digit year; a bare year is dated 1 January.
- `/changes.md?since=` answers 400 for a value that is not a date instead of
  failing with a 500, and says no pages changed since that date when none
  did, instead of blaming missing git history.
- `POST /api/agent/feedback` refuses an `incorrect`, `missing`, `outdated`,
  `unclear` or `other` report without a `message` with HTTP `400`, matching
  the MCP `submit_feedback` tool. Page and answer votes need no message.

### Added

- Standalone single-site TanStack Start application with Postgres-backed,
  build-time documentation ingest and commit-pinned content versions.
- Mintlify-compatible configuration with an `x-margin` extension namespace,
  folder navigation, themes, OpenAPI pages, and agent discovery surfaces.
- Typed server extensions, optional telemetry and AI Gateway integration,
  Free icons with a licensed Pro opt-in, and self-hosted OFL fonts.
- Public deployment standard, contributor guidance, license notices, and
  documentation served by the framework itself.
