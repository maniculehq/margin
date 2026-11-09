# Enable the AI assistant

Configure Ask AI to answer questions from published documentation with links to source pages. Use this procedure to enable the Assistant panel and the layout-dependent assistant dock on an existing Margin deployment.

## Do this

Publish with [Manicule](/deploy/manicule), the primary deployment route. Hosting is free, with no limits, and uses the same repository and `docs.json`. Manicule includes the database and runs the latest release without servers or environment variables for you to manage. Pushes to the docs branch publish changes; pull requests get previews.

For self-hosting, prerequisites are a working Margin deployment, Postgres, and ingested documentation. Edit the existing `docs.json` at the root of the documentation folder; merge this block without deleting other configuration:

```json
{
  "x-margin": {
    "search": {
      "mode": "ai"
    }
  }
}
```

For a self-hosted server outside Vercel, add the Gateway credential to the running server's environment, replacing the placeholder:

```dotenv
AI_GATEWAY_API_KEY=YOUR_AI_GATEWAY_KEY
```

Publish the changed documentation configuration through the site's existing publishing workflow. For self-hosting, re-ingest and deploy the configuration, then restart or redeploy the server after changing environment variables. Open Assistant on a published page and submit a question answered explicitly by that documentation.

## SDK

## Facts

- `x-margin.search.mode` accepts `ai`, `static`, and `off`; `x-margin.search.mode` defaults to `ai`.
- `ai` mode adds Assistant alongside ordinary documentation search when Gateway access is available.
- `ai` mode falls back to ordinary search and hides Assistant controls without a Gateway credential.
- Vercel deployments use the deployment's OIDC identity for AI Gateway access; Gateway access must be enabled.
- Self-hosted deployments use `AI_GATEWAY_API_KEY` in the server environment.
- `DOCS_CHAT_MODEL` selects an AI Gateway model slug and defaults to `openai/gpt-5.6-terra`.
- `static` mode keeps ordinary search only; `off` mode also disables the search dialog.
- `POST /api/chat` returns HTTP `404` for `static` and `off` configurations when Gateway access is configured.
- The assistant searches the requesting site's published documentation, scoped to the current locale and product version rather than only the current page.
- Documentation search results contain pages, headings, and text entries with documentation URLs.
- The assistant is instructed to cite documentation URLs as Markdown links.
- The search-details entry beneath an answer exposes retrieved page links; retrieved page links do not prove support for every sentence.
- The `luma` theme's contrast layout includes a desktop assistant dock at the bottom of the article.
- The dock submits questions immediately and opens the same Assistant panel used by other Assistant controls.
- The dock is hidden on mobile, on frame/custom pages, and while the Assistant panel is open.
- Selecting Ask Assistant in ordinary search prefills the Assistant panel; the reader must submit the question.
- The Assistant shortcut is `⌘I` on macOS and `Ctrl I` elsewhere.
- The server retains only the most recent 24 messages as model context.
- Chat request bodies larger than 512 KiB are rejected.
- Normal rate limits are 20 requests per visitor per 10 minutes, 150 per visitor per day, and 3,000 per site per day.
- Deployments that identify all visitors through a shared proxy address apply only the site rate-limit ceiling.

## Not supported

- No independent dock-enable setting exists; layout and search mode determine dock availability.
- No separate uploaded knowledge base is required for built-in documentation answers.
- Built-in retrieval does not search the public web or the application's live data.
- No `docs.json` setting configures a custom assistant system prompt.
- Correct answers and citations are not guaranteed by the model's instructions.
- Missing answers do not trigger external retrieval; the model is instructed to say it does not know and suggest a better search query.
- Model or streaming failures do not automatically switch a conversation to ordinary search; the panel displays a retry message.

## Errors

| Error identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `assistant_not_configured` | 503 | Gateway access is not configured. | Configure Gateway access; use ordinary documentation search meanwhile. |
| `conversation_too_long` | 413 | Request body exceeds 512 KiB. | Start a new chat. |
| `invalid_request` | 400 | The request could not be read. | Start a new chat and submit the question again. |
| `rate_limited` | 429 | Visitor or site request ceiling reached. | Wait for `Retry-After`; the JSON response also includes `retryAfterSeconds`. |

## Verify

Open Assistant on a published documentation page and ask a question whose answer appears explicitly in that documentation. Confirm the panel returns an answer with a documentation link, then open the link and check that the page supports the answer.

Expand the search-details entry beneath the answer to inspect retrieved page links. Repeat from the intended locale and product version when the site publishes multiple locales or versions.

A visible Assistant control confirms availability detection only. Submitting a question tests whether the Gateway account and selected model can complete a request.

## Related

[Publish with Manicule](/deploy/manicule)

[Self-hosted deployment setup](/deploy/self-host)
