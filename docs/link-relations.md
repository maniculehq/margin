---
title: Link relations
description: Stable relation identifiers for machine-readable documentation surfaces.
---

# Link relations

The framework uses registered link-relation tokens where available and
extension relation URIs for agent surfaces without an IANA token, following
RFC 8288 section 2.1.2. `DOCS_LINK_RELATION_BASE` supplies the base URI; the
framework appends one of the fragments below. The default points to this
file in the source repository and ends in `#`.

Clients should compare whole relation URIs. A site can change the base without
changing route locations. Responses also include the corresponding bare token
for compatibility with existing Mintlify clients. Registered tokens such as
`describedby`, `alternate`, `sitemap`, `service-desc`, and `api-catalog` remain
available alongside extension relations where appropriate.

## llms-txt

A compact plain-text documentation index, normally `/llms.txt`. It lists
indexable content with links and summaries. The same link also uses
`describedby`. Fetch linked Markdown for full page content.

## llms-full-txt

A plain-text corpus containing documentation bodies, normally `/llms-full.txt`.
Serving budgets may limit the corpus; use the manifest and individual page
links for complete retrieval.

## mcp-server-card

An MCP Server Card, normally `/api/mcp/server-card`, served with media type
`application/mcp-server-card+json`. It describes the site's public Streamable
HTTP endpoint. Discover live tools through MCP rather than assuming a fixed
list from the card.

## agent-skills

A skill manifest, normally `/.well-known/agent-skills/index.json`, served as
`application/json`. Entries link to admitted `SKILL.md` files and supporting
content. They describe agent workflows without installing executable code
into the framework server.

## Reading a Link header

A simplified response might advertise:

```text
Link: </llms.txt>; rel="describedby llms-txt https://example.org/relations#llms-txt"; type="text/plain"
```

The relation identifies the resource's purpose; the target URI identifies
where to fetch it. Disabled surfaces are omitted from discovery links.
