# Set colors and themes

Configure `docs.json` to select a Margin layout preset and brand colors without CSS. Use direct design tokens when primary colors alone do not cover the required surfaces.

## Do this

Merge these fields into the existing `docs.json` at the docs folder root, preserving navigation and other configuration, then deploy the changes:

```json
{
  "theme": "aspen",
  "colors": {
    "primary": "#0F5A3C",
    "dark": "#0F5A3C",
    "light": "#6EE7B7"
  },
  "appearance": {
    "default": "system",
    "strict": false
  },
  "background": {
    "color": {
      "light": "#FFFFFF",
      "dark": "#101814"
    }
  },
  "x-margin": {
    "tokens": {
      "border": "#64748B",
      "card": {
        "light": "#F0FDF4",
        "dark": "#14251C"
      },
      "primary": {
        "light": "#0F5A3C",
        "dark": "#6EE7B7"
      },
      "primary-foreground": {
        "light": "#FFFFFF",
        "dark": "#052E16"
      }
    }
  }
}
```

## Facts

- `theme` accepts `mint`, `maple`, `palm`, `willow`, `linden`, `almond`, `aspen`, `sequoia`, and `luma`.
- Omitted `theme` uses the `neutral` layout with the `mint` palette. Unknown `theme` falls back to the same with a diagnostic.
- Margin theme mappings approximate Mintlify layouts rather than reproducing Mintlify themes pixel for pixel.
- `colors.primary` sets the light-mode accent and is the fallback for `colors.light` and `colors.dark`.
- `colors.light` sets the dark-mode accent. Omitted `colors.light` falls back to `colors.primary`.
- `colors.dark` sets the button fill in both modes. Omitted `colors.dark` falls back to `colors.primary`.
- An accent from `colors` or a logo that falls below 4.5:1 contrast on the page and its panels is moved along lightness only until it reaches 4.5:1. Accents that pass are used as written. `x-margin.tokens` and site stylesheet values are never adjusted.
- Every preset palette keeps body, muted, and accent text at 4.5:1 or more in light and dark mode.
- Omitted `colors` permits logo-derived accent detection; otherwise the preset provides the starting colors.
- `colors: null` retains the selected preset's tokens and disables derived and configured token overrides, including `x-margin.tokens` and `background.color`. `colors: null` does not disable a separate site stylesheet.
- `appearance.default` accepts `system`, `light`, or `dark`; omission defaults to `system`.
- Omitted or false `appearance.strict` permits mode switching. A saved reader choice can take precedence over `appearance.default`.
- `appearance.strict: true` hides the mode switch and forces an explicit `appearance.default: "light"` or `appearance.default: "dark"`.
- `appearance.strict: true` with `appearance.default: "system"` hides the switch without forcing a fixed mode.
- `background.color` accepts a complete `{ "light": "#FFFFFF", "dark": "#101814" }` pair.
- `x-margin.tokens` keys are short token names. Token values accept a hex string for both modes or an object containing both `light` and `dark` hex strings.
- `x-margin.tokens` pair keys name the page mode directly, unlike `colors.light` and `colors.dark`.
- `colors` and direct color tokens accept only `#RGB` or `#RRGGBB` values.
- Primary color precedence, highest first: matching site stylesheet rule, `x-margin.tokens.primary`, applicable `colors` value, detected logo accent, preset default.
- Direct tokens override corresponding configuration such as `background.color`. Site stylesheets follow the token block and can override tokens through the CSS cascade.
- Margin sets black or white `primary-foreground` per mode, whichever reads better on the primary color, unless `x-margin.tokens.primary-foreground` is set.

Theme mappings are:

| `theme` | Margin layout | Variant |
| --- | --- | --- |
| `mint` | `neutral` | Default |
| `linden` | `neutral` | Cream palette, monospace type |
| `maple` | `warm` | Header in the sidebar, rail under each group |
| `almond` | `warm` | Band header, tinted active rows |
| `palm` | `verdant` | Tinted header, accent-only active rows |
| `willow` | `verdant` | One-row header, tinted sidebar, serif headings |
| `aspen` | `aspen` | Default |
| `sequoia` | `dusk` | Default |
| `luma` | `contrast` | Default |

Supported `x-margin.tokens` names are:

```text
background, foreground, primary, primary-foreground,
secondary, secondary-foreground, muted, muted-foreground,
accent, accent-foreground, border, ring, card, card-foreground,
popover, popover-foreground, info, warning, error
```

## Not supported

- Layout and palette names are not substitutes for valid `theme` names.
- Unknown `x-margin.tokens` names are ignored, including `radius`, font names, layout dimensions, and raw `--color-fd-*` names.
- Named colors, `rgb()`, and alpha hex values are not supported in the documented color fields.
- Single-member mode pairs are not supported token overrides.

## Errors

| Identifier | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable (configuration diagnostic) | Invalid color value. | Use `#RGB` or `#RRGGBB`. |

## Verify

After deployment, switch the published page between light and dark mode. Run this expression in the browser console to inspect the active primary color:

```js
getComputedStyle(document.documentElement)
  .getPropertyValue("--color-fd-primary")
  .trim()
```

For the canonical configuration, expect `#0F5A3C` in light mode and `#6EE7B7` in dark mode, unless site CSS overrides the token. If the value differs, check for `colors: null`, invalid hex values, or overriding stylesheet rules.
