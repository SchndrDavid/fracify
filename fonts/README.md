# Fonts

Four families are committed here. Nothing is fetched from a CDN at runtime, and
`tools/build-fonts.py` regenerates everything in this folder.

| Family | Files | Used for | Licence |
| --- | --- | --- | --- |
| Metropolis | `Metropolis-Regular.woff2`, `Metropolis-Bold.woff2` | the face the templates ask for | [Unlicense](licenses/Metropolis-UNLICENSE.txt), from [dw5/Metropolis](https://github.com/dw5/Metropolis) v11 |
| Liberation Sans | `LiberationSans-Regular.woff2` | stands in for Arial in the templates | [SIL OFL 1.1](licenses/LiberationSans-OFL.txt), from [liberationfonts](https://github.com/liberationfonts/liberation-fonts) 2.1.5 |
| Archivo | `archivo-*.woff2` | headings in the interface | [SIL OFL 1.1](licenses/Archivo-OFL.txt), via Fontsource |
| IBM Plex Sans | `ibm-plex-sans-*.woff2` | body text in the interface | [SIL OFL 1.1](licenses/IBMPlexSans-OFL.txt), via Fontsource |

`embedded-fonts.js` is generated: it holds Metropolis and Liberation Sans as
base64 data URIs. Those get inlined into a template's `<defs>` before it is
rasterised, because an SVG loaded into an `<img>` is an isolated document and
never sees the `@font-face` rules of the page around it.

Metropolis and Liberation Sans are subset to Latin-1 plus Latin Extended-A —
enough for Czech, French, Polish and German — which keeps the payload that
travels inside every exported SVG at about 70 kB.

Two faces are deliberately missing:

- **Arial.** It cannot be redistributed. Liberation Sans has identical metrics,
  so every Arial run in a template is switched to it when the template loads.
  Only the regular weight is shipped, because that is all the templates use.
- **French Script MT.** Microsoft's, so it is not in this repo either. It is the
  "Frac" wordmark in the post and story templates. Convert that text to curves
  in Affinity; until then the app logs a warning and the browser substitutes
  whatever cursive it has.
