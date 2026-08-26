#!/usr/bin/env python3
"""Drops the white outline an export baked into the edge of a flat bitmap.

Affinity rasterises the blue panel behind the post's text as a PNG, and it
draws the shape's one-pixel white stroke into that PNG. On screen the panel
therefore carries a thin white rim that belongs to no layer anyone can turn
off, and no amount of editing the SVG removes it.

The fix is in the pixels: a bitmap whose opaque area is one flat colour is a
plate, and any lighter pixel sitting on its edge is the stroke. Those pixels
keep their alpha - so the shape, its corners and its anti-aliasing are exactly
as they were - and take the plate's own colour.

The same stroke also leaves white behind the fully transparent pixels around
the shape, where it faded out. Nothing shows it at first, but a renderer that
resamples the bitmap - which is any preview drawn smaller than the artwork -
mixes those invisible pixels into the visible edge, and the white rim comes
back as a fringe. Every pixel that is not fully opaque is repainted the plate's
colour as well, alpha untouched, so there is no white left to bleed.

    pip install pillow
    python tools/strip-outline.py templates/post.svg templates/story.svg

Only the rim is looked at, never the middle, which is what keeps the tool away
from the sponsor logos: those are white on blue too, but their white is inside
the shape, not around it.
"""

import argparse
import base64
import io
import os
import re
import sys
from collections import Counter

from PIL import Image

EMBEDDED = re.compile(r'<image([^>]*?)(xlink:href|href)="data:image/png;base64,([^"]+)"')

FLAT_SHARE = 0.90   # of the opaque pixels, before it counts as a plate
COVERAGE = 0.60     # of the bitmap a plate has to fill, or it is a logo
RIM = 2             # a stroke this many pixels from the edge is still a rim
OPAQUE = 128
LIGHTER = 8         # a rim pixel this much lighter than the plate is stroke


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def plate_colour(pixels, width, height):
    """The one colour a flat plate is made of, or None if it is a picture.

    A plate fills its bitmap; a logo is a shape floating in a lot of empty
    space. Both can be a single flat colour, and only the first one is ours -
    which is why coverage is asked about as well as flatness.
    """
    counts = Counter()
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a >= OPAQUE:
                counts[(r, g, b)] += 1
    if not counts:
        return None
    opaque = sum(counts.values())
    if opaque < COVERAGE * width * height:
        return None
    colour, n = counts.most_common(1)[0]
    return colour if n >= FLAT_SHARE * opaque else None


def on_rim(pixels, width, height, x, y):
    """True when open space is within RIM pixels - the border counts as open."""
    for dy in range(-RIM, RIM + 1):
        for dx in range(-RIM, RIM + 1):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                return True
            if pixels[nx, ny][3] < OPAQUE:
                return True
    return False


def strip(png):
    """Repaints the stroke around a plate. Returns (image, pixels changed)."""
    image = Image.open(io.BytesIO(png)).convert("RGBA")
    width, height = image.size
    pixels = image.load()

    colour = plate_colour(pixels, width, height)
    if colour is None:
        return image, 0

    changed = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if (r, g, b) == colour:
                continue
            # Anything the shape does not fully cover cannot be artwork, so it
            # is repainted whatever its colour: that is where the stroke hides.
            if a < OPAQUE:
                pixels[x, y] = (colour[0], colour[1], colour[2], a)
                changed += 1
                continue
            if r - colour[0] < LIGHTER and g - colour[1] < LIGHTER and b - colour[2] < LIGHTER:
                continue
            if not on_rim(pixels, width, height, x, y):
                continue
            pixels[x, y] = (colour[0], colour[1], colour[2], a)
            changed += 1
    return image, changed


def encode(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg", nargs="+")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for path in args.svg:
        source = read(path)
        print(os.path.basename(path))
        pieces = []
        cursor = 0
        touched = 0

        for match in EMBEDDED.finditer(source):
            name = re.search(r'id="([^"]+)"', match.group(1))
            name = name.group(1) if name else "(unnamed)"
            image, changed = strip(base64.b64decode(match.group(3)))
            if not changed:
                continue
            touched += 1
            print("   %-18s %4d x %-4d  %d stroke pixels repainted"
                  % (name, image.width, image.height, changed))
            pieces.append(source[cursor:match.start(3)])
            pieces.append(encode(image))
            cursor = match.end(3)

        if not touched:
            print("   nothing to strip")
            continue
        if args.dry_run:
            print("   (dry run, nothing written)")
            continue
        pieces.append(source[cursor:])
        io.open(path, "w", encoding="utf-8", newline="").write("".join(pieces))
        print("   written")


if __name__ == "__main__":
    sys.exit(main())
