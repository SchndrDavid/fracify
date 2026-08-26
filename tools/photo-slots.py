#!/usr/bin/env python3
"""Turns the flat placeholder rectangles of a template into photo slots.

Exported with "Rasterise: Nothing", the two photo layers of the post and the
story come out as plain coloured <rect>s. That is the right thing for every
other reason, but a rectangle has nowhere to put a photograph, and the straight
cut that makes the upper layer a cutout rather than a full cover does not
survive the export either - both rectangles arrive covering the whole canvas,
so the upper one simply hides the lower.

This gives them back:

- each rectangle becomes an <image> of the same geometry, holding a swatch of
  the colour it had. Nothing changes on screen, but there is now an image whose
  data the app can replace.
- the clip on the upper one is rewritten from a full-canvas rectangle to the
  straight cut, given as the two points where it crosses the canvas.

    pip install pillow
    python tools/photo-slots.py templates/post.svg \\
        --bottom-fill 255,136,116 --top-fill 255,216,225 \\
        --cut 0,389.121 1080,779.99
"""

import argparse
import base64
import io
import os
import re
import sys

from PIL import Image

RECT = r'<rect([^>]*?)style="fill:rgb\(%d,%d,%d\);?"([^>]*?)/>'


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def attribute(tag, name, default=None):
    match = re.search(r'\b%s="([^"]*)"' % name, tag)
    return match.group(1) if match else default


def swatch(colour):
    image = Image.new("RGB", (8, 8), colour)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def find_rect(source, colour, where):
    matches = list(re.finditer(RECT % colour, source))
    if not matches:
        sys.exit("no <rect> filled rgb%s for the %s layer" % (colour, where))
    if len(matches) > 1:
        sys.exit("%d rects are filled rgb%s; cannot tell which is the %s layer"
                 % (len(matches), colour, where))
    return matches[0]


def to_image(match, image_id, colour):
    tag = match.group(0)
    geometry = " ".join(
        '%s="%s"' % (name, attribute(tag, name, "0"))
        for name in ("x", "y", "width", "height")
    )
    # preserveAspectRatio="none" so the swatch fills the box exactly as the
    # rectangle did; the app overrides it the moment a real photo goes in.
    return ('<image id="%s" %s preserveAspectRatio="none" '
            'xlink:href="data:image/png;base64,%s"/>' % (image_id, geometry, swatch(colour)))


def clipping_group(source, position):
    """The <g clip-path="url(#id)"> that encloses the given offset, if any."""
    best = None
    for match in re.finditer(r'<g clip-path="url\(#([^)]+)\)">', source):
        if match.end() <= position and (best is None or match.end() > best.end()):
            best = match
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg")
    parser.add_argument("--bottom-fill", required=True, help="R,G,B of the layer underneath")
    parser.add_argument("--top-fill", required=True, help="R,G,B of the cutout on top")
    parser.add_argument("--cut", nargs=2, metavar="X,Y",
                        help="the two points where the straight cut crosses the canvas; "
                             "the cutout is what lies above it")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = read(args.svg)
    bottom_colour = tuple(int(v) for v in args.bottom_fill.split(","))
    top_colour = tuple(int(v) for v in args.top_fill.split(","))

    print("%s" % os.path.basename(args.svg))
    updated = source
    for colour, image_id, where in ((bottom_colour, "_ImagePhotoBottom", "bottom"),
                                    (top_colour, "_ImagePhotoTop", "top")):
        match = find_rect(updated, colour, where)
        replacement = to_image(match, image_id, colour)
        print("   %-6s rect %s -> <image id=\"%s\">" % (where, match.group(0)[:60] + "…", image_id))
        updated = updated[:match.start()] + replacement + updated[match.end():]

    if args.cut:
        (x0, y0), (x1, y1) = (tuple(float(v) for v in p.split(",")) for p in args.cut)
        anchor = updated.index('id="_ImagePhotoTop"')
        group = clipping_group(updated, anchor)
        if not group:
            sys.exit("   the cutout is not inside a clipped group; nothing to reshape")
        clip_id = group.group(1)
        clip = re.search(r'<clipPath id="%s">\s*<rect([^>]*)/>\s*</clipPath>' % re.escape(clip_id), updated)
        if not clip:
            sys.exit("   clipPath #%s is not a single rect; refusing to reshape it" % clip_id)

        # The clip lives in its own translated space; the offset is whatever
        # its rectangle already carries relative to the canvas.
        dx = float(attribute(clip.group(1), "x", "0"))
        dy = float(attribute(clip.group(1), "y", "0"))
        width = float(attribute(clip.group(1), "width", "1080"))
        corners = [(0.0, 0.0), (width, 0.0), (x1, y1), (x0, y0)]
        path = "M" + "L".join("%g,%g" % (round(px + dx, 3), round(py + dy, 3)) for px, py in corners) + "Z"
        print("   clip  #%s: full rect -> cut at (%g,%g)-(%g,%g)" % (clip_id, x0, y0, x1, y1))
        updated = updated[:clip.start()] + '<clipPath id="%s"><path d="%s"/></clipPath>' % (clip_id, path) + updated[clip.end():]

    if args.dry_run:
        print("   (dry run, nothing written)")
        return
    io.open(args.svg, "w", encoding="utf-8", newline="").write(updated)
    print("   written")


if __name__ == "__main__":
    main()
