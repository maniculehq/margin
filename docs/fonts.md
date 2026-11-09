# Fonts

The framework bundles two default webfonts. A site's `fonts` block in
`docs.json` overrides either role, and the framework then skips the default
font's preload.

| Role        | CSS family      | Source                                                                         | License     |
| ----------- | --------------- | ------------------------------------------------------------------------------ | ----------- |
| Body and UI | `InterVariable` | [rsms/inter](https://github.com/rsms/inter)                                    | SIL OFL 1.1 |
| Code        | `GeistMono`     | `geist` npm package ([vercel/geist-font](https://github.com/vercel/geist-font)) | SIL OFL 1.1 |

Both licenses declare no Reserved Font Name, so the subsetted files may keep
their names.

## Files

- `scripts/fonts-source/InterVariable.woff2` and
  `scripts/fonts-source/GeistMonoVariable.woff2` are the unmodified variable
  sources. `GeistMonoVariable.woff2` is a byte-for-byte copy of
  `geist/dist/fonts/geist-mono/GeistMono-Variable.woff2`. The sources are
  committed but never served.
- `scripts/fonts-source/InterVariable-OFL.txt` and
  `scripts/fonts-source/GeistMonoVariable-OFL.txt` hold each font's copyright
  notice and full OFL 1.1 text. The `NOTICE` file repeats them.
- `src/assets/InterVariable-{latin,latin-ext,cyrillic,greek,vietnamese}.woff2`
  and `src/assets/GeistMonoVariable-latin.woff2` are the per-script subsets
  the app serves. The root route preloads the two `latin` subsets.
- `src/styles/fonts.css` declares the `@font-face` rules for the subsets and
  the metric-matched fallback faces `InterFallback` (local Arial) and
  `GeistMonoFallback` (local Courier New). The fallbacks use `size-adjust` and
  ascent, descent and line-gap overrides so the `font-display: swap` from the
  fallback to the webfont does not shift layout.

The OG image route renders with Geist Sans, which it imports straight from
the `geist` package; it does not use these files.

## Regenerating the subsets

Run the script after replacing a source font or changing the subset table:

```sh
bun scripts/subset-fonts.ts
```

It rewrites the subsets in `src/assets/` and `src/styles/fonts.css`,
including the fallback metrics, which it computes from
the shipped latin subset with `@capsizecss/unpack` and the system fonts'
`@capsizecss/metrics` data. The output is deterministic: running it twice on
the same sources leaves `git diff` empty. Do not edit `fonts.css` by hand.

To update Geist Mono, copy the new `GeistMono-Variable.woff2` from the
installed `geist` package over `scripts/fonts-source/GeistMonoVariable.woff2`,
refresh `GeistMonoVariable-OFL.txt` from the package's `LICENSE.txt`, rerun
the script and commit the results.
