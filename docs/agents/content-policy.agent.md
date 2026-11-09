# Set content signals and crawler policy

Configure intended uses of public documentation through `x-margin.agents.contentSignals` in `docs.json`. Use these settings to publish search, AI-input, and training preferences, not to restrict access.

## Do this

Run this command from the documentation repository root to permit search and AI input while declining training. The command preserves other configuration keys.

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path('docs.json')
config = json.loads(path.read_text())
agents = config.setdefault('x-margin', {}).setdefault('agents', {})
signals = agents.setdefault('contentSignals', {})
signals.update(search=True, aiInput=True, aiTrain=False)
path.write_text(json.dumps(config, indent=2) + '\n')
PY
```

Publish the updated `docs.json` through the site's normal deployment process, then run the verification commands against that deployment.

## Facts

- `x-margin.agents.contentSignals.search` accepts JSON `true` or `false`, defaults to `true`, and declares use for search.
- `x-margin.agents.contentSignals.aiInput` accepts JSON `true` or `false`, defaults to `true`, and declares use as input to AI systems.
- `x-margin.agents.contentSignals.aiTrain` accepts JSON `true` or `false`, defaults to `true`, and declares use for training AI models.
- Each omitted content-signal field defaults independently to `true`, even when `x-margin.agents` is absent.
- `true` serializes as `yes`; `false` serializes as `no`. The serialized token order is `search`, `ai-input`, `ai-train`.
- The example configuration produces `Content-Signal: search=yes, ai-input=yes, ai-train=no`.
- The discovery middleware adds `Content-Signal` to successful (`2xx`) `GET` and `HEAD` responses with HTML, Markdown, or plain-text content types when the site configuration resolves.
- `/robots.txt` repeats the serialized `Content-Signal` in each user-agent group.
- `/robots.txt` contains groups for `*`, `GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`, `Claude-User`, `PerplexityBot`, `Google-Extended`, `Applebot-Extended`, and `CCBot`.
- Each `/robots.txt` group contains an `Allow` directive scoped to the site's URL path; a root-hosted site uses `/`.
- `/robots.txt` advertises the site's `sitemap.xml`.
- A crawler selects the most specific matching user-agent group; repeating `Content-Signal` avoids dependence on wildcard-group inheritance.
- Content signals are site configuration, not per-page frontmatter overrides.

## Not supported

- Content signals do not authenticate requests, block downloads, prevent copying of public content, or guarantee client compliance. Private content requires separate access controls.
- `x-margin.agents.contentSignals` has no separate citation permission field. `aiInput` does not require an answer to cite documentation.
- `x-margin.agents` does not expose custom `User-agent`, `Disallow`, or crawl-delay settings.
- Setting `aiTrain: false` does not generate a `Disallow` rule or deny crawler requests.
- `markdownFrontmatter`, `indexPreamble`, and `assistantMarkdown` do not add permission categories.
- Content policy is not emitted as a Markdown-body YAML frontmatter field or an `agent-signals` comment field.
- `Content-Signal` is not guaranteed on redirects, errors, or response types outside HTML, Markdown, and plain text.

## Verify

Set `SITE_URL` to the deployed documentation URL, including any base path and without a trailing slash. Fetch the home page headers and the crawler file:

```bash
SITE_URL="https://docs.example.com"
curl --fail --silent --show-error \
  --dump-header - \
  --output /dev/null \
  "$SITE_URL/"
curl --fail --silent --show-error \
  "$SITE_URL/robots.txt"
```

The home page response must contain `Content-Signal: search=yes, ai-input=yes, ai-train=no` for the example configuration; header names may be lowercase. Every `/robots.txt` user-agent group must contain the same signal and an `Allow` path matching the documentation site's base path. If the header differs, check that the requested deployment contains the updated `docs.json`.
