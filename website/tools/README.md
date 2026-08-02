# Homepage build tooling

`index.html` at the site root is **generated**. Edit the sources here, not the output.

| file | what it is |
|---|---|
| `index.tpl.html` | the page: markup, all CSS, and `{{TOKEN}}` slots for the art and the script |
| `runtime.js` | the root generator, scroll driver, depth gauge and reveals |
| `gen-art.js` | deterministic SVG art (horizon band, tubers, nubbins) → `art.json` |
| `assemble.js` | substitutes the art + runtime into the template → `index.html` |

```sh
node tools/gen-art.js          # regenerate art.json (seeded — identical every run)
node tools/assemble.js ../index.html
```

Nothing in `tools/` is deployed: `npm run build` copies an explicit file list and
this directory is not on it.

## Things that will bite you

- **`styles.css`, `theme.js` and `logo-hover.js` are the guides page's, not the
  homepage's.** `guides/bluesky-for-brands.html` loads `../styles.css` and reads 11
  custom properties from it, and `.theme-toggle` has its only base styling there.
  The homepage is self-contained and loads none of them — but don't delete them.
- The homepage writes the same `localStorage['theme']` key and `data-theme`
  attribute that `theme.js` uses, so the theme carries between the two pages.
- The five mascot PNGs must stay at the site root; `logo-hover.js` hardcodes
  `/atpotato-*.png` and overwrites `src` on load for the guides page.
- The root layer SVG has **no `viewBox`** on purpose: 1 user unit = 1 CSS pixel, so
  stroke widths and dash lengths are exact at every viewport and DPR. Don't add one,
  and never use `preserveAspectRatio="none"` on it.
- Stroke properties go on the `<use>`, never on the `<defs>` path — a presentation
  attribute on the original wins and every dash animation dies silently.
- Printed depths are computed from measured layout, never from the authored
  `data-cm`. The gauge must not be able to lie.
