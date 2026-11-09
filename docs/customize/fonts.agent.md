# Configure site fonts

Configure site-wide body, heading, and code fonts in `docs.json`. Use this when changing typography without changing page content.

## Do this

Run this from the directory containing the existing `docs.json` to select Google Fonts Roboto for body text and inherited headings while preserving other configuration fields:

```sh
python3 - <<'PY'
import json
from pathlib import Path

path = Path("docs.json")
config = json.loads(path.read_text())
config.setdefault("fonts", {})["body"] = {"family": "Roboto"}
path.write_text(json.dumps(config, indent=2) + "\n")
print(json.dumps(config["fonts"]["body"]))
PY
```

Expected output is `{"family": "Roboto"}`. Deploy the updated configuration, then check the rendered body font in browser developer tools. Existing `fonts.heading` and `fonts.mono` overrides remain unchanged.

## Facts

- `fonts` is a top-level `docs.json` field, outside `x-margin`, and applies across the site.
- `fonts.family` sets body and UI text; headings inherit the body font unless `fonts.heading.family` is configured.
- `fonts.body.family` takes precedence over `fonts.family` for body and UI text.
- `fonts.heading.family` applies to H1 through H6 without changing body text.
- `fonts.mono.family` sets monospace text, including code.
- `fonts`, `fonts.body`, `fonts.heading`, and `fonts.mono` accept `family`, `source`, `format`, and `weight`.
- `family` is a font-family string; a family without `source` can resolve through Google Fonts.
- `source` is a font-file URL; a configured `source` prevents Google Fonts family resolution for that face.
- `format` accepts `woff` and `woff2`; the default for a supplied file is `woff2`.
- `weight` is a number that requests a Google Fonts weight or declares the supplied file's weight; `weight` does not set every element's text weight.
- A supplied file without `weight` is declared for weights 100 through 900; use a matching variable font or specify the file's actual weight.
- The bundled body and UI font is Inter with CSS family `InterVariable`.
- The bundled code font is Geist Mono with CSS family `GeistMono`.
- Removing `fonts` or setting `fonts` to `{}` restores bundled defaults.
- Custom sans-serif font stacks retain Inter and system sans-serif fallbacks.
- Custom monospace font stacks retain Geist Mono and system monospace fallbacks.
- Bundled fonts have metric-adjusted local fallbacks based on Arial and Courier New.
- Google Fonts stylesheets resolve during ingest; stored font rules load binaries from `fonts.gstatic.com` when visitors open the site.
- The browser loads configured external font files directly; external font hosts must permit cross-origin font requests from the documentation site.
- Custom CSS supports `@font-face` and HTTPS Google Fonts stylesheet imports from `fonts.googleapis.com`.
- Google Fonts CSS imports resolve during ingest with a maximum of 8 distinct imports.
- External URLs in custom CSS must use `fonts.googleapis.com`, `fonts.gstatic.com`, or a host in `x-margin.assets.allowExternal`.
- Generated social-preview images use Geist Sans by default and are outside the scope of site text font settings.

## Not supported

- A Google Fonts stylesheet URL is not a font-file `source`; configure the Google Fonts family without `source` instead.
- CSS `@import` hosts other than `fonts.googleapis.com` are removed.
- A configured `font-family` declaration does not prove that the browser loaded the font file.

## Errors

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable; ingest warning | Google Fonts family could not be resolved. | Correct the Google Fonts family name or provide a public font-file `source`. The fallback stack renders until the font resolves. |

## Verify

After deployment, inspect rendered fonts for body text, an H1 through H6 heading, and a code block in browser developer tools. Body text should render in Roboto; headings should render in Roboto unless a heading override exists; code should retain Geist Mono unless a monospace override exists.

For external fonts, confirm a successful font-file request in the browser Network panel. The rendered-font inspection must show the requested face rather than only a fallback.
