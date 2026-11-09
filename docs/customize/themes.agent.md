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
- Omitted `theme` uses the `neutral` layout and palette. Unknown `theme` falls back to `neutral` with a diagnostic.
- Margin theme mappings approximate Mintlify layouts rather than reproducing Mintlify themes pixel for pixel.
- `colors.primary` sets the base primary color for both page modes.
- `colors.dark` sets the primary color in light mode. Omitted `colors.dark` falls back to the base primary color.
- `colors.light` sets the primary color in dark mode. Omitted `colors.light` falls back to the base primary color.
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
- A single primary color can receive automatic black or white primary foreground text. For primary color pairs, set `primary-foreground` explicitly if the preset text lacks contrast.

Theme mappings are:

| `theme` | Margin layout | Palette |
| --- | --- | --- |
| `mint` | `neutral` | `neutral` |
| `linden` | `neutral` | `neutral` |
| `maple` | `warm` | `ruby` |
| `almond` | `warm` | `solar` |
| `palm` | `verdant` | `emerald` |
| `willow` | `verdant` | `ocean` |
| `aspen` | `aspen` | `aspen` |
| `sequoia` | `dusk` | `dusk` |
| `luma` | `contrast` | `black` |

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
