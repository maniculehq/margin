# The Zero-Config Docs Deployment Standard

**Status:** Public standard (v1) · **Applies to:** Margin single-site deployments and build-time ingest · **Config file:** `docs.json`

A documentation folder deploys on this platform **with zero configuration files**. A folder containing a single `.mdx` file becomes a branded, navigable, indexed site. Any configuration that does exist is **optional** and expresses only a *delta* over what the filesystem already declares.

`docs.json` is a **drop-in superset of Mintlify's `docs.json`**: an unmodified Mintlify configuration deploys here with correct behavior for every field this standard supports, unsupported fields are ignored gracefully (never a hard error), and beyond-Mintlify power lives in a single reserved `x-margin` namespace. Migration effort from Mintlify is zero.

This document is the durable contract for what a conforming implementation must do. It is written to be read like the Next.js file-convention reference: normative, exhaustive on the field surface, and grounded in worked examples.

---

## Table of contents

0. [Conformance language & core model](#0-conformance-language--core-model)
1. [The filesystem standard](#1-the-filesystem-standard-the-zero-config-default-path)
2. [The `docs.json` superset — field inventory](#2-the-docsjson-superset--field-inventory)
3. [Precedence model](#3-precedence-model)
4. [Theming & custom-CSS contract](#4-theming--custom-css-contract)
5. [v1 feature specifications](#5-v1-feature-specifications)
6. [Build-time ingest and storage](#6-build-time-ingest-and-storage)
7. [Schema reference](#7-schema-reference)
8. [Migration note — verbatim Mintlify repo](#8-migration-note--verbatim-mintlify-repo)
9. [Conformance](#9-conformance)

---

## 0. Conformance language & core model

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** are to be interpreted per RFC 2119.

### 0.1 The three invariants

A **site source** is the documentation folder read by build-time ingest. The default deployment serves one `docs_site` row and the content snapshot baked into its server bundle. Three invariants govern the entire standard.

- **INV-1 — Zero config is the baseline.** A site source containing only content (**at least one `.md`/`.mdx` file**) MUST deploy and serve correctly with no `docs.json`, no `meta.json`, and no frontmatter beyond what is derivable. Configuration is a strictly-optional delta over filesystem-derived defaults; it is never a prerequisite.
- **INV-2 — No site-authored code ever executes with host access.** No JavaScript, JSX, or React shipped in a site source runs in the server process. The only site-controlled runtime surfaces are (a) sanitized CSS, (b) serializable data (design tokens, navigation, SEO metadata, redirects, and analytics *keys*), and (c) **compiled MDX**, which executes in exactly two places: the visitor's browser on the site's own origin, and — for the server-rendered article — inside a **V8 isolate with no host objects** (isolated-vm, `src/lib/sandbox-render.ts`): no `process`, `require`, `fetch`, timers, DOM, or I/O of any kind; only the framework's own render bundle is loaded; 250 ms CPU and 128 MB heap per render, a fresh context per page, and any failure serves the stored agent rendition as sanitized static article HTML until hydration. The HTML the isolate returns is itself held to §4.6 on the host before it enters the server document (the server-output guarantee, §4.6), so server-emitted markup is never more permissive than page MDX may produce. The isolate is a second gate behind the ingest AST allow-list (§4.6), never a replacement for it. Analytics scripts are framework-owned loaders parameterized by site *data*, never site *code*; an integration value that would select a script origin or an executable container (rather than supply a data-only key) is **not** honored (§5.5). Because **MDX is itself an executable format**, this invariant is enforced at ingest by an AST-level fail-closed validation pass over every page and snippet (the **MDX security contract**, §4.6), not merely by banning `.js`/`.jsx` filenames. This is the absolute security boundary of the server.

The isolate invariant and §4.6 are retained verbatim as the security contract,
amended only by the server-output sanitization guarantee (§4.6).
Source references in those clauses correspond to `src/lib/sandbox-render.ts`,
`src/sandbox/render.tsx`, and `src/ingest/validate.ts` in this repository.
§4.6 preserves the original contract
text, including older admission restrictions. §4.7 describes the current
compiler's admission behavior; the host-free isolate invariant remains in force.

- **INV-3 — Drop-in Mintlify superset.** An unmodified Mintlify `docs.json` deploys with correct behavior for every field this standard supports; unsupported fields are ignored gracefully and MUST NOT hard-fail a push. Framework-specific customization lives under a single namespaced top-level key, **`x-margin`**.

> **A note on the `x-margin` namespace and Mintlify-side validation.** This standard requires only that an *unmodified* Mintlify file deploy here — the parser tolerates and ignores fields it does not model (`.passthrough()`, §7). The converse claim — that a file carrying our `x-margin` extensions still validates against *Mintlify's own* JSON Schema — is **best-effort and unverified**: if Mintlify's schema sets `additionalProperties: false`, an extra top-level key would fail their validator. We do not depend on that. `x-margin` is chosen because `x-` is the conventional extension prefix (OpenAPI, JSON-Schema idiom), it is unambiguously namespaced, and it cannot collide with a hypothetical future top-level Mintlify field named `x`.

### 0.2 Two orthogonal notions of "version"

Two independent axes both use the word "version"; conflating them breaks the data model, so this standard keeps them strictly separate.

- A **content version** is a git-commit snapshot produced by build-time ingest for a commit — an immutable row in `docs_content_version`. Its `kind` is `production` or `preview`; its `seq` is monotonic deploy history. This is **deploy history**.
- A **product version** is `v1` vs `v2` of the documentation itself — a user-facing switch in the navbar. Product versions are **path partitions *within* a single content version** (§5.2), recorded in a `versions_manifest` JSON column. A product version is **NOT** a separate `docs_content_version` row.

Every artifact a site deploys — pages, theme tokens, sanitized CSS, navigation, redirects, SEO, product-version partitions — resolves into **one content version** and is frozen there.

### 0.3 Disposition vocabulary

Every Mintlify field, and every convention, has exactly one documented **disposition** in this standard:

| Tier | Meaning |
|------|---------|
| **Supported** | Read and honored with Mintlify-equivalent behavior. |
| **Adapted** | Honored, but mapped onto a fumadocs primitive with a defined, documented difference. |
| **Ignored** | Parsed without error; no runtime effect. A build **diagnostic** records why. |
| **Extended** | Not in Mintlify; lives under `x-margin.*`; adds capability within the tokens+CSS ceiling. |

The Adapted tier is the honest tier: it is where a field means something slightly different here than in Mintlify (most importantly `theme`, §4.2), and the migration report (§8) names every Adapted field so a migrating user is never surprised.

### 0.4 The customization ceiling and floor

- **Floor:** everything Mintlify offers is expressible here (colors, fonts, logos, favicon, layout dimensions, navigation, redirects, analytics, SEO).
- **Ceiling:** design **tokens** plus a conventional **custom stylesheet**. Configuration selects serialized data or sanitized CSS, never arbitrary host-process modules. Authored MDX and local snippets are a separate executable article-content surface (§4.7). We deliberately exceed Mintlify at the token/CSS layer (full `--color-fd-*` / `--fd-*` surface, layout dimensions, a synthesized radius token), never at the code layer.

---

## 1. The filesystem standard (the zero-config default path)

This section defines what a bare site source *means* with **no `docs.json`**. Derivation always runs first and produces the defaults that configuration (§2) later overrides.

### 1.1 The one required thing

A deployable site source tree MUST contain **at least one page** — one `.md`/`.mdx` file anywhere under the site's `subdir`. That is the sole hard requirement. Title, navigation, tabs, theme, logo, favicon, CSS, SEO, and OpenAPI are all derived or defaulted.

```
docs/                 ← the entire deployable repo
└── index.mdx         ← "# Getting Started\n\nWelcome."
```

This tree MUST produce: a site titled *Getting Started* (from the H1), a one-item sidebar, the default (neutral) palette, an auto-generated favicon, a sitemap, `robots.txt`, `llms.txt`, and OG metadata — with **no `docs.json`**.

### 1.2 Reserved filenames (root-relative, case-insensitive on the basename)

Each reserved name is a *slot* whose semantics the framework defines. Presence activates the slot; absence falls back to a framework default. "Root" means the root of the site's `subdir`.

| Path pattern | Slot | Zero-config behavior when present | When absent | Required? |
|---|---|---|---|---|
| `**/*.mdx`, `**/*.md` | **page** — one URL each | A page exists at the derived slug (§1.5). | — | ≥1 page MUST exist |
| `**/index.{mdx,md}` | folder landing page | Becomes that folder's landing URL and contributes its default title; the folder/tab/version-root URL. | Folder has no landing page; clicking expands. | optional |
| `**/meta.json` | per-directory nav ordering & folder attributes | Orders/labels that directory (§1.7); marks tabs (`root:true`) and product-version roots. | Title-sorted order, folder name titleized. | optional |
| `docs.json` (root) | superset config (§2) | Parsed as a delta over derived defaults, per key. | Full filesystem derivation. | optional |
| `mint.json` (root) | **legacy** Mintlify config | Accepted only as a fallback alias for `docs.json` when `docs.json` is absent. | — | optional |
| `**/{openapi,swagger}.{json,yaml,yml}`, `*.openapi.*`, `*.swagger.*` | OpenAPI spec | Auto-discovered anywhere; generates an API-reference section (§2.3 `api.openapi`; nav placement vs a present `navigation` block defined there). | — | optional |
| `**/*.asyncapi.{json,yaml,yml}` | AsyncAPI spec | **Ignored (reserved)** in v1; diagnostic. | — | optional |
| `**/*.css` | site stylesheet(s) | **All** admitted `.css` files are ingested, sanitized, and concatenated in **lexicographic path order**, then injected scoped to this site (§4.3) — Mintlify parity (Mintlify picks up every `.css` in the repo). `theme.css`/`styles.css`/`style.css` at root are the conventional names, not a priority order. | fumadocs defaults only. | optional |
| `logo/light.svg` + `logo/dark.svg`, `logo.{svg,png}`, `logo-dark.{svg,png}` (root) | brand logo | Auto-detected navbar logo, per-mode (§1.8). | Site name rendered as text. | optional |
| `favicon.{ico,svg,png}` (root) | favicon | Auto-detected (§1.8). | Auto-generated from logo, else a monogram of the site's initial. | optional |
| `images/**`, `assets/**`, `public/**` | static assets | Root-relative references resolve here; ingested to `docs_asset` and served hash-addressed (§4.5). | — | optional |
| `snippets/**/*.{mdx,md}` | reusable MDX fragments | Importable and transcluded into pages at ingest (§4.7). | — | optional |
| `snippets/**/*.{js,jsx,ts,tsx}` | local component modules | Compiled and bundled into the page; executed only in the browser or server-render isolate (§4.7). | — | optional |
| `.mintignore` \| `.docsignore` | publish-exclude list | `.gitignore`-syntax; matched files are neither admitted, published, indexed, nor URL-reachable. | Nothing excluded beyond non-admitted extensions. | optional |

**No authored code executes with ingest host access.** Local `.js`, `.jsx`, `.ts`, and `.tsx` files under `snippets/` are admitted as source and compiled without evaluation. Other script files, including `mint.config.js`, are not a configuration or module-loading surface. Compiled MDX and snippet logic run in the browser or server-render isolate, subject to the current admission rules in §4.7.

> **Byte-preserving admission (MUST).** The folder reader admits Markdown, MDX, JSON, YAML, CSS, images, and fonts. It returns textual entries as decoded strings and binary entries as raw `Uint8Array`; image/font bytes MUST NOT pass through a lossy text decoder. CSS remains textual. SVG sanitization happens before hashing (§4.5).

### 1.3 Reserved directory-name syntax (folder semantics from the name — Extended)

Borrowed from the Next.js App Router, applied to the **nav tree** (and, where noted, the URL). This is a framework extension: Mintlify has no such convention.

| Folder-name form | Meaning |
|---|---|
| `foo/` | Ordinary nav group / URL segment `foo`, titled *Foo*. |
| `(group)/` | Nav grouping label only — the segment is **excluded from the URL** (transparent routing group). |
| `_draft/` or any leading-underscore folder | Opted out of routing and nav (draft); not published **unless** explicitly referenced by a `navigation` or `meta.json` entry (see the compat carve-out below). |
| `versions/`, or sibling `v1/`,`v2/`,`2.1/` at root | Product-version roots (§5.2). |
| `<locale>/` (ISO 639-1) with a sibling locale | Language root when `navigation.languages[]` names it (§5.6). A filesystem-only locale folder (no `languages` config) is an ordinary group. |

Directory reserved-name detection is **conservative** to avoid false positives:

- A folder literally named `versions` is always a version container.
- A folder named `v2` (or a semver-like `2.1`) is a version root **only when a sibling `v1`/`v3`/`versions` also exists**. A lone `v2` folder is an ordinary group, plus a `DIAG_VERSION_AMBIGUOUS` diagnostic suggesting the explicit `versions/` form.

> **Mintlify compat carve-out (MUST).** The `(group)` and leading-underscore forms are Extended semantics that Mintlify does not define, so a verbatim Mintlify repo will not use them intentionally. To guarantee a Mintlify repo's slugs and publication are never silently altered: **when a page inside a `(group)/` or `_underscore/` folder is explicitly referenced by a `navigation` block or a `meta.json` `pages[]` entry, that explicit reference publishes the page** (the opt-out is overridden by the explicit reference), and its URL is taken as authored. Transparent-group URL stripping applies only in pure filesystem-derivation mode.

### 1.4 Derivation rules (each fills a Mintlify field's default)

When configuration is absent, a conforming implementation derives:

- **Which pages exist / routes / slugs:** the filesystem walk (unchanged; `pathToSlugs`, `compile.ts`). Config CANNOT create or delete pages — only hide or reorder them.
- **Title:** frontmatter `title` → first Markdown H1 → humanized filename (§1.6).
- **Description:** frontmatter `description` → else an **excerpt derived from the page's first non-heading paragraph** (trimmed to a meta-description length). This makes the §2.1 site `description` default ("first page's description/excerpt") and the §5.4 derived-description SEO default reachable with zero config; a page/site is only description-less when no frontmatter description exists *and* the page has no body prose. **Icon:** frontmatter only; otherwise unset.
- **Nav order & labels:** `meta.json.pages[]` → else title-sorted with `index` hoisted first (§1.7).
- **Folder titles:** `meta.json.title` → else humanized directory name.
- **Tabs:** none by default; a tab appears only when a directory's `meta.json` sets `root: true` (§5.1) or config declares `navigation.tabs`.
- **Product versions:** none by default; detected per §1.3 / §5.2 or declared in config.
- **Theme:** framework default palette (`neutral`) unless tokens, brand assets, or CSS are detected (§1.9).
- **Logo / favicon:** the detection cascades of §1.8.
- **Site name:** `docs.json.name` → root `index.{md,mdx}` H1 → DB `docs_site.name` → humanized repo/slug name. The root-index H1 is a genuine zero-config source and sits **above** the DB name so a bare repo's H1 surfaces as the title; the DB `docs_site.name` is the operational last-resort branding fallback (it is `notNull`, so it always exists, but it only wins when neither config nor content supplies a name).
- **`lastModified`:** git commit metadata at ingest (already available), feeding `metadata.timestamp` when enabled.
- **Root landing page (MUST) — when no root `index.{md,mdx}` exists.** A conforming bare repo need not ship a root index (INV-1 requires only ≥1 page anywhere). When the site root has no `index.{md,mdx}`, the framework **synthesizes** the `/` landing rather than 404-ing : it renders an **auto-generated index** listing the top-level nav sections/pages (title + first-paragraph excerpt where available), derived from the same nav tree §1.7 builds. The synthesized root is `noindex` by default (it is generated, not authored) and is superseded the moment a real root `index` is added or a `navigation`/`redirects` rule targets `/`. **The identical rule applies to a version root with no `index` (§5.2) and a `(group)`-only root** (a root whose only children are transparent `(group)` folders): synthesize a section-listing landing for that base URL. This closes the zero-config landing gap for a legitimate bare tree.

### 1.5 Slug derivation

Slugs derive as the current pipeline does, extended for the §1.3 folder syntax:

1. Strip the `.mdx`/`.md` extension.
2. Split on `/`.
3. Drop a trailing `index` segment (folder landing pages).
4. Drop `(group)` segments (transparent groups).
5. Drop the active product-version / locale prefix segment (routed via base path, §5.2/§5.6).

`guides/intro.mdx` → `/guides/intro`. `api/(rest)/users.mdx` → `/api/users`. Post-derivation slugs MUST be unique; collisions fail the build (§1.10).

### 1.6 Title derivation (retire the "title required" rule)

Frontmatter `title` becomes **OPTIONAL**. This retires a title-required restriction that would violate zero-config behavior . A page's title resolves by the first available source:

1. Frontmatter `title`.
2. The first H1 (`# …`) in the document body.
3. The filename, titleized (`getting-started.mdx` → *Getting Started*; `index.mdx` → the parent folder name titleized, else the site name for root `index`).

A titleized filename is always available, so **no page ever fails to build for lack of a title**. The site name (navbar title, `<title>` suffix, OG site name) resolves by: `docs.json.name` → root `index.{md,mdx}` H1 → DB `docs_site.name` → repo name, titleized. Because the root-index H1 outranks the (always-present, `notNull`) DB name, the §1.1 bare-repo example titled *Getting Started* from its H1 is reachable with no config; the DB name is the last-resort branding fallback the §3.1 L6 note describes.

### 1.7 Nav-order derivation

The sidebar tree is generated from the filesystem walk (fumadocs `loader()`), ordered by:

1. **`meta.json.pages[]`, if present in a directory,** is authoritative for that directory and supports the full fumadocs `pages[]` grammar: `"name"` reference, `"..."` rest (append unlisted, path/title order), `"z...a"` reverse rest, `"...folder"` flatten, `"!name"` exclude, `"---Label---"` / `"---[icon]Label---"` / `"---"` separators, and `"[Text](url)"` / `"external:[Text](url)"` links. If the list omits a terminal `"..."`, unlisted files in that directory are **hidden from nav but remain URL-reachable** (Mintlify unlisted semantics at directory granularity).
2. **Else:** pages sorted **by title, case-insensitive**, with the folder `index` always first. A frontmatter `sidebar_position` (integer) or `order` MAY override within a directory — lower sorts first, ties broken by title.

Folder default-open state: `meta.json.defaultOpen`, else folders within two levels of the active page are open.

### 1.8 Logo & favicon detection (fully ordered cascade)

Purely conventional; no config required. A `docs.json` `logo`/`favicon` key overrides detection, and an explicit `null` opts out (§3.3).

- **Logo**, resolved in strict order:
  1. `logo/light.svg` **+** `logo/dark.svg` (per-mode pair)
  2. `logo.svg`
  3. `logo.png`
  4. `logo/logo.*`
  5. none → render the site name as text.
- **Dark-mode pairing:** if only a single `logo.*` is found, it is used in both modes; a `*-dark.*` sibling (e.g. `logo-dark.svg`) is auto-paired as the dark-mode asset.
- **Favicon**, resolved in strict order:
  1. `favicon.ico`
  2. `favicon.svg`
  3. `favicon.png`
  4. **auto-generated** from the light logo (server-rendered raster — SHOULD; requires the image subsystem and the byte-preserved logo asset, §6.1/§4.5)
  5. a **monogram** of the site name's first letter on the primary color. **This is the zero-dependency floor** (§9.1) and MUST be emittable as an SVG/CSS-text glyph without a rasterizer, so a favicon link is always present even before the image subsystem lands.

Detected assets set the corresponding `docs.json` defaults.

### 1.9 Theme detection

Zero-config theme is the `neutral` layout preset with the framework's `mint` palette (§4.2). Two conventions enrich it without any `docs.json`:

- **Any `.css` file present** (conventionally `styles.css`/`theme.css`/`style.css`) → all admitted `.css` files are ingested, sanitized, and concatenated in lexicographic path order, then injected (§4.3). A site that wants only brand colors can ship a three-line stylesheet overriding `--color-fd-primary`.
- **Accent from logo (SHOULD, best-effort):** when a logo asset is detected and **neither** `docs.json.colors` **nor** a `--color-fd-primary` override in the site stylesheet is present, the framework MAY derive a primary accent from the logo's dominant non-neutral color. This is a soft enhancement so a logo-only repo still gets brand color with zero config. It MUST be overridable and MUST NOT run when any explicit color source exists.

### 1.10 Collision and diagnostic rules

Hard content failures include structural corruption, identity collisions, and security violations:

- `foo.mdx` **and** `foo/index.mdx` both present → **hard build failure** (ambiguous slug; keeps `compile.ts` discipline).
- Post-derivation duplicate slugs → **hard failure**.
- Broken internal link → **hard failure** (keeps `validate.ts`). **Carve-out:** an inline OpenAPI operation reference (`"GET /users"` under an `openapi`-bearing nav node, §2.2) resolves to a generated endpoint page and is **exempt** from this check — it is not a filesystem slug, so it MUST NOT be treated as a broken internal link. In the versioned case, links are validated in the per-version **served-URL** space (§5.2), not the raw `versions/…` path space.
- Structurally corrupt `docs.json` (unparseable JSON) → **hard failure** (no safe default).
- An **MDX admission violation** (§4.7) — a denied intrinsic element, spread or authored event-handler attribute, raw HTML block, or disallowed literal URL scheme → **hard failure**. Unknown component names instead unwrap to their children with a diagnostic. Expression-valued props and bound local snippet components are admitted; the host-free execution invariant applies to their server rendering.

Recoverable configuration and discovery issues use diagnostics and defaults. Operational failures and storage limits still stop ingest (§6):

- `docs.json` **and** `mint.json` both present → `docs.json` wins, `DIAG_CONFIG_DUAL` (warn).
- Two logo raster candidates (`logo.svg` + `logo.png`) → deterministic priority `svg > png`, `DIAG_LOGO_MULTIPLE` (info).
- Multiple stylesheets anywhere in the source → **all** are injected, concatenated in lexicographic path order (§4.3, the single deterministic rule); `DIAG_CSS_MULTIPLE` (info). (This is a deterministic, non-fatal merge — the deployment never rejects a push over CSS.)
- Unknown top-level `docs.json` field → ignored, `DIAG_UNKNOWN_FIELD` (info).
- Malformed **known** field (e.g. `colors.primary: "blue"`) → field dropped, default applied, `DIAG_FIELD_INVALID` (warn); build proceeds.
- A local script snippet that fails compilation or imports an unsupported module produces a snippet diagnostic and scoped fallback; supported `.js/.jsx/.ts/.tsx` snippet components are bundled into the page.

All diagnostics are collected into a per-version **discovery report** (persisted on the content version, §6.2) and surfaced to the site in build output. Non-fatal diagnostics never block serving.

### 1.11 Sample bare repos

**Absolute minimum** (§1.1): a single `index.mdx`. Deploys as a one-page, neutral-themed, favicon-generated, indexed site.

**Rich zero-config** — no `docs.json` at all:

```
docs/
├── index.mdx                   # →   (title from H1)
├── logo/
│   ├── light.svg               # per-mode navbar logo
│   └── dark.svg
├── favicon.svg
├── styles.css                  # --color-fd-primary: #7C3AED;  (brand accent)
├── guides/
│   ├── meta.json               # { "title": "Guides", "pages": ["intro", "auth", "..."] }
│   ├── intro.mdx
│   └── auth.mdx
├── reference/
│   ├── meta.json               # { "root": true, "title": "Reference", "icon": "book" }  → a TAB
│   └── index.mdx
├── versions/
│   ├── v2/index.mdx            # highest → default; version switcher auto-synthesized
│   └── v1/index.mdx
└── api.openapi.yaml            # auto-discovered → API reference + playground
```

This deploys branded (purple accent, per-mode logo), tabbed, versioned, with API docs — **no config file**.

---

## 2. The `docs.json` superset — field inventory

`docs.json` is optional. When present it is a **delta** over §1 derivation. A conforming parser MUST:

- accept any valid Mintlify `docs.json` **verbatim**;
- treat unknown keys (top-level or under `x-margin`) as Ignored (info diagnostic), never fatal;
- treat `null` on a **detectable** field as an explicit opt-out — distinct from omission, which means "use the derived default" (vercel.json semantics; §3.3).

Mintlify marks `theme`, `name`, `colors`, and `navigation` **required**. Under INV-1, **all four are optional** here because each is derivable (§1). Files that supply them still deploy.

Every field below documents its **disposition** (§0.3), its **zero-config default** (what §1 derives when the field is omitted), and its **`null` opt-out semantics** where detection exists.

### 2.1 Identity, theming, layout

| Field | Type | Disposition | Zero-config default | `null` | Behavior |
|---|---|---|---|---|---|
| `$schema` | string (uri) | Ignored | — | — | Editor tooling only. We publish our own superset schema URL. |
| `name` | string (≥1) | Supported | derived site name (§1.6) | — | Site/navbar title, `<title>` suffix, OG site name. |
| `description` | string | Supported | first page's description/excerpt | — | Site-level SEO/OG description default. |
| `theme` | enum(9) | **Adapted** | `neutral` preset | — | `theme` selects a **framework-owned layout preset** (§4.2) — a CSS + fixed-component-composition implementation the framework ships, plus a palette + typographic defaults — recorded as a `layout_preset` value in the ingest output (§6.2). **No site code is involved:** the preset is chosen by data and every preset is implemented by the framework. Our presets *approximate* Mintlify's layout engines rather than reproducing them byte-for-byte, which is the one deliberate visual difference the migration report names. Unmapped/unknown → `neutral` + diagnostic. |
| `public` | boolean | Ignored | — | — | All served content is public in v1; access control is a deployment concern; sidebar visibility is not authorization. |
| `colors` (`primary`/`light`/`dark`, hex) | object | **Supported** | neutral tokens (+ optional logo accent §1.9) | force neutral; ignore logo accent | → `--color-fd-primary` per mode (§4.1). |
| `logo` (string \| `{light,dark,href}`) | — | Supported | detected (§1.8) | text-only navbar | String → both modes; object → per-mode + click-through `href`. Served as `<img>` (no JS). |
| `favicon` (string \| `{light,dark}`) | — | Supported | detected/generated (§1.8) | no favicon link | |
| `appearance` (`default`, `strict`) | object | **Adapted** | `system` | — | `default` → `RootProvider.theme.defaultTheme`; `strict:true` → `themeSwitch.enabled:false`. Not filesystem-detected, so `null` is not a distinct opt-out (§3.3): a literal `"appearance": null` is treated as omission → `system` default (a `field_invalid` info diagnostic may note it). |
| `background` (`image`, `decoration`, `color`) | object | **Adapted** | none | — | `color` → `--color-fd-background` per mode; `image` → asset + scoped CSS; all `decoration` values (`gradient`/`grid`/`windows`) → **framework-owned decoration CSS/composition** (§4.2) selected by the data value — no site code, so `windows` is Adapted (a framework-implemented decoration preset), not Ignored. Not detected → `null` == omission (§3.3). |
| `fonts` (family/weight/source/format, or `{heading,body}`) | object | **Adapted** | fumadocs default sans/mono | — | Emits `@font-face` (self-host `source`) + `--font-sans`/`--font-mono` + a `body{font-family}` rule (fumadocs has no font token, §4.3). Google family → allow-listed `<link>` to `fonts.googleapis.com`. The split `{heading,body}` form carries the **full per-role face** (`family`/`weight`/`source`/`format`, §7 `fontFaceSchema`), so a self-hosted heading face still emits its own `@font-face` instead of silently losing `source`/`format`. Not detected → `null` == omission (§3.3). |
| `icons.library` (`lucide`\|`fontawesome`\|`tabler`) | object | **Adapted** | `lucide` | — | `lucide` Supported (native `lucideIconsPlugin`). `fontawesome`/`tabler` → best-effort name pass-through, unresolved names fall back to a default icon + `DIAG_ICON_LIB_UNSUPPORTED`. Not detected → `null` == omission (§3.3). |
| `styling.eyebrows` (`section`\|`breadcrumbs`) | — | **Adapted** | `section` | — | CSS toggle; breadcrumbs render by default. |
| `styling.latex` | boolean | Supported | off | — | Enables the KaTeX remark/rehype plugin at compile. |
| `styling.codeblocks` (Shiki theme) | — | **Supported** | fumadocs default | — | Shiki theme name / `{light,dark}` → the highlighter config in `compile.ts`. `system` = follow mode. |
| `banner` (`content`, `type`, `dismissible`, `color`) | object | **Supported** | none | — | `content` (basic MDX) → fumadocs `<Banner>`; sets `--fd-banner-height`. `type` maps `info`→`--color-fd-info`, `warning`→`--color-fd-warning`, **`critical`→`--color-fd-error`** (fumadocs has no `critical` token — see §4.1). `dismissible` honored via client cookie (no site JS). Not detected → `null` == omission (§3.3). |
| `navbar.links[]`, `navbar.primary` | object | **Supported** | GitHub link derived from repo | no nav links | → fumadocs `links` as `type:"custom"` chrome items: the docs layout has no top navbar and its sidebar renders `Main`/`Button` items identically to page-tree entries, so `navbar.links` become muted compact links (mail/external glyph) and `navbar.primary` a full-width button anchor, both above the page tree. `primary.type:"github"` feeds the GitHub-link fallback chain (socials win, repo binding last). Links are validated independently; malformed entries are dropped with `field_invalid` while valid siblings render. Live star/member counts Ignored (need runtime fetch) + diagnostic. |
| `footer.socials`, `footer.links[]` | object | **Supported** | none | none | Social keyed map → icon row; `links[]` uses Mintlify columns `{header,items:[{label,href}]}` (1–4 columns) → serialized footer menus. Columns and items are validated independently; a malformed item is dropped with a warning without discarding valid footer siblings. |
| `search.prompt` | object | Supported | app `AISearch` on | — | Placeholder text; the search *backend* stays the app's `AISearch` (§5.5, `x-margin.search`). |

### 2.2 Navigation

Navigation is the **sole all-or-nothing (wholesale-replace) field** in the standard (§3). Every other field is a per-key delta. **Zero-config default** for every field in this table is uniform: absent a `navigation` block, the tree is §1 filesystem derivation — so defaults are stated inline in Behavior rather than repeated in a column.

| Field | Disposition | Behavior |
|---|---|---|
| `navigation` (root object) | **Supported** | When present it is **authoritative site-wide**: pages not listed are hidden from nav but remain URL-reachable (Mintlify semantics). Absent → §1 derivation. It replaces filesystem/`meta.json` nav *structure* wholesale — it does not affect page existence, slugs, per-page frontmatter, or the DB registry. **Two carve-outs (MUST):** (1) a page's own frontmatter `hidden:true` still hides it even if listed here (§3.1 `hidden` tiebreak); (2) an auto-discovered OpenAPI section (§2.3) that the block does **not** reference (via a tab/group/version/language `openapi` key) is treated exactly like any other unlisted content — its generated endpoint pages stay **URL-reachable but are hidden from nav** (the block is authoritative), with a `DIAG_OPENAPI_ORPHANED` (warn) so the omission is visible — see the `api.openapi` row. Auto-appending an unreferenced spec into the visible nav happens **only** in filesystem-derivation mode (no `navigation` block). |
| `pages[]` | Supported | Page strings + nested groups → fumadocs `Item`/`Folder` children. **Endpoint page references (MUST):** a page string matching `^(GET\|POST\|PUT\|PATCH\|DELETE\|HEAD\|OPTIONS)\s+/` (e.g. `"GET /users"`) is a Mintlify inline OpenAPI operation reference, **not** a filesystem slug. When such a string appears under a node carrying an `openapi`/`asyncapi` key, it resolves to the **generated endpoint page** for that operation; it is exempt from the §1.10 broken-internal-link fatal check. Outside an OpenAPI-bearing node an endpoint-shaped string with no matching generated page is a `DIAG_FIELD_INVALID` (warn), dropped from nav — never a hard failure. |
| `groups[]` (`group`,`pages`,`root`,`icon`,`tag`,`expanded`,`hidden`,`searchable`,`boost`,`public`,`directory`) | Supported / Adapted | → fumadocs `Folder` (`root`→root folder, `defaultOpen`←`expanded`, `icon`, separator via `tag`). `hidden`/`searchable` Supported (index-but-hide, §5.4). `boost` Ignored (search backend owns ranking). `public` Adapted to site-level visibility only. `directory` (`accordion`/`card`) → CSS-driven landing render. |
| `tabs[]` (`tab`,`icon`,`href`,`hidden`,`searchable`,`align`,`directory`, **+ children** `languages`/`versions`/`dropdowns`/`menu`/`groups`/`pages`/`openapi`/`asyncapi`/`global`) | **Supported** | → `root:true` folders / top tab bar (`x-margin.layout.tabMode`). `align` Adapted (fumadocs has no per-tab align; `end` Ignored). `tab.href` (external) → nav link instead of a folder. The `tabNodeSchema` carries exactly Mintlify's tab child set so a verbatim tab-with-menu / tab-with-dropdowns renders real items. |
| `anchors[]` (`anchor`,`href`,`icon`,`color`,`hidden`,`directory`, **+ children** `groups`/`pages`) | **Adapted** | Sidebar anchors (with `groups`) → top-level `root` folders; navbar/global anchors (`href` only) → nav `links`. Per-anchor `color` → inline token on that element. |
| `dropdowns[]` (`dropdown`,`icon`,`description`,`color`,`href`,`hidden`,`directory`, **+ children** `languages`/`versions`/`tabs`/`anchors`/`products`/`groups`/`pages`) | **Supported** | A dropdown is a **full navigation container** (like a tab), not a leaf link. → fumadocs `MenuItemType` whose items are built from its child `groups`/`pages`/`tabs` (§5.1). The `dropdownNodeSchema` carries exactly Mintlify's dropdown child set so a verbatim Mintlify dropdown bearing groups/tabs/products renders its items instead of an empty menu. `href`-only dropdown → a plain nav link. |
| `versions[]` (`version`,`href`,`default`,`hidden`,`tag`,`directory`, **+ children** `languages`/`tabs`/`groups`/`pages`/`openapi`/`asyncapi`/`global`) | **Supported** | → framework-synthesized product-version switcher (§5.2); fumadocs has no native version primitive. The §7 `versionNode` nests `languages`/`tabs`/`groups`/`pages` so a version's whole subtree is modeled, not trapped in `.passthrough()`. |
| `languages[]` (`language`,`href`,`default`,`hidden`,`directory`, **+ children** `versions`/`tabs`/`groups`/`pages`/`openapi`/`asyncapi`/`global`) | **Supported** | A language node is a full nav container that nests the content tree beneath it (the §7 `languageNode` carries the recursive children). Every language is served (§5.6): the default unprefixed, the others under their locale tag, each with its own navigation tree, a header language switcher, `lang`, and `hreflang` alternates. |
| `products[]` (`product`,`name`,`href`,`icon`,`color`,`description`,`hidden`,`directory`, **+ children** `languages`/`versions`/`tabs`/`anchors`/`groups`/`pages`/`menu`/`openapi`/`asyncapi`/`global`) | **Adapted** | Every root `navigation.products[]` container renders in the navbar: `href` products are links; products without `href` become `MenuItemType` dropdowns populated from their child tabs, anchors, menu entries, groups, and pages, using synthesized landing URLs where the navigation compiler supplies them. This preserves a visible product selector instead of collapsing all products into one sidebar. Backed by the §7 `productNode` (a real container, not `z.object({product}).passthrough()`) so each product's nested tree compiles instead of being dropped. |
| `global` (`languages`/`versions`/`tabs`/`dropdowns`/`anchors`/`products`) | Supported | Elements rendered on every section (persistent anchors/links) → nav `links` with `on:'all'`. Backed by the typed §7 `globalNode` container, not an untyped record. |
| `*.menu[]` (menu-item node: `item` required, + `icon`/`description`/`href`/`hidden`/`directory` **+ children** `groups`/`pages`/`tabs`/`dropdowns`/`anchors`/`products`/`versions`/`languages`/`openapi`/`asyncapi`/`global`) | Supported | A tab/dropdown/product mega-menu. Each `menu[]` entry is a **menu-item node** (`item` is the required discriminant) with its own full nested children → mega-menu items. Backed by the §7 `menuItemNode` schema (mirrored into `tabNode.menu`, `productNode.menu`, and `navigationSchema`) so the Supported claim is a real node contract modeling Mintlify's full menu-item child set, not `.passthrough()` limbo. |
| `*.sdk` (`format`,`source`,`directory?`) | **Adapted (typedoc) / Unsupported yet (docfx, javadoc, sphinx, phpdoc) / remote sources Deferred** | An SDK-reference node: `source` is a **generated documentation artifact** (never SDK source code, and no generator ever runs at ingest). `format: "typedoc"` is Adapted: the artifact is the JSON from `typedoc --json`, read from a **local path inside the docs snapshot**; ingest extracts a normalized symbol model (`sdk.ts`) and generates **deterministic markdown reference pages** (one per top-level exported symbol + an index page, capped at 500 pages / 30MB artifact) under the node's `directory` (default: a slug of the node title). Generated pages compile through the standard MDX pipeline (kind `mdx`, stored hast, search/agent markdown), and their stems are appended to the node's `pages`, so placement follows ordinary page-ref rules. The other four formats parse but generate nothing — per-format `DIAG_UNSUPPORTED_FIELD` (warn). **Remote (https) sources are Deferred** until the hardened ingest fetcher lands — a warn diagnostic says so; commit the artifact into the docs repo. Malformed/oversize artifacts warn and the node generates nothing; the snapshot still publishes. |
| node modifiers `searchable`,`boost`,`public`,`hidden`,`directory`,`align` | **Adapted/Ignored** | As per the `groups[]` row; `boost`/`align:end` Ignored with diagnostic. |

Per-node-type required fields are enforced by distinct node schemas (§7): a tab MUST carry `tab`, a group MUST carry `group`, a version MUST carry `version`, and so on. Unknown keys within a node are tolerated (`.passthrough()`).

### 2.3 API / SEO / integrations / behavior

Each row's **zero-config default** is stated inline (bolded) in Behavior; where a field is omitted the default applies.

| Field | Disposition | Behavior |
|---|---|---|
| `api.openapi` / `api.asyncapi` | **Supported** (openapi) / **Ignored** (asyncapi v1) | OpenAPI → existing pipeline (`openapi.ts`); overrides convention discovery. AsyncAPI reserved + diagnostic. **OpenAPI nav placement vs a present `navigation` block (MUST):** OpenAPI specs are auto-discovered anywhere (§1.2) and today auto-appended into the ancestor directory's `meta.json` `pages` (`compile.ts`) — i.e. they are L2/L3-derived structure the wholesale rule would otherwise nuke. So: when a `navigation` block **references** the spec (a tab/group/version/language node carrying an `openapi` key), that reference **owns placement**. When the block is present but does **not** reference an auto-discovered spec, config wins: the generated API-reference section stays **URL-reachable but hidden from nav** (identical to any unlisted page), and a `DIAG_OPENAPI_ORPHANED` (warn) makes the omission visible so a spec is never silently un-navigable by accident. **Auto-appending an unreferenced spec into the visible nav is correct ONLY in filesystem-derivation mode** (no `navigation` block); a present block is authoritative and MUST NOT have unreferenced sections spliced into it. Inline HTTP-method page references (`"GET /users"`, §2.2 `pageRef`) under an `openapi`-bearing node resolve to the generated endpoint page. |
| `api.playground` (`display`,`proxy`,`credentials`) | **Adapted** | **Default `display: interactive`.** `display` (`interactive`/`simple`/`none`/`auth`) → fumadocs-openapi playground presence. `proxy` (default `true`) routes playground requests through the served `/api/proxy` (spec-server allowlisted). `credentials` applies ONLY to browser-DIRECT requests (Mintlify semantics): with `proxy: false` + `credentials: true` the playground fetch carries `credentials: "include"`; while the proxy is on, `credentials` has no effect and authored use draws an info `unsupported_field` diagnostic. |
| `api.params`, `api.examples`, `api.url` | **Adapted** | Best-effort map to fumadocs-openapi render options. `params.expanded` → expand-all sections; `params.post` admitted (round-trips) but pill rendering is not implemented — authored use warns (`unsupported_field`). `examples.languages`/`defaults`/`autogenerate` map to the sample-generator registry; `examples.prefill: true` is inherently satisfied (the playground always seeds fields from the selected example) while `prefill: false` is unimplementable without forking fumadocs internals — authored `false` warns (`unsupported_field`). `url: "full"` shows the whole request URL in the endpoint bar, resolved with OpenAPI server precedence (operation `servers` > path-item `servers` > root `servers`), server variables substituted by their declared defaults; a relative server renders as a path prefix (no origin fabricated); templated leftovers keep the bare path. Spec downloads (`/api/spec`) carry the originating page path (`?page=`) so the download resolves in that page's locale/version context. |
| `api.mdx` | **Unsupported** | Manual API pages (frontmatter `api: "METHOD /path"` without an OpenAPI reference) are not served as API consoles — only the sidebar method badge derives from the frontmatter — so `api.mdx`'s `server`/`auth` would configure nothing; authored use warns (`unsupported_field`). |
| `seo.metatags` | **Supported** | Emitted as `<meta>` tags in head; `<script>`/`<style>`/`<link rel=stylesheet>` in the map are **rejected at ingest** (INV-2). |
| `seo.indexing` (`navigable`\|`all`) | **Supported** | Controls sitemap inclusion and which pages carry `noindex,follow` (§5.4). Crawlers may fetch every production page so they can observe the directive. |
| `redirects[]` (`source`,`destination`,`permanent`) or `{"$ref"}` | **Supported** | Stored on the content version; served at the docs route and its format twins (§5.3). Mintlify's exact, `:param`, `:param*`, `*` and `prefix-*` forms; permanent (308) by default. Invalid patterns or uncaptured destination tokens are dropped with `redirect_invalid`. |
| `integrations.*` | **Supported (allow-listed)** | Framework-owned loaders for a key-only allow-listed subset (§5.5), each loading its script from a framework-pinned origin. Any value that selects a script origin or an executable container (e.g. `gtm`, `plausible.server`, a non-official `posthog.apiHost`) is **Ignored/dropped** (INV-2 — it is code, not a key) + diagnostic; other vendors parsed, stored, and diagnosed, never executed. |
| `contextual.options`, `contextual.display` | **Adapted** | **Default: on** (maps to the existing `.md` content negotiation). "Copy / view as markdown / open in ChatGPT/Claude" map to `.md` negotiation (`start.ts`); `display: header|toc` positions the control (**default `header`**). `download-pdf` **Adapted**: a per-page PDF of the stored page content, generated on demand at `<page>.pdf` (`routes/{$}[.]pdf.ts`). Unknown options Ignored. |
| `errors.404` (`redirect`,`title`,`description`) | Supported | **Default: the framework 404** (no custom page). Custom 404; `description`/`title` compiled as MDX at ingest. |
| `thumbnails` (`appearance`,`background`,`fonts`) | **Adapted** | OG/social card defaults (§5.4). `appearance` falls back to `appearance.default` when unset. `background` and `fonts.family` (Google Fonts names, 400/700) resolve at ingest into stored assets — the OG renderer never fetches a remote URL; failures degrade to the default palette/font with a diagnostic. |
| `interaction.drilldown` | **Adapted** | **Default `false`** (expand-only, matching §1.7 folder behavior). `true` → group click navigates to first page (fumadocs `Folder.index`); `false` → expand-only. |
| `metadata.timestamp` | Supported | **Default: off** (the §1.1 bare-repo output omits the timestamp). When enabled, "Last modified" from git; per-page frontmatter `timestamp` overrides. |
| `variables` | **Supported** | String key→value map substituted into MDX at compile (`{{var}}`; safe, data-only remark pass). |
| `variations` | **Supported** | `{ options: [{ id, label }, …] }` (non-empty; authored order; **first option is the default**) — site-wide content variations switched by the `<View title icon?>` MDX component. Mintlify scopes this to its willow theme; supported unconditionally here. Each run of consecutive sibling `<View>` blocks becomes one dropdown-switched group (a lone `<View>` is a group of one); a view whose `title` case-insensitively equals an option `label` joins the site-wide selection keyed by that option's `id`, persisted in one localStorage key — non-matching groups keep per-group local state. SSR/no-JS always shows the default view with the others `hidden`; the persisted choice applies after hydration (no SSR variance). The agent `.md` rendition flattens every view in source order as a `**title**`-labeled section — nothing hidden, deterministic. Invalid shape → dropped with `field_invalid` (siblings untouched). |
| `markdown.schema`, `markdown.instructions` | Supported | AI-facing: when `schema:true` and `$schema` is configured, include its URL in `llms.txt`; append `instructions` to `llms.txt`, `AGENTS.md`/skill guides, `.md` negotiation, `llms-full.txt`, agent context bundles, and MCP page reads. |

### 2.4 The `x-margin` extension namespace (Extended)

A single reserved top-level object. Every extension MUST stay within the tokens+CSS ceiling. All keys are optional; omission = derived/framework default. Unknown `x-margin.*` subkeys are Ignored with a diagnostic.

| `x-margin.*` key | Type | Purpose |
|---|---|---|
| `tokens` | object | Direct `--color-fd-*` / `--fd-*` overrides beyond Mintlify `colors` (`border`, `muted`, `card`, `accent`, `ring`, `popover`, `radius`, …), each a value or a `{light,dark}` pair. The typed, validated escape hatch below raw CSS (§4.1). |
| `css` | string \| string[] | Explicit stylesheet path(s), appended after auto-discovered `.css`, overriding the convention. `null` disables CSS injection even when `styles.css` exists. |
| `layout` | object | `contentWidth`, `sidebarWidth`, `tocWidth`, `headerHeight` → the `--fd-layout-*` dimension vars; `tabMode: 'top'\|'auto'`. |
| `head.meta` | array of `{name?,property?,content}` | Additional static `<meta>` tags only. No `<script>` and no `<link rel=stylesheet>`; rejected at ingest (`DIAG_HEAD_REJECTED`). |
| `assets.allowExternal` | string[] | Host allow-list for external image/font URLs referenced by CSS or config. Default: `fonts.googleapis.com`, `fonts.gstatic.com`. |
| `search` | object | `{ mode: 'ai' \| 'static' \| 'off' }` → framework search wiring. |
| `versions` | object | `{ default?: string }` — default product version (§5.2). |
| `seo` | object | Optional `titleTemplate`, `language`, `publisher`, and `provenance` facts (§5.4). Every property is optional and each malformed nested property is dropped independently. |
| `agents` | object | Content signals, index preamble, Markdown output, and MCP instructions. |

> `x-margin.tokens` is the *typed, safe* theming path; the site stylesheet is the *full-power, sanitized* path. Both feed §4.

---

## 3. Precedence model

There are six layers. **Higher number wins** for any single resolved value. Each layer is a *delta* over the one below; none re-declares the full surface. Non-inheritance holds: a versioned or nested subtree resolves its own L2–L5 locally and inherits nothing implicitly across a version boundary.

```
L6  Deployment + DB identity (SITE_ORIGIN, slug, status, selected content version)
L5  docs.json                (site-wide config delta; navigation block, when present, is authoritative for nav)
L4  frontmatter              (per-page: title, description, icon, hidden, sidebar_position, timestamp, api, mode)
L3  meta.json                (per-directory: order, labels, root/tab, group icons, version markers)
L2  filesystem derivation    (pages, slugs, default order/titles/tabs, logo/favicon/CSS/OpenAPI detection)
L1  framework defaults       (always present; fills every unspecified slot)
```

### 3.1 Layer semantics (MUST)

- **L1 (framework defaults)** fills every slot a site leaves empty: neutral palette, default layout dimensions, `system` appearance, `navigable` indexing.
- **L2 (filesystem derivation)** is the zero-config substrate — it produces the default for every derivable field.
- **L3 (`meta.json`)** overrides ordering/labels/tab-root/version markers **within its directory only**; it does not inherit into or out of sibling directories.
- **L4 (frontmatter)** overrides per-page attributes. Frontmatter is page-scoped and beats site-scoped config **for page-local keys only** (e.g. a page's own `title`/`description`/`hidden` beats derivation and site defaults). Site-structural keys (`navigation`) remain L5. This page-local inversion is the sole intentional exception and is documented per key in §7. **`hidden` tiebreak (MUST):** a page's own frontmatter `hidden:true` **always** removes it from nav, even when a present `navigation` block explicitly lists it — explicit inclusion in `navigation` cannot override a page's own opt-out. The page stays URL-reachable (hidden-not-deleted, §5.1). This is the one place the "navigation is authoritative" guarantee yields to page-local intent; it is the same page-local inversion, applied to `hidden`.
- **L5 (`docs.json`)** overrides site-wide behavior as a **per-key delta** — *except* `navigation`.
- **L6 (deployment and DB identity)** owns `SITE_ORIGIN`, routing `slug`, live status, and the selected content-version key. Content config MUST NOT override these. For the display name, content-derived branding is preferred to the database fallback; `SITE_NAME` is an explicit deployment override. A built deployment serves its baked commit, while development follows the current pointer.

**The one wholesale rule (MUST).** Navigation is the **sole all-or-nothing config**. A present L5 `navigation` block **replaces** L2/L3-derived nav *structure* entirely — this includes folder membership, order, labels, icons, tab-root designation, and version markers, all of which come from the block's own node props when it is present (a directory `meta.json` that would otherwise supply a folder label/icon/`root:true` is superseded). It hides unlisted pages (they stay URL-reachable). It does not touch L2 slug/URL existence, L4 per-page frontmatter, or L6. Every other field is a per-key delta. When `navigation` is absent, L2/L3 derivation stands. This is intentional (Mintlify semantics).

Two carve-outs that survive a present `navigation` block are stated explicitly elsewhere so the "authoritative" guarantee stays precise: a page's own frontmatter `hidden:true` still hides it even if the block lists it (§3.1 page-local inversion, below), and auto-discovered OpenAPI sections not referenced by the block stay **URL-reachable but hidden from nav** (never spliced into the authoritative tree) with a `DIAG_OPENAPI_ORPHANED` diagnostic rather than silently deleted (§2.2 `navigation` row, §2.3 `api.openapi`). Auto-*appending* an unreferenced spec into the visible nav is a **filesystem-derivation-mode-only** behavior — a present `navigation` block is never augmented with structure it did not declare.

### 3.2 Conflict-resolution table

| Value | Resolution order (first present wins) |
|---|---|
| Which pages exist | filesystem walk minus `.mintignore` (config cannot create/delete pages) |
| Page title | frontmatter `title` → first H1 → humanized filename |
| Page presence in nav | `navigation` block (membership required if present) → else all pages via `meta.json`/derivation |
| Nav order | `navigation` block → `meta.json.pages[]` → title sort (`index` first) |
| Folder label / icon / tab / version marker | `navigation` node props (when a `navigation` block is present) → `meta.json` → derived |
| Tab definition | `navigation.tabs[]` → `meta.json.root:true` folder → (none) |
| Brand color (effective `--color-fd-primary`) | site CSS `--color-fd-primary` rule → `x-margin.tokens.primary` → `colors.primary` → detected logo accent → preset default. **This is the real runtime cascade**: the sanitized site stylesheet is injected *after* the token block (§4.1/§4.3), so a `--color-fd-primary` rule in CSS wins over `colors`/`tokens`. Among the token sources, `x-margin.tokens.primary` outranks `colors.primary`. CSS is the intentional full-power escape hatch (§3.3, §4.3). |
| Custom CSS | additive; always injected *after* tokens (final cascade say) |
| Site name (display) | `docs.json.name` → root `index` H1 → DB `docs_site.name` → humanized slug |
| Active product version (this request) | leading URL segment → else the **default version** (cascade below) |
| Default product version | `meta.json x-margin-version-default` → `navigation.versions[].default` → `x-margin.versions.default` → highest by natural sort (full cascade + multiple-default tiebreak in §5.2) |
| Origin / slug / status / selected content version | Deployment environment and DB `docs_site` (content cannot override) |

### 3.3 The `null` opt-out (MUST)

The `null` opt-out is defined for exactly the fields that have **filesystem detection** — and only those. For such a field, an explicit `null` in `docs.json` means **"do not detect, use nothing"** — distinct from omission (= use the derived default). `null` is itself an authoritative value. The detectable set is exactly **`logo`, `favicon`, `colors`** (and the `x-margin.css` path); these are the only fields marked `.nullable()` in the §7 schema.

- **Non-detectable fields (MUST):** for a field with no filesystem detection (`appearance`, `background`, `fonts`, `banner`, `icons.library`, `navbar`, `footer`, …), `null` is **not** a distinct opt-out. Such fields are not `.nullable()` in §7, so a literal `"appearance": null` is treated as a malformed value on a known field → dropped, default applied, `field_invalid` (info/warn) diagnostic — never fatal (§3.4). Their §2.1 `null` column is `—`.
- **`name` / `description` (MUST):** although both are *derived* (name from H1/DB/repo §1.6; description from the first page §2.1), neither supports a `null` opt-out — a site must have a `<title>`/OG name, and a `null` description would just fall through to the derived excerpt anyway. They are **not** `.nullable()` in §7; `"name": null` / `"description": null` are `field_invalid` (warn) and fall back to derivation. This is intentional and stated so the §3.3 "detection ⇒ nullable" rule is not read to cover them.

- `"logo": null` → suppress convention `logo.*` → text navbar. Omitting `logo` → use detection.
- `"favicon": null` → no favicon link.
- `"colors": null` → pin the bare preset and **disable the logo-derived accent** and config-driven token emission. **It does NOT disable a site stylesheet's `--color-fd-primary` rule** — CSS is a separate injection layer (§4.3). A site who wants truly no brand color must both set `colors: null` and omit the CSS override. This subtlety is documented to remove ambiguity.
- `"x-margin.css": null` → disable CSS injection even when a `styles.css` exists.

### 3.4 Validation policy (superset-appropriate — MUST)

- Unknown field (top-level or `x-margin.*`) → **Ignored**, info diagnostic. Never fatal.
- Malformed value on a **known** field (wrong type, bad enum, bad hex) → **warn-and-default**: drop that one field, use the derived/preset default, emit a warn diagnostic. Never reject the push.
- Invalid JSON syntax → **fatal** (cannot parse). This is the only config-level hard failure.
- A superset config MUST degrade gracefully: a bad individual color MUST NOT take a site offline. Unparseable JSON, missing pages, identity collisions, broken internal links, security violations, and operational ingest failures still fail the build.
- All diagnostics collect into the per-version discovery report (§6.2), surfaced in build output.

---

## 4. Theming & custom-CSS contract

The entire themeable surface of fumadocs is CSS custom properties — there is **no JS theme object** (verified against the installed `fumadocs-ui@16.11.1`). Theming therefore reduces to emitting a scoped `<style>` block. Two independent channels, both within the ceiling: **(a) structured tokens** (the 80% path) and **(b) a raw, sanitized site stylesheet** (the escape hatch).

### 4.1 Token model

Tokens resolve at ingest into a **`theme_tokens`** blob — a flat, deterministic map of the shape `{ var: { light, dark } | value }` — and the serving layer renders it as a `:root{}` / `.dark{}` block **with zero code branching** (satisfying the repo's "no code/LLM for already-structured data" altitude). Colors MUST be `#RGB`/`#RRGGBB`; invalid → dropped + diagnostic (§3.4).

| Source | fumadocs var | Mode rule |
|---|---|---|
| `colors.primary` | `--color-fd-primary` (`:root`), `--color-fd-ring` | Mintlify "primary" = light-mode emphasis; base for `light`/`dark` when absent |
| `colors.light` | `--color-fd-primary` (`.dark`), `--color-fd-ring` | Mintlify "light" = dark-mode emphasis |
| `colors.dark` | `--margin-button` (both modes) | Mintlify "dark" = button and hover fill |
| *(derived)* | `--color-fd-primary-foreground`, `--margin-button-foreground` | per mode, `#000`/`#fff` by WCAG contrast, unless `primary-foreground` is set explicitly |
| `background.color.{light,dark}` | `--color-fd-background` | per mode |
| `banner.type` | `--color-fd-info` / `--color-fd-warning` / `--color-fd-error` | static; **`critical`→`--color-fd-error`** (no `critical` token exists) |
| `x-margin.tokens.{border,muted,card,accent,ring,popover,…}` | corresponding `--color-fd-*` | per mode; typed pass-through of the documented token set |
| `x-margin.layout.contentWidth` | `--fd-layout-width` | single value |
| `x-margin.layout.sidebarWidth` | `--fd-sidebar-width` | single value |
| `x-margin.layout.tocWidth` | `--fd-toc-width` | single value |
| `x-margin.layout.headerHeight` | `--fd-header-height` | single value |
| `x-margin.tokens.radius` | *(no fd var)* | fumadocs has no radius token; emitted as **framework-authored** CSS overriding the baked `rounded-*` utilities on component selectors |
| `fonts.*` | `--font-sans` / `--font-mono` + `@font-face` + `body{font-family}` | fumadocs has no font token (§4.3) |
| `theme` preset | expands to a **precomputed token map** (§4.2) merged into `theme_tokens` below any explicit `colors`/`x-margin.tokens` | overridden by any explicit token above |

**Readable accent (MUST).** An accent from `colors` or a detected logo is used as written when it reaches 4.5:1 (WCAG AA text) against every surface accent text is set on in that mode — `background`, `card`, `popover`, `muted`, `secondary`, and a 10% tint of the accent over `background` (the active sidebar row). Otherwise ingest moves it along OKLCH lightness only (darker in light mode, lighter in dark), keeping hue and as much chroma as sRGB allows, to the nearest lightness that clears 4.5:1. When no lightness clears every surface (an authored page background that contrasts with the preset's panels), the accent is fitted to `background` alone, where links sit, and is otherwise kept as written; the result is never less readable on `background` than the authored accent. `x-margin.tokens` and site CSS are explicit and never adjusted. Every preset palette keeps its text tokens at 4.5:1 and its ring at 3:1 on its surfaces in both modes; `tests/theme-contrast.test.ts` enforces both for each preset and a range of primaries.

Injection order (MUST): (1) the **build-time-static** base palette (fumadocs' token registrations overridden by the framework's `mint` palette, compiled into the bundle) → (2) the per-site `theme_tokens` block emitted server-side into `:root{}`/`.dark{}` (this is where the resolved *palette* lives, as data, since CSS `@import`s cannot be chosen per request in a static CSS bundle — see §4.2) → (3) the sanitized site stylesheet. CSS therefore always has the final cascade say; the per-site token block overrides the shared `neutral` base for everyone who sets a palette.

> **Why the palette is data, not an import.** `app.css` carries one base palette (`mint`) in the static CSS bundle. A deployment cannot conditionally import another palette per content version and request. Every palette therefore takes effect via the per-site `theme_tokens` block (2), never via a swapped import (1). The base palette only covers rendering without a token block; any `theme`/`colors`/token override wins over it through normal cascade because the token block is emitted after it.

### 4.2 `theme` → framework layout preset + palette (Adapted)

The customization **floor is everything Mintlify offers** (locked decision #5), and Mintlify's `theme` is a layout engine, not just a palette. So each Mintlify `theme` maps to a **framework-owned *layout preset*** — a bundle of (a) fixed component composition (which shell/nav/TOC/landing components render, in what arrangement) and (b) CSS (layout dimensions + a palette). **Both halves are implemented by the framework and selected purely by data (INV-2): no site code runs.** The preset is not a per-request React-component swap of the whole app; it is a framework-shipped set of presets, one per `layoutPresets` value (§7), and the resolved preset is recorded as a **`layout_preset`** value in the ingest output (§6.2, `pgEnum docs_layout_preset`). `neutral` is the zero-config default.

Each preset composes fumadocs primitives (the app's `DocsLayout` + slots) plus framework CSS; it does **not** require forking fumadocs. Building these preset implementations is **new framework build work** (§6, feasibility item 7) — the standard specifies the *mechanism* (data-selected presets), and the visual fidelity to Mintlify is approximate by design.

**Palettes are a static token table (MUST).** Because per-request CSS `@import` selection is impossible in a static CSS bundle (§4.1), the framework does **not** import per-site palette files. It ships one framework-authored palette per Mintlify `theme` as data — `PALETTE_TOKENS: Record<ThemePreset, ThemeTokens>` (`src/types/docs-palettes.ts`) — each approximating that theme's colors in both modes, with neutral grays the ingest re-tints toward a site's primary hue. At **ingest**, resolving `theme` means selecting the `layout_preset` and **merging that theme's palette into the per-site `theme_tokens` blob** below any explicit `colors`/`x-margin.tokens` (which still win). Serving emits the merged blob in the per-site `:root{}`/`.dark{}` block and mounts the preset's component composition; the preset's CSS restyles per theme through a `data-theme-name` attribute where two themes share a preset. The `mint` palette also ships in `app.css` as the static base (§4.1).

| Mintlify `theme` | framework `layout_preset` | palette | Notes |
|---|---|---|---|
| `mint`, `linden` | `neutral` | `mint` / `linden` | clean default; linden cream and monospace |
| `maple`, `almond` | `warm` | `maple` / `almond` | maple's sidenav chrome with a group rail; almond's band |
| `palm`, `willow` | `verdant` | `palm` / `willow` | tinted header; willow's tinted sidebar and serif headings |
| `aspen` | `aspen` | `aspen` | rounded search, divided uppercase groups |
| `sequoia` | `dusk` | `sequoia` | tinted tab row, edged columns |
| `luma` | `contrast` | `luma` | single-row pill-tab header |
| *(docs-native, no Mintlify theme)* | `editorial` | `mint` | wide-prose editorial preset |
| unknown / absent | `neutral` | `mint` | fallback + `theme_unmapped` diagnostic |

> This mapping is **inherently approximate**: the preset captures Mintlify's layout *intent* (density, palette, chrome arrangement), not a byte-exact reproduction of its engine. `colors`/`x-margin.tokens` always override the preset palette. Every preset keeps the reading measure near 65–75 characters, wherever its Mintlify counterpart runs wider.

**Page layout modes (Adapted).** Mintlify's per-page `mode` (frontmatter) selects a page-level layout. This standard maps each `pageModes` value (§7) to a **framework CSS layout class** driven by the page's frontmatter (or a group/config default), within the active `layout_preset`: `default` (standard doc with sidebar + TOC), `center` (centered, no TOC), `wide` (full content width, TOC suppressed), `custom` (chrome minimized — nav only), `frame`. These are CSS classes toggled by data — no site code. Unknown mode → `default` + diagnostic.

**Background decorations (Adapted).** `background.decoration` (`gradient`/`grid`/`windows`) each map to a **framework-owned decoration** (CSS for `gradient`/`grid`; a framework-shipped component + CSS for `windows`), selected by the data value. None execute site code; all are Adapted rather than Ignored.

### 4.3 Custom-stylesheet contract

- **Location and order (MUST).** All admitted `.css` files are processed in lexicographic path order. `theme.css`, `styles.css`, and `style.css` are conventional names. `x-margin.css` appends explicit paths; `null` disables CSS injection.
- **Admission (MUST).** Total authored CSS is capped at 256 KB per content version. An over-cap file is skipped with a diagnostic; it does not reject otherwise valid content.
- **Sanitization (MUST).** `lightningcss` parses and re-serializes CSS. Unsafe URL protocols, executable legacy properties, unapproved external references, and stylesheet breakout sequences are stripped with diagnostics. Imports may only be resolved through the ingest asset policy; they MUST NOT survive as arbitrary runtime fetches. `@font-face` sources are limited to admitted assets and allow-listed origins.
- **Injection (MUST).** The selected version's token block is emitted server-side as `<style data-site-css>`. The sanitized theme/font CSS follows it in a content-addressed `/_theme/<hash>.css` stylesheet. Sanitized CSS therefore overrides token defaults. The hash identifies the served CSS; a stale hash uses the current selected version's stylesheet under the shared cache policy.
- **Chrome protection (SHOULD).** Layout-affecting global rules on `:root`, `html`, and `body` are scoped to the docs content root when possible. Unsafe rules that cannot be scoped are dropped. This keeps authored content from disrupting the navigation shell.
- **Custom-property carve-out (MUST).** Theme custom properties stay global on `:root` and `.dark`. Portal-mounted controls need to inherit the same tokens as the document. Scoping these properties only to the article would leave drawers, popovers, and tooltips unthemed.

CSS unlocks radius, prose typography, sidebar backgrounds, and component styling within the sanitizer's bounds. It does not permit arbitrary executable components.

### 4.4 What is NOT themeable (Ignored, documented)

The following remain outside the ceiling because they require authored executable host code: **arbitrary site-authored** React/component variants and layout engines (as distinct from the framework-owned `layout_preset` set of §4.2, which is data-selected and framework-implemented), arbitrary external script loaders and unvalidated executable assets. Local article components supplied by snippets are supported separately (§4.7); they do not replace framework-owned layout engines. Each emits a diagnostic when present in config. Note that Mintlify `theme`s, page `mode`s, and `background.decoration` (incl. `windows`) are **not** in this list — they are Adapted via framework-owned presets (§4.2).

### 4.5 Static assets — hash-addressed pipeline

Logos, favicons, images, and self-hosted fonts are stored as versioned content.

- **Admission (MUST).** Preserve binary bytes through the folder snapshot, compilation, and persistence. For SVG, decode valid UTF-8 and sanitize to passive image content before hashing: no scripts, handlers, `foreignObject`, or executable/external references.
- **Storage (MUST).** `docs_asset` associates a content hash, MIME type, byte size, and inline bytes or Blob URL with a site and content version. Assets are selected only from the version the request serves.
- **Serving (MUST).** `/_assets/<hash>` streams inline bytes or serves the configured Blob representation with the correct content type and immutable caching in production. SVG responses additionally send `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Preview policy overrides caching with `no-store`.
- **Reference rewriting (MUST).** Rewrite admitted relative asset references in MDX, CSS, and config to content-addressed routes. Resolve remote assets only through the allow-list and safe-fetch policy. Asset requests MUST bypass page-view analytics.
- **Caps.** The implementation's per-asset cap is 20 MB. Without a Blob token, assets remain inline in Postgres; the 25 MB inline version budget and search-corpus limit are enforced during ingest. With `BLOB_READ_WRITE_TOKEN`, assets over 1 MB and non-small assets exceeding the inline version budget use Blob storage; the search corpus is uploaded too.
- **External writes (MUST).** Upload Blob bytes before the persistence transaction and commit only their references with content rows. A failed upload MUST fail ingest. Hold the global Blob advisory lock on a direct connection across upload, persistence, and reference-checked collection. Garbage collection MUST delete unreferenced blobs before deleting the rows that track them; a failed blob deletion preserves the affected version rows.

### 4.6 MDX & snippet execution-safety contract (INV-2 — MUST)

The tokens+CSS ceiling and the "no site JS" rule are not sufficient on their own: **MDX is itself an executable format.** A page's compiled output is later run as JavaScript in the visitor's browser (via `mdx-remote`), so an allow-list of *filenames* (banning `.js`/`.jsx`, §1.2) does nothing to stop executable constructs *inside* a `.md`/`.mdx`/snippet file. The security boundary is therefore an **AST-level fail-closed validation pass at ingest** — a rejected construct produces a red commit status and nothing is stored (a **content error**, §1.10, not a config diagnostic). This applies identically to page files **and** to every admitted `snippets/**/*.{mdx,md}` fragment before it is inlined.

**Already enforced today** by `remarkDocsAllowList` / `validateInternalLinks` in `apps/api/src/lib/docs-ingest/validate.ts` (this standard codifies the existing behavior — cited file:line):

- `mdxjsEsm` import/export statements → **tolerated, never executed**: `import X from "/snippets/..."` is consumed by the snippet chain (the one supported form); every other import/export node is **stripped from the tree with an `esm_stripped` (warn) diagnostic** before compilation (`validate.ts` `remarkDocsAllowList`), so the page renders without the binding instead of failing the site — Mintlify tolerates these. No module can ever be loaded; a stripped binding leaves any component it named to the unknown-component policy below.
- MDX flow/text expressions `{ … }` → **allowed** (Mintlify parity). Compiled pages execute as JavaScript in the visitor's browser on the site's own origin and, for the server snapshot, only inside the host-less V8 isolate of INV-2(c) — `src/sandbox/render.tsx` is the whole of what that isolate can reach (React, the framework's component allow-list, `executeMdxSync`), with a 250 ms budget, a 128 MB heap, and a fresh context per render; the DB-credentialed process never evaluates site code itself (`validate.ts` header rationale). The browser still executes the same compiled JS after hydration, so the snapshot and the live article are one component tree. What stays fatal is anything that escapes that model: the element/attribute/URL rules below.
- Capitalized component elements → resolved against `ALLOWED_MDX_COMPONENTS` in `src/types/docs.ts` (the single canonical list; dotted members against `ALLOWED_MDX_COMPONENT_MEMBERS`) or a name the page binds from a JS/JSX snippet or page-local `export`. Anything else is **unwrapped to its children** with a `component_unknown` (warn) diagnostic, never rejected. Built-in names resolve only to framework-owned components. Pipeline-internal names (`CodeBlockTabs*`, `ViewGroup`) are not in the list and cannot be authored.
- Denied intrinsic elements — `script, object, embed, style, link, meta, base, frame, frameset, noscript, foreignobject` and the SMIL elements `animate, set, animatemotion, animatetransform` → rejected (`validate.ts` `DENIED_INTRINSICS`). Inline `svg` is allowed; `iframe` is allowed only with an admitted `src`.
- Spread JSX attributes (`{...props}`) → rejected. Expression-valued attributes (`title={x}`) are admitted like any MDX expression; static ones resolve at ingest.
- Event-handler props (`on*`) and `srcdoc` → rejected (`validate.ts:132-138`).
- Raw `html` nodes (possible in plain `.md`) → rejected outright (`validate.ts:183-185`).
- Disallowed URL protocols on JSX attribute values and on Markdown `link`/`image`/`definition` URLs (`validate.ts:139-147,165-179`).

**Mandated additions (MUST — codify what is missing):**

- **URL scheme allow-list (invert the denylist).** The shared URL predicate is applied to every URL-bearing position in MDX and config navigation/chrome: permit **only** `http:`, `https:`, `mailto:`, pure fragments (`#…`), and scheme-relative/root-relative/relative paths (no scheme, or leading `/`, `./`, `../`). Every other scheme is rejected (page files) as a content error or dropped (config links) with a `field_invalid` warning. Config validation happens before persistence, and rendering repeats the check defensively. The pass fails **closed**: an unrecognized or unparseable URL is rejected, not allowed.
- **Snippet parity (MUST).** The same `remarkDocsAllowList` pass runs over every `snippets/**/*.{mdx,md}` fragment before it is inlined into a page. `.js/.jsx/.ts/.tsx` snippet modules, and page-local `export` blocks, are **not AST-scanned**: they compile as JavaScript (§1.2) and are bounded by where compiled MDX may execute (INV-2(c)). At ingest the element/attribute rules above therefore do not constrain markup such a module renders; the server-output guarantee below applies them to what the server emits.
- **Server-output sanitization (MUST).** The HTML the isolate returns for a compiled page is parsed on the host and held to the rules above before it is memoized or inserted into the server document (the document's snapshot slot and the client-navigation RPC payload alike; `src/lib/sandbox-render.ts`). The rules come from the same constants the ingest pass uses (`DENIED_INTRINSICS`, `URL_BEARING_ATTRIBUTES`, `isAllowedUrl`): denied elements are dropped with their content, `on*` and `srcdoc` attributes removed, a URL-bearing attribute (plus `imagesrcset`) kept only when every value — each candidate URL of a `srcset` list — passes the URL scheme allow-list, and an `iframe` kept only with an `https:` `src`. Output nested deeper than `SANDBOX_MAX_HTML_DEPTH` (512) elements, or that the sanitizer cannot process, is a failed render and serves the declined-render fallback. This covers markup produced by snippet modules, page-local exports, computed attributes, and `dangerouslySetInnerHTML`. The one addition is React's own `<link rel="preload" as="image">` hint for the eager article image, which neither executes nor styles anything; every other `link` is dropped. The browser's live render after hydration executes the compiled page on the site's own origin as INV-2(c) and §4.7 describe, and is not sanitized.
- **`variables` substitution safety.** The `{{var}}` substitution (§2.3 `variables`) is a **data-only** remark pass over text nodes — it MUST NOT reintroduce MDX expression/JSX syntax; substituted values are treated as literal text and re-validated by the same pass.

This contract is the concrete realization of INV-2 (§0.1) at the content layer; §4.4's "no site code" statement and §1.2's "never executed" note both point here.

---

### 4.7 Current MDX and snippet admission

This section describes the implemented compiler behavior. §4.6 is retained
as the original security-contract text, amended only by its server-output
sanitization guarantee; its stricter claims about
expression attributes, unknown components, inline SVG, and script snippets do
not describe the current parser. The server-render isolate invariant still
applies to every executable page.

- **Components.** Pages can use framework built-ins, names bound by local
  snippet imports, and lifted page-local component exports. Unknown components
  unwrap to their children with a warning. Known component members and members
  of snippet-bound components resolve through their respective scopes.
- **Attributes and expressions.** Flow/text expressions and expression-valued
  attributes such as `<Card title={String(42)}>` are allowed. Spread attributes,
  authored `on*` props, `srcdoc`, and reserved `data-rail*` props are rejected in
  MDX. Literal URL-bearing attributes and Markdown URLs use the shared scheme
  allow-list; computed attributes are executable content, not statically
  verified URL values.
- **Elements.** Raw HTML nodes in plain Markdown and the intrinsic deny-list
  are rejected. Inline SVG is allowed, but script, `foreignObject`, and SVG animation elements
  remain denied. An iframe requires a static HTTPS `src` plus the normal
  attribute checks.
- **Local snippets.** `/snippets/` imports can transclude `.md/.mdx` fragments
  or bind custom `.js/.jsx/.ts/.tsx` components. Script snippets are transpiled
  and bundled as page code without executing their module bodies at ingest.
  The allow-list covers imports resolved at bundling time: other `/snippets/`
  modules and the automatic React JSX runtime. Computed dynamic `import(url)`
  can remain in bundled executable code without a rejection diagnostic and
  load a URL in the visitor's browser. That code also has `fetch` and DOM
  access. Page-local component exports use the same path. Imports rejected
  during bundling produce diagnostics and scoped fallbacks.
- **Trust and runtime.** Anyone who can commit to the docs source is trusted
  to run JavaScript in visitors' browsers, as with the site's own code.
  Operators accepting untrusted contributions MUST review MDX and snippets
  like code. The isolate protects the server and build host from executable
  content; it does not sandbox visitors' browsers. Arbitrary snippet JavaScript
  does not receive the full MDX AST attribute check. Browser execution has
  full browser capabilities, including computed dynamic imports, `fetch`, and
  DOM access, subject to ordinary browser origin/security policies. The
  database-credentialed server MUST NOT evaluate authored code outside the
  host-free isolate; ingest compiles it without evaluation.
- **Static versus executable surfaces.** Data-only pages use stored, sanitized
  HAST. The classifier strips `dangerouslySetInnerHTML` and handler properties
  from that tree. Pages with executable expressions, dynamic attributes, or
  local components use compiled JavaScript instead. An executable page can
  retain `dangerouslySetInnerHTML`: React returns the supplied raw markup from
  the isolate, and browser rendering retains it too.
  For example, adding `{String(42)}` to a page containing
  `<div dangerouslySetInnerHTML={{__html: "<img src=x onerror=alert(1)>"}} />`
  selects the executable path. The host sanitizes the isolate's HTML (§4.6
  server-output sanitization), so the `onerror` attribute never reaches the
  server document, but the browser's live render after hydration keeps it. On
  the data-only path, the raw-HTML prop is stripped. Rejecting authored `on*`
  JSX props does not prevent handlers embedded in raw HTML from running in the
  browser.
- **Actual server-render limits.** `SANDBOX_RENDER_TIMEOUT_MS` is 250 ms;
  each render gets a fresh context. `SANDBOX_MEMORY_LIMIT_MB` configures a
  128 MB isolate memory target, not a hard cap. `isolated-vm` documents that
  hostile code can use 2–3 times its `memoryLimit` guideline before termination.
  `SANDBOX_MAX_HTML_BYTES` is 2,097,152, but the renderer compares `html.length`:
  the output ceiling is UTF-16 code units, not bytes. A render with 800,000 `漢`
  characters can therefore exceed 2 MiB in UTF-8 while remaining below the
  output ceiling. The preserved historical wording in §4.6 and INV-2 does not
  strengthen these implementation limits.

## 5. v1 feature specifications

### 5.1 Tabs / anchors / dropdowns

fumadocs `getLayoutTabs` makes **every `Folder` with `root:true` a tab**. Both authoring forms compile down to that.

- **Filesystem (zero-config):** a directory with `meta.json { "root": true, "title": "...", "icon": "..." }` → a tab. No extra machinery once `metaDataSchema` accepts `root` (it already does). With no `root` folders there are no tabs — a single flat sidebar, correct for small docs.
- **Config:** `navigation.tabs[]` → synthesize a `docs_meta` row for each tab's directory (or first group) with `root:true`, `title=tab`, `icon`, then recurse `groups`/`pages`. `tab.href` (external) → a nav `MainItemType` link instead of a folder.
- **Anchors:** an anchor with `groups`/`pages` → a `root:true` folder (like a tab). An anchor with only `href` → a nav link (`MainItemType`/`IconItemType`). `global.anchors` → links rendered on every page (added to `baseOptions.links`, not the tree). Per-anchor `color` → an inline token on that link's element.
- **Dropdowns:** `navigation.dropdowns[]` → a fumadocs `MenuItemType` (`type:'menu'`) in `baseOptions.links`; items = child tab/page URLs.
- **`tabMode`:** default `'top'` (top-bar tabs); `x-margin.layout.tabMode:'auto'` for sidebar-embedded.

`hidden:true` and unlisted-page semantics: nodes are omitted from the serialized page tree but their `docs_page` row is kept, so they remain URL-reachable. `searchable:true` is inherited by the node's page subtree and persists a resolved per-page flag, keeping hidden pages in the search / `llms.txt` index. Synthesized landing pages remain URL-reachable but are always non-indexable; the serving layer's single `isPageIndexable` decision applies this exception consistently to robots metadata, sitemaps, search, and `llms.txt`.

Example — `meta.json` tab:

```json
{ "root": true, "title": "SDK Reference", "icon": "package" }
```

Equivalent config:

```json
{ "navigation": { "tabs": [ { "tab": "SDK Reference", "icon": "package",
  "groups": [ { "group": "Getting Started", "pages": ["sdk/install", "sdk/auth"] } ] } ] } }
```

### 5.2 Versioning (product versions)

Product versions are **path partitions within one content version**, not separate `docs_content_version` rows (that axis is git-snapshot deploy history — §0.2). This avoids N deploys per version and reuses the existing immutable snapshot. fumadocs has no native version primitive, so the framework synthesizes routing + the switcher.

**Source forms** (any of these declares a version root):

- **`versions/` container:** each child (`versions/v2/`, `versions/v1/`) is a version.
- **Sibling detection (zero-config, §1.3):** a root folder named `v2` (or semver `2.1`) is a version root **only when a sibling `v1`/`v3`/`versions` also exists**. Ambiguous single folders stay ordinary groups + `DIAG_VERSION_AMBIGUOUS`.
- **`meta.json` marker:** a version-root directory, including a child of `versions/`, with `meta.json { "x-margin-version": "v2.0" }` (and optionally `"x-margin-version-default": true`). A default-only marker infers its label from the version-root directory name.
- **Config:** `versions[]` (`version`, `default`, `directory`) anywhere in the resolved navigation tree, including beneath the selected language, product, or `global` container — the Mintlify-native path; takes precedence over derivation.

**Ingest is version-aware (MUST) — URL identity is computed per version at compile, not deferred to serving.** Product-version routing is **not** serve-time prefix stripping over a flat URL space; `compile.ts` today computes `url`/`slugs` via `pathToSlugs`, enforces route-collision on the flat `url` (`compile.ts`), and `validate.ts` checks internal links against a flat `knownUrls` set — none of which survive naive serve-time stripping (after stripping, `versions/v1/index` and `versions/v2/index` both want `/`). Instead, at compile the pipeline:

1. **Partitions pages by product version** (§1.3 / this section's source forms), assigning each `docs_page` a `version_label` (`null` for shared/unprefixed pages).
2. **Computes the served (stripped) URL per version tree**: the version-directory prefix (`versions/v2/`, `v2/`, or the `directory` from config) is stripped, so `versions/v2/guides/intro` → served `/v2/guides/intro`. Both the raw path (for `unique(version_id, path)`) and the derived served URL are stored on `docs_page` (`served_url`).
3. **Injects shared/default pages into each version tree** at their unprefixed served URL, so a page outside any version directory appears in every version's tree (and unprefixed).
4. **Runs collision + internal-link validation in the per-version stripped space** — a duplicate served URL *within one version tree* (including a shared page colliding with a version-local page) is the §1.10 fatal collision; internal links are validated against the served URLs of the active version (with fallback to shared/default, §5.2 cross-version rule) — never against the raw `versions/v2/...` paths.
5. **Enforces the page cap per served version tree after partitioning and OpenAPI generation.** A shared (`version_label = null`) page counts toward every version tree into which it is injected; without product versions, the unversioned tree is counted once. The violation names the offending version.

When a discovered version root has pages but no authored `index.mdx`/`index.md`, ingest MUST use the same synthesized-overview mechanism as the unversioned root to create that version's `/<label>` landing page. Its generated links MUST use the pages' post-partition `served_url` values, never their raw repository paths. Convention-discovered OpenAPI specs inside a version root MUST keep that raw version directory in their generated base path and include the version label in their document id; non-versioned convention discovery is unchanged.

**Storage.** A `versions_manifest` JSON column on `docs_content_version`: `[{ label, directory, default, seq }]`, plus a `version_label` (text, nullable) and the derived `served_url` (text) on each `docs_page` row (§6.2). **No new table**, and **not** a new `docs_content_version` row per version.

**Serving.** `source.ts` builds **one fumadocs `loader()` tree per version** by grouping `docs_page` rows on `version_label` (shared/`null` pages injected into each tree) and keying the tree on the already-computed `served_url` — no serve-time string surgery, so the URLs `source.ts` serves are exactly the ones collision-checked and link-validated at ingest. The active version is chosen from the leading slug segment for HTML, `.md`, context-bundle, and MCP page lookups; each surface reads from the matching cached version source, building it on demand when necessary. All page-read surfaces MUST use the stored-`served_url` fallback after a visible-tree miss so hidden and unlisted but URL-reachable pages remain readable, including through the markdown alternate advertised by HTML.

**Edge-case rules (MUST):**
- **Pages outside any version directory, when versions exist.** These belong to the **default version**, and are additionally served **unprefixed** (shared across versions). The **default-version cascade (MUST, single source of truth — §3.2 cites this)** is: `meta.json x-margin-version-default` → `navigation.versions[].default` → `x-margin.versions.default` → else the highest label by natural/semver sort. Exactly one default MUST exist; if none is flagged, the highest-sorted version is the default and `DIAG_VERSION_NO_DEFAULT` (info) records the inference. **If two or more version roots are flagged default,** the highest-sorted among the flagged ones wins and a `DIAG_VERSION_MULTIPLE_DEFAULT` (warn) records the conflict. Note the distinction: this cascade selects the **default version**; the **active version for a given request** is the leading URL segment (falling back to the default), which is a separate axis (§3.2).
- **External-href versions (Mintlify `{ "version": "v1", "href": "https://…" }`).** A `versionNode` whose only locator is an external `href` (no `directory` and no matching version folder) becomes an **external switcher entry** linking out — it is not a path partition, gets no per-version tree, and is skipped by the directory-partition logic above.
- **Cross-version link resolution.** An internal link resolves **within the active version by default**: a relative link inside `/v2.0/…` resolves to the `v2.0` tree; a link that targets an unprefixed shared page resolves there. A link that cannot be resolved within the active version falls back to the default version, then fails as a broken link (§1.10) if still unresolved.

**Switcher.** A nav `MenuItemType` dropdown whose items are per-version base URLs; the framework owns version routing and tree selection.

```json
{ "x-margin": { "versions": { "strategy": "folder", "default": "v2", "order": ["v2","v1"] } } }
```

### 5.3 Redirects

- **Config:** `redirects[]` (`source`, `destination`, `permanent`), stored as a `redirects` JSON column on the content version. A sole `{"$ref": "./redirects.json"}` object in place of the array (Mintlify's own docs keep redirects in a sibling file) expands through the same `$ref` resolver `navigation` uses.
- **Source namespace (MUST).** Docs serve at the site root, so `source`/`destination` are root-relative: a missing leading slash is added and a trailing slash trimmed (except `/`). External absolute `destination` URLs pass through unchanged.
- **Grammar (MUST, shared).** `parseRedirectPattern`/`applyRedirectPattern`/`matchRedirect` in `src/types/docs-shared.ts` define Mintlify's redirect forms once for ingest validation and request-time matching, so a rule admitted at ingest always fires when served: exact `/a/b`; single-segment `/a/:name`; rest `/a/:name*` (may match an empty tail); rest `/a/*` (alias `:splat`); partial `/a/prefix-*`. Wildcards are terminal only. Sources are case-sensitive and may not carry `#fragment` or `?query`; destinations may, and they survive substitution. A destination may substitute only tokens its source captured (`:name`, `:name*`, `*`); anything else is `redirect_invalid` and dropped.
- **Status (MUST).** Mintlify parity: redirects are permanent (`308`) unless `permanent: false` (`307`). The HTML route, the `.md`/`.pdf`/`.rss.xml` twins and the markdown negotiation path all consult the same rules, so `/old.md` follows `/old → /new` to `/new.md`.
- **Case (MUST).** A path that misses every page and redirect is retried case-insensitively against `served_url`; a hit answers `308` to the canonical spelling (Mintlify serves `/QUICKSTART`; the permanent redirect keeps one indexed URL).
- **External pointers (frontmatter `url`).** A page whose frontmatter `url` is an admitted `http(s)` URL answers its HTML route with `307` to that URL and is left out of `sitemap.xml` (a sitemap lists only `200` URLs). Agent indexes (`llms.txt`, `sitemap.md`, `Related:` lines, the markdown 404's suggestions) link the destination itself, as the sidebar does (normalized, with `(`, `)`, `<` and `>` percent-encoded so the Markdown link or autolink keeps the whole URL; navigation entries still match on the raw frontmatter URL); the page's `.md` twin still answers `200` with a rendition that opens by naming the destination.
- **CDN caching of the 30x.** `cacheMiddleware` today only stamps `Cache-Control` on successful or 404 text/html (`start.ts`); a thrown 307/308 gets none and is not CDN-cached. If CDN-cached redirects are wanted (SHOULD), the redirect throw (or `cacheMiddleware`) MUST stamp a host-keyed `Cache-Control`/`s-maxage` on the 30x response; otherwise redirects are evaluated per request (correct, just not edge-cached). The standard does not require edge-cached redirects — it requires that the claim match the implementation.
- Redirects live on the immutable version, so history stays consistent. Loops, redirects to nonexistent destinations, and wildcard mappings whose source/destination use different token spellings → `DIAG_REDIRECT_INVALID` (warn), dropped.

### 5.4 SEO

Technical SEO is a framework invariant. A Markdown-only site with no `docs.json` receives the following output:

| Feature | Zero-config rule |
|---|---|
| Site and page titles | Site name: config name → root H1 → database name → `Docs`. Page title: `{page} – {site}`. |
| Description | Authored description → first useful paragraph → site description → database description. |
| Canonical | The page path on the site's primary production hostname. Content cannot override it. |
| Social metadata | Article Open Graph/Twitter metadata and a generated 1200×630 card when no valid image exists. Dimensions are emitted only for generated cards. |
| Identity and schema | A connected `Organization`/`Person`, `WebSite`, `WebPage`, `BreadcrumbList`, and `Article` + `TechArticle` JSON-LD graph. API-console pages also use `APIReference`. |
| Language | Active locale → default navigation locale → explicit SEO language → `en`. Exact translated counterparts receive `hreflang`; `x-default` exists only when the default-locale counterpart exists. |
| Semantics | Page content renders as `<main id="nd-page"><article>…</article></main>`; the table-of-contents rail stays outside the article. |
| Representations | A page URL serves `text/html`, or its markdown rendition inline when `Accept` prefers `text/markdown`/`text/plain` (or `?format=markdown`). An `Accept` that admits neither HTML nor `*/*` (e.g. `application/json` alone) answers `406` with `Vary: Accept`, a `Link: <…/page.md>; rel="alternate"; type="text/markdown"` header (the request's already-escaped path, never encoded twice), and a JSON body naming that markdown URL: a page has no JSON representation, and markdown under a JSON `Accept` would hand a JSON parser prose. |
| Freshness | Every page and sitemap entry uses its durable Git-derived `dateModified`; unchanged pages retain their timestamp. `datePublished` is omitted. |
| Discovery | The head advertises the sitemap. Successful HTML and Markdown responses advertise enabled sitemap, LLM, manifest, MCP, skill, and agent-instruction surfaces through HTTP `Link` headers. |

The default single-site extension uses the host of `SITE_ORIGIN` as the canonical production host. In production, other hosts receive an absolute `308` preserving path and query unless `DOCS_CANONICAL_REDIRECT=0`. Preview and development requests never take that canonical redirect. Preview responses are `no-store` and `noindex`; no wildcard-host or custom-domain registry is required.

`x-margin.seo` supplies optional facts and overrides:

```json
{
  "x-margin": {
    "seo": {
      "titleTemplate": "{page} – {site}",
      "language": "en",
      "publisher": {
        "type": "Organization",
        "name": "Example",
        "url": "https://example.com",
        "logoUrl": "/logo.svg",
        "sameAs": ["https://github.com/example"]
      },
      "provenance": {
        "name": "Upstream documentation",
        "baseUrl": "https://upstream.example/docs",
        "license": {
          "name": "MIT",
          "url": "https://opensource.org/license/mit"
        }
      }
    }
  }
}
```

`titleTemplate` must contain `{page}` exactly once, may contain `{site}` once, rejects other tokens, and has a 200-character limit. Invalid templates produce `field_invalid` and use the default. Publisher identity URLs must be public absolute HTTP(S) URLs without credentials; a logo may also use a safe relative asset. Unspecified publisher fields inherit the site identity. OG images use framework-owned rendering.

Provenance is factual and opt-in. The default page is self-canonical and emits no source claim. Site provenance alone changes nothing. A page may add `provenance: true` to derive its source from the configured base URL and served path, or `provenance: { sourceUrl: "https://…" }` to state an explicit source. Both require valid site provenance. An opted-in page emits `isBasedOn`, an optional license link, and visible source attribution; provenance never changes its canonical URL.

`robots.txt` always allows crawling and advertises the sitemap. A non-indexable page stays crawlable but emits `noindex,follow` and stays out of sitemaps, search, and LLM indexes. Markdown duplicates emit an HTML canonical `Link` header and `X-Robots-Tag: noindex`. Preview policy remains `noindex,nofollow`.

Invalid `frontmatter.ogImage` and site images are dropped at ingest with `field_invalid`; serving falls back to the generated card. `metatags` and `head.meta` remain inert `<meta>` data. Ingest rejects executable head markup and strips malformed nested SEO properties independently, so one bad publisher URL cannot erase a valid title template or unrelated extension setting.

### 5.5 Integrations (analytics) — framework-owned, key-parameterized

INV-2 forbids site scripts, so the framework ships loader code for an **allow-listed subset** and injects each provider's official snippet parameterized by the site's key (framework code parameterized by site *data*, never site *code*).

**The admission test (MUST).** A provider is Supported **only if every value the site supplies is a data-only key/ID and the executable script loads from a framework-pinned official origin.** If any value would let the site **select a script origin** or **inject an executable container** (a bundle of site-authored tags/HTML/JS), that value is code, not a key — it is dropped or the whole provider is Ignored (INV-2). Applying that test:

| Provider (v1) | Disposition | Key(s) honored | Injection |
|---|---|---|---|
| `ga4` | **Supported** | `measurementId` (`^G`) | framework gtag snippet from `googletagmanager.com` (pinned) |
| `gtm` | **Ignored** | — | **None.** A GTM container executes site-authored Custom-HTML/JS tags — it is an executable container, not a key (fails the test). `tagId` is parsed for Mintlify compat, stored, and `DIAG_INTEGRATION_UNSUPPORTED` (warn) explains INV-2. |
| `posthog` | **Supported** | `apiKey` (`^phc_`), `apiHost?` | framework-bundled posthog-js init. `apiHost` is honored **only** when it is an official PostHog ingestion origin (US/EU cloud); an arbitrary self-host origin would let posthog-js fetch remote assets (recorder/surveys) from a site-chosen host, so it is dropped + `DIAG_INTEGRATION_UNSUPPORTED` and the default official host is used. |
| `plausible` | **Supported** | `domain` (data only) | framework Plausible `<script>` from the **pinned official origin only**. The Mintlify `server`/self-host origin is **not** honored (it selects a script origin — fails the test); a supplied `server` value is ignored + diagnosed. |
| `fathom` | **Supported** | `siteId` | framework Fathom `<script>` from `cdn.usefathom.com` (pinned) |
| `clarity` | **Supported** | `projectId` | framework Clarity snippet from `clarity.ms` (pinned) |
| `segment` | **Supported** | `key` (write key) | framework analytics.js snippet loading from `cdn.segment.com` (pinned) |
| `amplitude` | **Supported** | `apiKey` | framework Amplitude snippet from its official CDN (pinned) |
| `mixpanel` | **Supported** | `projectToken`, `region?` | framework Mixpanel snippet; `region` (`eu`/`in`) is a data-only residency key mapped onto pinned official ingestion origins |
| `hotjar` | **Supported** | `hjid`, `hjsv?` (numeric) | framework Hotjar snippet from `static.hotjar.com` (pinned) |
| `intercom` | **Supported** | `appId` | framework Intercom messenger loader from `widget.intercom.io` (pinned) |

- **Storage:** an `integrations` JSON column on the content version (keys only; these are non-secret client IDs by design). Ignored providers (`gtm`) and dropped origin values (`plausible.server`, non-official `posthog.apiHost`) are stored for the migration report but never injected.
- **Others** (any provider not in the table) → parsed, stored, `DIAG_INTEGRATION_UNSUPPORTED`, **no injection** (no framework loader ships for them).
- **Performance (MUST):** snippets are static `<script async>`/`defer` tags rendered from framework templates; they MUST NOT make the docs route dynamic and MUST NOT do server work in the request path (repo memory: analytics never blocks the request path).

### 5.6 Languages and locales

Locale partitions are independent of product versions. Filesystem language
roots and `navigation.languages[]` can supply locale trees; a language node
is a full navigation container whose tabs, versions, groups, and pages are
processed recursively. Each content version stores a `locales_manifest`.

The default locale serves without a locale prefix. Other locales use their
locale prefix, followed by the product-version prefix where applicable.
Page lookups, Markdown, search, MCP reads, canonical metadata, and sitemap
alternates MUST use the selected locale's served URLs. A counterpart link
MUST point only to a page that exists in the destination locale/version.
Language defaults and ambiguous folder detection produce diagnostics rather
than silently merging unrelated partitions.

---

## 6. Build-time ingest and storage

### 6.1 Ingest and serving responsibilities

A deployment runs `icons:build → db:migrate → build → bundle check → ingest`.
The build resolves `DOCS_CONTENT_SHA` once and gives the same value to ingest
and the server bundler. Ingest runs last because a production ingest advances
the current pointer and collection protects the version that pointer named
before it; a failed build must never become that version. The server build
reads no content. The folder reader, compiler, and persistence modules
are local to this repository.

| Responsibility | Source |
| --- | --- |
| Folder admission and byte preservation | `src/ingest/snapshot.ts` |
| Tolerant configuration and field diagnostics | `src/ingest/config.ts` |
| MDX validation and compilation | `src/ingest/validate.ts`, `src/ingest/compile.ts` |
| Navigation, product versions, locales, and redirects | `src/ingest/nav.ts`, `src/ingest/versions.ts` |
| Theme, CSS, fonts, and assets | `src/ingest/theme.ts`, `src/ingest/fonts.ts`, `src/ingest/assets.ts` |
| Atomic content persistence and guarded pointer advance | `src/ingest/persist.ts` |
| Build orchestration, retention, and watcher | `scripts/vercel-build.ts`, `scripts/ingest.ts` |
| Site resolution and deployment version selection | `src/extensions/default.ts` |
| Request-time content loading | `src/lib/source.ts` |
| Host-free server snapshots | `src/lib/sandbox-render.ts`, `src/sandbox/render.tsx` |

A ready `(site, commit_sha, kind)` key is reused on rebuild. Forced ingest
replaces that key explicitly; normal publication creates a new immutable key.
Production ingest advances the current pointer with a monotonic sequence guard.
Preview ingest never advances it. A deployed server selects its baked commit;
development without a baked SHA selects the current pointer. Live status and
version-readiness checks remain serving gates.

### 6.2 Authoritative storage and retention

The schema under `src/db/schema/` defines `docs_site`, `docs_content_version`,
pages, metadata, OpenAPI documents, assets, skills, feedback, and public rate
limits. There is one site row by default. Content rows reference both site and
version, and compiled artifacts, configuration, theme data, manifests, and
diagnostics commit together in `persistDocsVersion`. A gzipped search corpus
lives on the version row unless optional Blob storage supplies its URL.

Generated migrations under `drizzle/` are applied by `bun run db:migrate`.
Use a direct connection for migrations and the ingest advisory lock when the
runtime URL uses a transaction-mode pooler. Repository source files, not a
hosted synchronization service, supply build-time content.

After successful ingest, collection protects the build's version, the previous
production pointer, and the current pointer. It keeps the newest
`DOCS_KEEP_VERSIONS` other production versions (default 20) and production
versions younger than 30 days. Production versions beyond both limits, previews
older than 30 days, and old failed attempts may be removed. Development watcher
versions can be collected sooner beyond the count. Blob-backed rows remain if
their blobs cannot be deleted safely.

The 30-day age window is measured from the content row's `created_at`, not
from deployment creation. Reusing an already-ingested SHA does not refresh its
age or sequence, so a new deployment can reuse a row eligible for collection
on a subsequent ingest. Count retention and protected pointers may preserve it.
To refresh an existing key, check out that commit and run
`bun scripts/ingest.ts --dir docs --slug docs --sha <commit-sha> --kind production --force`,
or set `DOCS_INGEST=force` for its build. Forced ingest atomically replaces the
row with a fresh creation time and sequence; it can change content read by all
deployments pinned to that key and advances the production pointer. If the row
was collected already, normal ingest recreates it. Database and Blob backups
are the operator's responsibility.

---

## 7. Schema reference

`src/types/docs.ts` contains the exported Zod contracts; `src/types/constants.ts`
defines the vendor key. The database enums in `src/db/schema/enums.ts` mirror
the canonical closed sets. Consult the source for the complete field types:

| Contract | Export |
| --- | --- |
| Tolerant top-level `docs.json` | `docsConfigSupersetSchema` |
| `x-margin` values | `configExtensionSchema` |
| Directory `meta.json`, including `x-margin-version` and `x-margin-version-default` | `docsMetaFileSchema` |
| Recursive navigation | `navigationSchema` and its node schemas |
| Agent output settings | `docsAgentsSchema` |
| Content alternatives | `docsVariationsSchema` |

Unknown fields survive tolerant parsing so ingest can classify them. Known
fields are validated independently; diagnostics report discarded values.
The runtime source is the implementation's type authority, while this document
specifies the public behavior and the unchanged §4.6 security contract.

---

## 8. Migration note — verbatim Mintlify repo

**Goal: a Mintlify documentation folder deploys with zero edits and correct behavior for every supported field.** Set `DOCS_DIR` to that folder and run the deployment build.

1. **Parse** `docs.json` with the superset schema. It validates — all Mintlify-required fields are accepted, and our relaxations only *add* optionality. If `docs.json` is absent but `mint.json` exists, read `mint.json` as the legacy fallback.
2. **Required-in-Mintlify fields** are honored: `name`→navbar, `colors.primary`→`--color-fd-primary`, `theme`→palette (§4.2, Adapted), `navigation`→authoritative sidebar.
3. **Navigation** renders authoritatively from the block (Mintlify semantics — unlisted pages hidden from nav, still URL-reachable): tabs→`root:true` folders, groups→folders, anchors/dropdowns→nav links/menus, versions→per-version trees + switcher.
4. **Branding** applies via the token map (§4.1/§4.3): `colors`/`logo`/`favicon`/`fonts`. A Mintlify `theme` selects the nearest framework-owned `layout_preset` (§4.2, Adapted) — an approximation of, not a byte-exact reproduction of, Mintlify's layout engine; an unmapped `theme` falls back to `neutral` + `theme_unmapped`. The repo's `.css` files are sanitized (`lightningcss`) and injected; standard CSS survives (Mintlify's own arbitrary-value Tailwind limitation means parity holds).
5. **Assets:** `images/`, `/logo/*`, favicon, and MDX `snippets/*.mdx` resolve (rewritten to `/_assets/<hash>`). Local `.js/.jsx/.ts/.tsx` snippet components compile into page code, execute in the browser or server-render isolate, and follow the import allow-list only for imports resolved at bundling time; computed dynamic imports can remain in browser code (§4.7).
6. **OpenAPI** specs discovered + `api` config honored; playground renders.
7. **SEO / redirects / analytics** apply for allow-listed providers (§5.5); unsupported providers → inert diagnostic, no error. Redirects served as 308/307.
8. **Languages** become locale partitions with a default unprefixed locale, locale-aware links, and sitemap alternates (§5.6).
9. **`.mintignore`** honored as a publish-exclude list.
10. **Migration report.** Ingest produces a per-version report enumerating each field's disposition and, for Adapted/Ignored, the reason plus any suggested `x-margin.*` equivalent — the build-time discovery output. Unsupported fields retain their reported disposition.

**Contract.** Visible differences for a migrating user follow the Adapted set — chiefly that a Mintlify `theme` selects the nearest **framework-owned layout preset** (§4.2), which approximates rather than byte-for-byte reproduces Mintlify's layout engine, plus any feature that fundamentally needs site JS. Supported fields retain their documented behavior. Content still passes the validation and security gates in §1.10 and §4.6.

### 8.1 Worked examples

**A1 — Absolute minimum (zero config):**

```
docs/
└── index.mdx        # "# Acme API\n\nWelcome to Acme."
```

→ Site *Acme API*, one-page sidebar, `neutral` palette, generated favicon, `sitemap.xml`/`robots.txt`/`llms.txt`.

**A2 — Rich zero-config (still no `docs.json`):** the §1.11 tree — branded (purple accent, per-mode logo), tabbed, versioned, with API docs and a synthesized version switcher, all from conventions.

**A3 — Config delta (override two things only):**

```json
{
  "name": "Acme",
  "colors": { "primary": "#7C3AED" },
  "logo": null,
  "x-margin": {
    "layout": { "sidebarWidth": "320px" },
    "head": { "meta": [ { "name": "robots", "content": "index,follow" } ] }
  }
}
```

→ Overrides site name + accent, forces a text navbar (`null` opts out of logo detection), widens the sidebar; everything else stays filesystem-derived.

**A4 — Stock Mintlify migration (verbatim):**

```json
{
  "$schema": "https://mintlify.com/docs.json",
  "theme": "aspen",
  "name": "Acme API",
  "colors": { "primary": "#7C3AED", "light": "#A78BFA", "dark": "#5B21B6" },
  "logo": { "light": "/logo/light.svg", "dark": "/logo/dark.svg" },
  "favicon": "/favicon.svg",
  "navigation": {
    "tabs": [
      { "tab": "Guides", "groups": [ { "group": "Get Started", "pages": ["index", "quickstart"] } ] },
      { "tab": "API Reference", "openapi": "openapi.json" }
    ]
  },
  "integrations": { "ga4": { "measurementId": "G-ABC123" } },
  "seo": { "indexing": "all" }
}
```

→ Purple-accented, `aspen`-palette site; two tabs (Guides sidebar + API Reference generated from `openapi.json`); mode-aware logo; GA4 snippet in head; all pages indexed. The report notes `theme:aspen` Adapted to the `aspen` palette (layout is fumadocs). **Zero edits required.**

---

## 9. Conformance

A conforming implementation MUST satisfy each of the following.

### 9.1 An empty repo of `.mdx` only

Given a site source whose only content is one or more `.md`/`.mdx` files and **no `docs.json`, `meta.json`, or frontmatter**:

- It MUST deploy and serve (INV-1). A single `index.mdx` MUST produce a titled, navigable, indexed one-page site (§1.1).
- Titles MUST derive H1 → filename; a missing frontmatter `title` MUST NOT fail the build (§1.6).
- Nav MUST derive by title sort with `index` first (§1.7); logo/favicon MUST follow the detection cascade (§1.8). **Favicon floor (MUST):** a favicon link MUST be present; the zero-dependency floor is an **SVG/CSS-text monogram** of the site's initial (no rasterizer needed). **Rasterized** favicon generation from a logo (§1.8 step 4) and logo dominant-color accent extraction (§1.9) are SHOULD-tier enhancements gated on the image subsystem landing (§6.1) — they require decoding the binary logo asset (blocked until the byte-channel fix, §1.2/§4.5) plus a raster/decode library.
- The site MUST get a `neutral` palette, `sitemap.xml`, `robots.txt`, `llms.txt`, and OG metadata with no config.

### 9.2 A verbatim Mintlify repo

Given an unmodified Mintlify `docs.json` + content (§8):

- The config MUST parse and deploy with zero edits; all four Mintlify-required fields MUST be honored per their disposition (§2, §8).
- `navigation`, when present, MUST be authoritative and MUST hide unlisted pages from nav while keeping them URL-reachable (§2.2, §3.1).
- Unsupported fields MUST be ignored gracefully with a diagnostic; the `x-margin` extension namespace being absent MUST have no effect.
- Authored MDX and compiled local snippet components MUST NOT execute with host access in the deployment process (INV-2). Server snapshots use the host-free isolate; browser execution uses the site origin. Admission follows §4.7, including allowed expression props and bound local components and rejected MDX spread/event-handler props. Authored CSS is sanitized and follows the token block (§4.3). Analytics configuration cannot select arbitrary script origins or executable containers (§5.5).
- A per-version migration report MUST enumerate every field's disposition (§8).

### 9.3 Invalid values in known fields

The push-rejection policy is precise and MUST be implemented exactly:

- **Invalid field values do not reject a build.** A malformed value on a known field (bad hex, wrong type, bad enum) → the implementation MUST drop that single field, apply the derived/preset default, and emit a `field_invalid` (warn) diagnostic. A single bad color MUST NOT take a site offline (§3.4).
- **Unknown fields** (top-level or `x-margin.*`) → ignored + `unknown_field` (info). Never fatal.
- **Content errors DO reject a push.** Fatal content failures include unparseable `docs.json` JSON, a `foo.mdx`/`foo/index.mdx` (or post-derivation duplicate) slug collision, broken internal links (§1.10), and violations of the MDX security contract (§4.6). Storage size limits and internal ingest failures also stop deployment; invalid individual configuration fields do not.
- Every diagnostic MUST carry a `code` from the closed `diagnosticCodes` tuple and a `severity` from `diagnosticSeverities` (§7), mirrored to the `docs_diagnostic_code` / `docs_diagnostic_severity` pgEnums, and MUST be collected into the per-version discovery report surfaced in build output.
