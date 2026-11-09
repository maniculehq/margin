# Retrieve Markdown and PDF versions

Retrieve a published documentation page as agent Markdown or a human-facing PDF without the browser interface. Use Markdown for machine reading and PDF for offline human reading.

## Do this

Set `PAGE_URL` to an existing human page URL without a trailing slash, query string, or fragment, then save both exports:

```bash
export PAGE_URL='https://docs.example.com/quickstart'
curl --fail --show-error --location \
  --dump-header markdown.headers \
  --output quickstart.md \
  "${PAGE_URL}.md"
curl --fail --show-error --location \
  --output quickstart.pdf \
  "${PAGE_URL}.pdf"
```

Use `/index.md` and `/index.pdf` for the root page instead of appending suffixes to `/`.

## Facts

- `/quickstart.md` is the Markdown export of `/quickstart`; `/quickstart.pdf` is the PDF export of `/quickstart`.
- Export URLs preserve site base paths, locale prefixes, and version prefixes; `/fr/quickstart` maps to `/fr/quickstart.md`.
- Successful Markdown responses return `200` and `Content-Type: text/markdown; charset=utf-8`.
- Markdown contains the agent rendition, a title and page path, and agent signals such as estimated token count and update date.
- Successful PDF responses return `Content-Type: application/pdf` and `Content-Disposition: attachment` with a PDF filename.
- PDF contains the human rendition with agent-only content removed.
- PDF can embed PNG and JPEG images stored with the published docs; unsupported or missing images fall back to alt text.
- Markdown and PDF responses include `ETag`; a matching `If-None-Match` request returns `304` without a response body.
- Markdown responses include a canonical `Link` to the human page.
- `Accept: text/markdown` on an ordinary human page URL returns Markdown inline with the same body and headers as the `.md` URL, without a format-selection redirect.
- Recognized Markdown `Accept` types are `text/markdown`, `text/plain`, and `text/x-markdown`; the response type remains `text/markdown`.
- `text/html`, `text/*`, and `*/*` count toward HTML preference.
- The highest positive Markdown quality must be at least the highest HTML quality to select Markdown.
- Unspecified quality values default to `1`; quality `0` is excluded; equal positive Markdown and HTML qualities select Markdown.
- A wildcard-only or absent `Accept` header does not explicitly request Markdown.
- `?format=markdown` and `?format=md` select Markdown regardless of `Accept` on ordinary documentation URLs.
- Explicit `.md` and `.pdf` suffixes retain the selected export format regardless of `Accept` or `format`.
- HTML and negotiated Markdown responses include `Vary: Accept`.
- Vercel deployments can automatically return Markdown to recognized live-assistant fetchers; explicit suffixes and `Accept` avoid dependence on user-agent detection.

Configure the Markdown wrapper by merging these optional boolean fields into the existing `docs.json`:

```json
{
  "x-margin": {
    "agents": {
      "indexPreamble": false,
      "markdownFrontmatter": true,
      "assistantMarkdown": true
    }
  }
}
```

- `x-margin.agents.indexPreamble` defaults to `true`; the preamble links to the locale/version-scoped documentation index and other enabled discovery surfaces.
- `x-margin.agents.markdownFrontmatter` defaults to `false`; enabling frontmatter adds YAML fields `title`, `url`, `updated`, and `description` when available. `updated` uses `YYYY-MM-DD`.
- `x-margin.agents.assistantMarkdown` defaults to `true`; disabling automatic Vercel assistant Markdown does not disable `.md`, explicit Markdown `Accept` headers, or `?format=markdown`.
- `x-margin.agents` Markdown wrapper settings do not change PDF output.
- `x-margin.agents.contentSignals` controls content-use declarations, not the Markdown export wrapper.
- `x-margin.agents.mcpInstructions` controls MCP instructions, not the Markdown export wrapper.

## Not supported

- Ordinary documentation URLs have no JSON page representation.
- `Accept: application/pdf` on a human page URL does not select PDF; use the `.pdf` URL.
- PDF is not a browser screenshot; browser layout and interactive components are not guaranteed to survive export.
- PDF does not fetch external image URLs.
- Per-page agent-signal switches are not `x-margin.agents` settings.

## Errors

| Error identifier or body marker | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `Page not found` | 404 | Markdown page does not exist. | Read similar-page suggestions and the documentation-index link when available; retry an existing `.md` URL. |
| `No documentation page matches` | 404 | PDF page does not exist. Response is plain text, not PDF. | Read closest-page suggestions and retry an existing `.pdf` URL. |
| `This URL serves text/html, or text/markdown when the Accept header asks for it.` | 406 | An ordinary docs request accepts neither HTML nor Markdown, such as `Accept: application/json` alone. | Retry the absolute URL in the JSON `markdown` field or send `Accept: text/markdown`. The `Link` header also advertises the alternate Markdown URL. |

## Verify

Inspect the saved Markdown response headers and body:

```bash
cat markdown.headers
head -n 12 quickstart.md
```

Expect `200` and `Content-Type: text/markdown; charset=utf-8`. After publishing the configuration fragment above and fetching again, expect YAML frontmatter followed by the title and agent text, without a documentation-index preamble.
