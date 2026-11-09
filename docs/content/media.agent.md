# Publish images and supported repository assets

Reference media in the docs tree so Margin rewrites local source paths to content-addressed asset URLs. Use this workflow for images, fonts, and videos, and configure external host admission for CSS and supported config asset fields.

## Do this

Run from the docs root containing `docs.json` to create an SVG and an MDX page that displays and links to the SVG:

```sh
mkdir -p images content
cat > images/diagram.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160" viewBox="0 0 640 160">
  <rect width="640" height="160" fill="#f1f5f9"/>
  <circle cx="320" cy="80" r="48" fill="#2563eb"/>
</svg>
SVG
cat > content/demo.mdx <<'MDX'
---
title: Asset demo
---

![Blue circle centered on a light background](/images/diagram.svg)

[Open the original diagram](../images/diagram.svg)
MDX
```

Commit both files and ingest the docs. Open the demo page and confirm the image and the original-diagram link both load.

## Facts

- `/images/diagram.svg` resolves from the docs root, which is not necessarily the repository root.
- `../images/diagram.svg` in `content/demo.mdx` resolves to `images/diagram.svg` in the docs root.
- CSS local asset references resolve from the CSS file's directory; config local asset references resolve from `docs.json`.
- Supported local image extensions are `.png`, `.jpg`, `.jpeg`, `.svg`, `.webp`, `.gif`, and `.ico`.
- Supported local font extensions are `.woff` and `.woff2`.
- Supported local video extensions are `.mp4`, `.webm`, and `.mov`.
- Local asset extension admission is case-insensitive.
- Each local asset must be at most 20,971,520 bytes (20 MiB).
- Local asset rewriting covers Markdown images, links, reference definitions, and literal MDX `src`, `href`, `poster`, `icon`, and `img` attributes with supported asset extensions.
- Local asset paths must identify ingested files with matching spelling and case; `.mintignore` and `.docsignore` can exclude assets.
- Margin rewrites resolving local references to `/_assets/<hash>` using a 64-character hexadecimal SHA-256 hash of the admitted bytes.
- SVG sanitization removes scripts, event handlers, and unsafe references before hashing.
- Query strings and fragments survive rewriting: `/images/diagram.svg#preview` becomes `/_assets/<hash>#preview`.
- Identical admitted bytes share a hash; changed bytes change the hash.
- Source pages should retain repository paths rather than hard-coded `/_assets/<hash>` URLs.
- Moving a source page changes relative path resolution; root-relative asset references avoid that dependency.
- Markdown images and `Image` use the same responsive click-to-zoom renderer.
- `Image.src` is the source URL; `Image.alt` is a text alternative and defaults to an empty string.
- `Image.width` and `Image.height` set dimensions. Margin adds intrinsic dimensions to readable local images when neither dimension is authored on `Image`; author both dimensions when overriding.
- `Image.loading` accepts `eager` or `lazy`; the first article image defaults to `eager`, and later article images default to `lazy`.
- `Image.decoding` accepts `auto`, `sync`, or `async`; the first article image defaults to `auto`, and later article images default to `async`.
- `Image.fetchPriority` accepts `high`, `low`, or `auto`; the first article image defaults to `high`, and later article images have no explicit priority.
- `Image.srcSet` replaces generated responsive candidates when authored.
- Margin can generate stored-image candidates at 640, 960, 1440, and 1920 pixels when width is known; only candidates below the intrinsic width are used, and the original remains the largest candidate.
- External images do not receive generated asset `srcSet` candidates.
- Visible captions belong on a wrapping `Frame` via `caption`; `Image.alt` is not a visible caption.

Use the following MDX instead of the Markdown image when explicit image attributes are needed:

```text
<Image
  src="/images/diagram.svg"
  alt="Blue circle centered on a light background"
  width="640"
  height="160"
/>
```

The rendered example is a responsive 640 by 160 image of a blue circle on a light background. Clicking the image opens the zoom view.

Merge the following block into existing `docs.json` to permit external hosts for CSS URLs and supported config asset fields:

```json
{
  "x-margin": {
    "assets": {
      "allowExternal": ["cdn.example.com", "images.example.com"]
    }
  }
}
```

- `x-margin.assets.allowExternal` is an optional string array.
- `fonts.googleapis.com` and `fonts.gstatic.com` are always allowed; configured hosts add to the defaults.
- External host matching is exact and case-insensitive on the hostname; `cdn.example.com` does not match `sub.cdn.example.com`.
- Full URL entries in `x-margin.assets.allowExternal` are reduced to hostnames; paths and ports do not restrict admission.
- The external host matcher accepts HTTP, HTTPS, and protocol-relative URLs.
- Page-content external images remain browser-loaded pass-through URLs; `x-margin.assets.allowExternal` does not reject external images in page content.
- Disallowed external config asset references are removed with `asset_missing`; disallowed CSS URL declarations are removed with `css_sanitized`.
- The supported external CSS stylesheet import is an HTTPS Google Fonts stylesheet from `fonts.googleapis.com`.

## Not supported

- Local static asset publication does not admit PDFs, ZIP archives, CSV files, or other unlisted media extensions. Use an absolute HTTPS link to an externally hosted file instead.
- Page/config admission for `.md` or `.json` does not publish files as downloadable static assets.
- Markdown asset links do not force downloads.
- Computed MDX asset URL expressions are not the literal references supported by asset rewriting.
- Wildcard allow-list entries such as `*.example.com` do not match subdomains.
- `x-margin.assets.allowExternal` does not permit arbitrary CSS `@import` rules and is not a site-wide image firewall.
- A successful deployment does not guarantee working media. Missing page-content local references remain unchanged after an ingest warning.
- Unsupported extensions may be ignored without asset-specific diagnostics.

## Errors

These identifiers are ingest diagnostics, not HTTP response errors.

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `asset_missing` | Not applicable | Local asset was not ingested. | Check path, case, docs root, commit inclusion, supported extension, `.mintignore`, and `.docsignore`. |
| `asset_missing` | Not applicable | Config asset host is not allow-listed. | Add the exact hostname to `x-margin.assets.allowExternal` or use a local asset. |
| `asset_oversize` | Not applicable | Asset exceeds 20,971,520 bytes. | Compress below the cap or host externally. |
| `field_invalid` | Not applicable | Invalid UTF-8 SVG was skipped. | Export valid UTF-8 SVG or use a supported raster format. |
| `css_sanitized` | Not applicable | Disallowed CSS URL or unsupported import was removed. | Admit the host when applicable or replace the unsupported import with local CSS. |

## Verify

After ingest, open the demo page and inspect the image element. A resolved local `src` contains `/_assets/` followed by a 64-character hash, and the image request succeeds.

Follow the original-diagram link independently to confirm the separate Markdown link resolved. A rendered image alone does not verify the link.
