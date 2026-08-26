# Fracify

Fills in the FRAC club's Affinity Designer templates in the browser — type the
texts, drop in the photos, export a full-resolution PNG — so that posting to
Instagram no longer means opening Affinity.

![The paired editor: one form on the left, the post and the story previewed side by side](docs/screenshot.jpg)

Everything runs client side. There is no build step, no bundler and no
dependency that is not committed to this repo: `index.html`, `app.js`,
`styles.css`, the fonts and the templates are served exactly as they are.
Nothing you type or upload leaves the browser.

## The templates

Nine templates ship with it, all exported from Affinity Designer. They are the
source of truth — the app only substitutes text and swaps image data, it never
redraws artwork. The picker groups them the way the manifest says.

| Group | Template | Size | What changes |
| --- | --- | --- | --- |
| Instagram | Post + story | 1080 × 1080 and 1080 × 1920 | two photos, place, time, theme, day, month |
| Announcement | Announcement | 1080 × 1920 | photo, a two-line message |
| Presentation | Cover | 1080 × 1080 | four separate lines |
| Presentation | Discussion 1 / 2 | 1080 × 1080 | title and three question blocks |
| Presentation | Speed dating 1 / 2 | 1080 × 1080 | title and three question blocks |
| Presentation | Vocabulary | 1080 × 1080 | title and ten French/Czech pairs |

Every field opens on a French placeholder rather than on the last real post,
so nothing has to be cleared before it can be filled in. Inside a group, a
**Next** button in the top bar walks to the following template, which is how you
get through the six presentation slides without going back to the picker between
each one.

The post and the story always carry the same words, so they are one entry:
filling them in twice was only ever a way to get them out of step. A `pair` in
the manifest opens several templates in one editor, where every field drives the
slot of the same name in each of them, each preview updates as you type, and
either one can be exported on its own or both at once. The photo is cropped once
per template, so the same picture is framed for a square and for a
nine-by-sixteen without being uploaded twice.

The presentation templates share a fixed background, which is not offered for
replacement. Groups, their order and the order of the templates inside them all
come from `templates/manifest.json`; a template that names no group lands in an
"Other" section rather than disappearing.

## Running it

Any static file server will do, and so will GitHub Pages — this repo deploys
itself there from `.github/workflows/pages.yml` on every push to `main`.

Locally:

```sh
python3 -m http.server 8000        # then open http://localhost:8000/
```

A server is needed because browsers refuse to read the `templates/` folder over
`file://`; opening `index.html` straight off the disk shows an explanation
rather than failing silently.

In a container:

```sh
docker compose up -d --build       # then open http://<host>:8105/
```

