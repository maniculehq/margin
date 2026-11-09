# Configure analytics integrations

Sites [hosted on Manicule](/deploy/manicule) also get agent traffic and AI-citation analytics in Manicule, free, with no limits and nothing to install, showing which crawlers and coding agents read pages, which ChatGPT, Claude, and Perplexity answers cite your docs, and how often assistants recommend them.

Configure browser analytics through the top-level `integrations` object in `docs.json` and enable page feedback separately. Use this when deploying provider identifiers or checking whether a page vote was accepted and stored.

## Do this

Merge this configuration into the existing `docs.json`, preserving other settings. Replace `G-XXXXXXXXXX` with the GA4 project's browser measurement ID.

```json
{
  "integrations": {
    "ga4": {
      "measurementId": "G-XXXXXXXXXX"
    }
  },
  "feedback": {
    "thumbsRating": true,
    "suggestEdit": true,
    "raiseIssue": true
  }
}
```

Publish a new deployment containing the edited `docs.json`. Open the deployed article, check the GA4 loader in browser developer tools, then click a page-helpfulness button and inspect the feedback request.

## SDK

Configure browser providers through `docs.json`; no SDK is needed for this configuration.

## Facts

- Multiple configured integrations coexist; Margin loads each configured integration independently.
- Margin ingests `docs.json` into the deployment; editing local configuration does not modify an existing deployment.
- Host-level analytics suppression disables configured browser integrations regardless of the identifiers in `docs.json`.
- Margin owns integration bootstrap code and official script origins.

Each provider value is an object under `integrations`:

| Provider key | Required fields | Optional fields |
| --- | --- | --- |
| `ga4` | `measurementId`: string starting with `G`, normally `G-…` | None |
| `posthog` | `apiKey`: string starting with `phc_` | `apiHost`; default `https://us.i.posthog.com` |
| `plausible` | `domain`: string | None |
| `fathom` | `siteId`: string | None |
| `clarity` | `projectId`: string | None |
| `amplitude` | `apiKey`: nonempty string | None |
| `mixpanel` | `projectToken`: nonempty string | `region`: `us` (default), `eu`, `in` |
| `segment` | `key`: nonempty browser-source write key | None |
| `hotjar` | `hjid`: numeric site ID as number or digit string | `hjsv`: number or string; default `6`; nondigit values fall back to `6` |
| `intercom` | `appId`: nonempty string | None; initializes the messenger |

- PostHog accepts `apiHost` values `https://us.i.posthog.com`, `https://eu.i.posthog.com`, `https://us.posthog.com`, and `https://eu.posthog.com`.
- PostHog custom hosts, paths, queries, and fragments are ignored with a warning; the API key remains enabled and ingestion falls back to the default US host.
- Mixpanel `region: "eu"` selects `https://api-eu.mixpanel.com`; `region: "in"` selects `https://api-in.mixpanel.com`; omitted `region` uses default US ingestion.
- GA4 receives `gtag("config", measurementId)` initialization; later page-view behavior depends on provider settings.
- Mixpanel initializes with `track_pageview: "url-with-path"`.
- Segment sends `page()` on initial load and subsequent resolved navigation when the pathname changes.
- PostHog initializes with provider defaults and `capture_exceptions: false`.
- Amplitude initializes with element-interaction autocapture disabled.
- Plausible, Fathom, Clarity, and Hotjar use official script behavior, without a Margin-defined shared event schema.
- Intercom boots initially and receives `update` with `last_request_at` on pathname changes.
- `feedback.thumbsRating`, `feedback.suggestEdit`, and `feedback.raiseIssue` are optional booleans; all default to off.
- `feedback.suggestEdit` and `feedback.raiseIssue` require a site repository binding with an owner and repository name before links appear.
- The edit link opens the GitHub source file using the bound branch and docs subdirectory; the issue link opens a prefilled new-issue form, without submitting an issue.
- A page vote sends same-site `POST /api/agent/feedback`, prefixed with the site's base path when applicable, with the page URL, `kind: "helpful"` or `kind: "not_helpful"`, and `source: "page_widget"`; page votes contain no comment.
- `POST /api/agent/feedback` acknowledges accepted input with HTTP `202` and `{"ok":true,"received":true}`.
- The page-feedback thank-you message appears optimistically even when the request fails.
- HTTP `202` confirms acceptance, not storage; asynchronous writes can fail or be dropped by rate limits without changing the acknowledgment.
- Framework feedback persistence targets `docs_agent_feedback` with site, served content version, page URL, page-existence result, vote kind, and source.

## Not supported

- Google Tag Manager (`gtm`) is parsed but not executed.
- Unknown integration keys are stored as ignored configuration, diagnosed with `integration_unsupported`, and not executed.
- Plausible `server` is ignored with an `integration_unsupported` warning; custom Plausible script origins are not supported.
- A nondigit Hotjar `hjid` disables Hotjar with an `integration_unsupported` warning.
- Integration keys do not provide a generic custom-script mechanism or consent-management configuration.
- Browser integration keys do not automatically forward page votes, search events, or Assistant events into a common provider event stream.
- Server-side agent observability is separate from browser integration keys.
- The `feedback` object does not configure a webhook destination, email recipient, or third-party analytics sink.

## Errors

Check the `integration_unsupported` cases above when a configured provider does not load. Feedback acknowledgments do not confirm storage; use the database check below to confirm persistence.

## Verify

Run this expression in the deployed page's browser console to check the GA4 script element. A matching script URL confirms the loader is present, not event delivery.

```javascript
Array.from(document.scripts, script => script.src)
  .filter(src => src.startsWith("https://www.googletagmanager.com/gtag/js?id="))
```

Check Network requests for the configured provider's script:

| Provider | Script request |
| --- | --- |
| GA4 | `www.googletagmanager.com/gtag/js?id=…` |
| PostHog | `us-assets.i.posthog.com/static/array.js` or `eu-assets.i.posthog.com/static/array.js` |
| Plausible | `plausible.io/js/script.js` |
| Fathom | `cdn.usefathom.com/script.js` |
| Clarity | `www.clarity.ms/tag/…` |
| Amplitude | `cdn.amplitude.com/script/….js` |
| Mixpanel | `cdn.mxpnl.com/libs/mixpanel-2-latest.min.js` |
| Segment | `cdn.segment.com/analytics.js/v1/…/analytics.min.js` |
| Hotjar | `static.hotjar.com/c/hotjar-….js?sv=…` |
| Intercom | `widget.intercom.io/widget/…` |

Check outgoing collection requests and the provider's event tools, then navigate between docs pages without reloading to test pathname changes. Check blocked requests and project identifiers or regions when events do not arrive.

Click Yes or No with Network open; expect `POST /api/agent/feedback` to return HTTP `202` with `{"ok":true,"received":true}`. Database operators can confirm stored page-widget feedback with this query:

```sql
SELECT site_id, page_url, kind, source, created_at
FROM docs_agent_feedback
WHERE source = 'page_widget'
ORDER BY created_at DESC
LIMIT 10;
```

Match the row's site, page URL, vote, and timestamp to the test submission.

## Related

See [Manicule hosting](/deploy/manicule) for hosted deployment.
