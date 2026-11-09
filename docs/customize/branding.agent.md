# Set logos, favicons, and icons

Configure the header logo, browser favicon, and icon references in a Margin docs site. Use explicit configuration when conventional asset detection selects the wrong image or the site needs theme-specific branding.

## Do this

Run from the docs directory containing `docs.json`. Set the three source paths to existing SVG or PNG files; the command copies those images into the docs directory and merges branding fields without replacing other configuration.

```sh
export LIGHT_LOGO_SOURCE="/absolute/path/to/logo-light.svg"
export DARK_LOGO_SOURCE="/absolute/path/to/logo-dark.svg"
export FAVICON_SOURCE="/absolute/path/to/favicon.png"
python3 - <<'PY'
import json
import os
import shutil
from pathlib import Path

root = Path.cwd()
config_path = root / "docs.json"
config = json.loads(config_path.read_text())
images = root / "images"
images.mkdir(exist_ok=True)
for variable, filename in [
    ("LIGHT_LOGO_SOURCE", "logo-light.svg"),
    ("DARK_LOGO_SOURCE", "logo-dark.svg"),
    ("FAVICON_SOURCE", "favicon.png"),
]:
    source = Path(os.environ[variable]).resolve()
    target = images / filename
    if source != target.resolve():
        shutil.copyfile(source, target)
config["logo"] = {
    "light": "/images/logo-light.svg",
    "dark": "/images/logo-dark.svg",
}
config["favicon"] = "/images/favicon.png"
config["icons"] = {"library": "lucide"}
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
```

Use SVG sources for both logo variables and a PNG source for the favicon variable; copying a file does not convert its format. Publish the updated configuration and assets together.

## Facts

- `logo` and `favicon` are top-level `docs.json` fields; explicit values take precedence over detection.
- Local asset paths begin at the docs directory root; admitted local references become `/_assets/` URLs during ingest.
- Repository image asset formats include SVG, PNG, JPEG (`.jpg`, `.jpeg`), WebP, GIF, and ICO. SVGs are sanitized during ingest.
- Logo detection order is a complete `logo/light.svg` plus `logo/dark.svg` pair, `logo.svg`, `logo.png`, `logo/logo.svg`, `logo/logo.png`, then `logo/logo.gif`, `logo/logo.jpeg`, `logo/logo.jpg`, or `logo/logo.webp` in filename order.
- Conventional asset detection compares paths without case sensitivity.
- An incomplete conventional `logo/light.svg` plus `logo/dark.svg` pair is not selected as a pair.
- A detected single logo uses a sibling with `-dark` before the extension for dark mode when the sibling exists; otherwise the detected image serves both themes.
- A string `logo` value serves both themes. An object `logo` value requires `light` and `dark`; optional `href` sets an absolute click destination. The default click destination is `/`.
- An absent selected logo displays the site name. `"logo": null` disables logo detection and displays the site name.
- Favicon detection order is `favicon.ico`, `favicon.svg`, `favicon.png`, a PNG derived from the resolved local light logo, then a generated monogram.
- The monogram favicon uses the first character of the site name and the primary color; the fallback color is `#18181b`.
- `favicon` accepts a string or an object with required `light` and `dark` strings. `"favicon": null` emits no favicon links and disables detection and generation.
- Light/dark favicon selection uses browser `prefers-color-scheme`, which can differ from the docs site's selected theme.
- `icons.library` defaults to `fontawesome`. Accepted values are `fontawesome`, `lucide`, and best-effort `tabler`.
- FontAwesome and Lucide names map to bundled Hugeicons glyphs; original library artwork is not guaranteed.
- Navigation `icon` strings accept names, local image paths, or HTTP(S) image URLs. Use root-relative local image references such as `/images/build.svg`.
- Navigation groups and tabs accept `icon`. Individual page icons belong in page frontmatter.
- Icon names accept kebab-case and PascalCase, including `book-open` and `BookOpen`.
- The page frontmatter `icon: rocket` sets a page navigation icon; page frontmatter also accepts image references.
- Page content supports literal attributes such as `<Icon icon="rocket" size={20} color="#2563eb" />` and `<Card title="Quickstart" icon="book-open" href="/quickstart">Publish a documentation page.</Card>`.
- `Icon` accepts an image reference such as `<Icon icon="/images/build.svg" size={20} />`.
- `Icon` defaults to 16 pixels; positive sizes up to 128 pixels are accepted, and other sizes fall back to 16.
- `Icon` color affects named glyphs, not image files.
- Unknown icon names produce `icon_unresolved` and use the default glyph.

## Not supported

- An explicit light/dark logo object does not automatically fill in a missing member.
- `tabler` does not select a separate complete Tabler icon set; names resolve through the available map.
- Raw SVG markup is not an authorable `icon` value.
- A per-page navigation object is not the documented mechanism for assigning a page icon; use page frontmatter.
- Site theme selection does not directly control light/dark favicon selection.

## Errors

These identifiers are ingest diagnostics, not HTTP response errors.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `logo_multiple` | N/A | Multiple conventional logos exist. Highest-priority candidate wins. | Set an explicit `logo` to choose the intended asset. |
| `asset_missing` | N/A | A referenced local asset is missing, or the light logo cannot be decoded for favicon generation. | Include the referenced file or configure a valid favicon explicitly. |
| `icon_lib_unsupported` | N/A | `icons.library` selects best-effort `tabler`. | Use `lucide` or `fontawesome` names. |
| `icon_unresolved` | N/A | An icon name is unknown or an icon value contains raw SVG markup. | Use a supported name or an image reference. |

## Verify

After publishing, inspect the header in both site themes and the browser tab in both browser color preferences. Local image URLs should resolve under `/_assets/`; the navigation should show the chosen icons, with no `asset_missing` or `icon_unresolved` diagnostics for the new files.