The container is a static file server with a health endpoint at `/api/health`
and nothing else. It writes nothing to disk and keeps no state, so it can be
thrown away and rebuilt at any time.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRACIFY_PORT` | `8105` | host port the container is published on |
| `FRACIFY_UID` | `1000` | user id the container runs as |
| `FRACIFY_GID` | `1000` | group id the container runs as |

Every variable has a default in `compose.yml`, so the service starts without a
`.env` file. Copy `.env.example` to `.env` if you need to override one.

## What it has to work around

Affinity's SVG export is not built for substitution, and four things bite:

**Templates have no line wrapping.** Every visual line is its own `<text>` with
an absolute `x` and `y`; a longer sentence would simply run out of the box it
sits in. So a slot's lines are regenerated: the text is wrapped to the width the
slot allows, measured with `getComputedTextLength()` on a live element, and if
it still does not fit in the number of lines the design has room for, the font
size drops in 2 px steps until it does. Line spacing comes from the gap between
the original elements, not from a guess. When a field has been shrunk the form
says so, because the result is smaller than the design intends.

**Affinity bakes kerning into tspans.** A heading comes out as
`SB Co<tspan x="-127.342px -63.905px">wo</tspan>rk 1. patr<tspan x="302.516px">o</tspan>`,
where those `x` lists pin individual glyphs. Replacing just the string scatters
the letters, so an edited line is rebuilt from scratch — same `style`, same
start point, same parent transform, no tspans.

**Fonts have to travel inside the SVG.** An SVG loaded into an `<img>` to be
drawn on a canvas is an isolated document: the page's `@font-face` rules never
reach it, and Metropolis would quietly become whatever the system offers. Before
rasterising, the faces are inlined into `<defs>` as `data:font/woff2;base64`.
See [fonts/README.md](fonts/README.md) for what is shipped and why Arial and
French Script MT are not. The "Frac" wordmark is stored as curves instead of
text, so it needs no font at all:

```sh
python3 tools/outline-logo.py --font /path/to/FRSCRIPT.TTF templates/post.svg
```

That is the same thing Affinity's "convert to curves" does on export. It only
touches the text elements set in that font, leaves the rest of the file byte for
byte alone, and never puts the font in the repo.

**A rectangle has nowhere to put a photo.** The post is built from a photo
across the whole canvas and a straight-edged cutout of a second one over it.
Exported cleanly those arrive as two plain `<rect>`s — and both covering
everything, because the cut that makes the upper one a cutout does not survive
either. `tools/photo-slots.py` turns each rectangle into an `<image>` of the
same geometry holding a swatch of its colour, so there is something whose data
can be replaced, and rewrites the upper one's clip from a full-canvas rectangle
to the straight cut. (`tools/split-photo-layer.py` does the same job for an
export where the two layers were rasterised into a single bitmap: it fits the
edge between the two flat regions and splits the element in two.)

**SVG cannot fill one shape with three colours.** The plate behind the
wordmark is the French flag, so a clean export writes the whole thing as
`fill:white` and the flag is gone. `tools/fill-shape.py` keeps the path exactly
as it is and uses it as a clip, drawing `templates/logo-plate.png` through it
across the shape's own bounding box, so the corners and the transforms are
untouched.

**Affinity bakes kerning against its own cut of Metropolis.** Every heading
comes out with tspans pinning individual glyphs to absolute positions worked out
against the exact font file the designer has installed. Any other build lays the
run out a hair narrower, the pinned glyph stays where it was told, and a gap
opens mid-word — "patr o" instead of "patro". The app rebuilds a line without
tspans as soon as it is edited; `tools/strip-kerning.py` does the same to the
template so the placeholder is right before anyone touches it.

**Affinity flattens a translucent layer on export.** The blue panel on the post
and the story is drawn over the photos at 80 % opacity. The SVG export
rasterises it and bakes whatever happened to be behind it into the bitmap, so
the panel arrives fully opaque with a ghost of the stock photo frozen inside —
change the photo and the panel keeps showing the old one.
`tools/unflatten-panel.py` measures what the layer was, by rendering the
template once without it and fitting `baked = opacity × colour + (1 − opacity) ×
behind` over the panel's pixels, then writes the layer back as its own colour at
its own opacity. It refuses to touch a panel that does not turn out to be one
flat colour.

**The root has no pixel size.** The templates say `width="100%" height="100%"`,
which Safari renders blank or badly scaled once the file is in an `<img>`. The
root is pinned to the `viewBox` size before anything is drawn.

A text field you have not touched keeps its original nodes untouched, so an
export made without editing anything is identical to the template, down to the
pixel. `tools/fidelity-test.py` is what proves it.

## Re-exporting a template from Affinity

Three of the four problems above are export settings, not design problems. When
the artwork changes, export it like this and none of them happen:

- **Rasterise: Nothing.** The default, "Unsupported properties", is what
  flattens the panel and merges the photo layers — Affinity decides what it
  cannot express and bakes whatever sits behind it into the bitmap along the
  way. "Everything" turns the whole artboard into one image and leaves nothing
  to fill in at all.
- **Leave "Convert text to curves" off**, or every field disappears. The one
  exception is the "Frac" wordmark: convert that layer to curves *in the
  document* instead, so it needs no font and everything else stays editable.
- **Keep the two photos as two layers.** If they are already merged in the
  document, no export setting will separate them again.

Then check what actually came out:

```sh
python3 tools/check-manifest.py --list post
```

Two 1080 × 1080 images for the photos rather than one, no `<image>` for the
panel, five `<text>` elements, and nothing left in FrenchScriptMT. If any of
that is off, the three tools in `tools/` put it right — `split-photo-layer.py`,
`unflatten-panel.py` and `outline-logo.py`, in that order — but each one is
measurement standing in for information the export threw away, so a clean export
is always better.

## Adding a template

Drop the SVG into `templates/` and give the app a way to find the editable
parts. Either is enough:

1. **Name the layers in Affinity.** A layer called `slot:theme` becomes a field
   named "Theme"; an image layer called `slot:photo-main` becomes a photo slot.
   Options can be appended: `slot:theme|lines=2|width=700|align=center|label=Topic`.
   Anything left out is worked out from the template itself — how wide the
   longest existing line is, and whether Affinity centred the block.
2. **Map it in `templates/manifest.json`.** For files already exported without
   slot names, a slot lists the indices of the `<text>` elements it owns, in
   document order, or the `id` of the `<image>` whose data gets replaced. A
   `placeholder` is what the field opens on; `maxLines` is how many lines the
   design has room for before the text has to start shrinking. Leaving a text
   out of every slot keeps it in the artwork and out of the form, which is what
   fixed labels want.

Either way, add the file to the `templates` array in the manifest so it turns up
in the picker. A template with neither slot names nor a mapping is shown as
unsupported, with the reason, rather than failing quietly.

```sh
python3 tools/check-manifest.py                # validate every mapping
python3 tools/check-manifest.py --list mots    # list a file's texts and images
python3 tools/make-thumbs.py                   # redraw the picker thumbnails
```

## Tests

```sh
pip install pillow
python3 tools/fidelity-test.py                 # all nine templates
python3 tools/fidelity-test.py post --stress   # plus a long-text pass
```

For each template, headless Chrome renders the untouched file and the same file
run through the whole pipeline, then the two PNGs are compared. Any difference
at all is a failure. `--stress` additionally renders every text slot filled with
a sentence far too long for it, which is the quickest way to see wrapping,
shrinking and overflow behave.

## Photos

A photo is cropped to fill its slot, never letterboxed, and resized to the
slot's own dimensions before being embedded — a 12 Mpx phone photo would
otherwise add a third again as much base64 to the file. Four sliders decide what
you actually see:

| Slider | Range | What it does |
| --- | --- | --- |
| X | −100…100 % | slides the crop left or right, if the framing leaves any slack |
| Y | −100…100 % | the same vertically, which portraits usually need |
| Zoom | 100…250 % | pushes in past the fill, which is what creates the slack for X and Y |
| Blur | 0…40 px | softens the photo behind the panel so the text on top stays readable |

Blur is drawn into the bitmap rather than layered over it, and the crop is
rendered with a margin of three times the radius that is thrown away afterwards,
so the faded edge a blur leaves behind never reaches the canvas. Where the
browser has no canvas `filter` — Safari before 17 — it falls back to a
downscale-and-upscale that looks the same behind a panel.

## Known quirk

The placeholder text in the post, story and announcement templates can show a
small gap where Affinity pinned a single glyph with a `tspan` — "patr o" instead
of "patro". That gap is in the exported file itself and shows up in any browser,
because the pinned position assumes the exact cut of Metropolis the designer had
installed. Typing over the field fixes it: an edited line is rebuilt without the
pinned positions.

## License

Released under the MIT License — see [LICENSE](LICENSE). The fonts keep their
own licences, listed in [fonts/README.md](fonts/README.md). The templates and
the FRAC artwork belong to the club.
