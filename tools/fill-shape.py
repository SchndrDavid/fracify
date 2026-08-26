#!/usr/bin/env python3
"""Fills a vector shape with a bitmap the export flattened to a solid colour.

The plate behind the "Frac" wordmark is the French flag: navy, white, red, with
rounded ends. SVG cannot express three colours in one path, so an export that
rasterises nothing writes the whole plate as `fill:white` and the flag is gone.

This keeps the shape exactly as it is and uses it as a clip: the path becomes a
clipPath, and the picture is drawn through it across the shape's own bounding
box. Nothing about the geometry, the corners or the transforms changes.

    pip install pillow
    python tools/fill-shape.py templates/post.svg --shape Rectangle-3 \\
        --with templates/logo-plate.png

The bounding box is read off the path data. That is exact for a shape built
from lines and corner curves, which is what a rounded rectangle is, because
every control point of the corners lies inside the box.
"""

import argparse
import base64
import io
import os
import re
import sys

NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def path_bbox(d):
    """Min and max of every coordinate pair in the path data."""
    numbers = [float(n) for n in NUMBER.findall(d)]
    if len(numbers) < 4:
        sys.exit("the shape has too little path data to measure")
    xs = numbers[0::2]
    ys = numbers[1::2]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg")
    parser.add_argument("--shape", required=True, help="id of the <path> to fill")
    parser.add_argument("--with", dest="picture", required=True, help="PNG or JPEG to fill it with")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = read(args.svg)
    match = re.search(r'(<g id="%s"[^>]*>)\s*(<path d="([^"]+)"[^>]*/>)' % re.escape(args.shape), source)
    if not match:
        sys.exit("no <g id=\"%s\"> wrapping a single <path> in this file" % args.shape)

    opening, element, data = match.group(1), match.group(2), match.group(3)
    x, y, width, height = path_bbox(data)
    kind = "png" if args.picture.lower().endswith(".png") else "jpeg"
    encoded = base64.b64encode(open(args.picture, "rb").read()).decode("ascii")
    clip_id = "_clipFill" + re.sub(r"\W", "", args.shape)

    filled = (
        '<clipPath id="%s"><path d="%s"/></clipPath>'
        '<g clip-path="url(#%s)"><image x="%g" y="%g" width="%g" height="%g" '
        'preserveAspectRatio="none" xlink:href="data:image/%s;base64,%s"/></g>'
        % (clip_id, data, clip_id, x, y, width, height, kind, encoded)
    )

    print("%s  #%s" % (os.path.basename(args.svg), args.shape))
    print("   box %g, %g  %g x %g  <- %s" % (x, y, width, height, os.path.basename(args.picture)))
    if args.dry_run:
        print("   (dry run, nothing written)")
        return
    updated = source.replace(opening + element, opening + filled, 1)
    if updated == source:
        updated = source[:match.start(2)] + filled + source[match.end(2):]
    io.open(args.svg, "w", encoding="utf-8", newline="").write(updated)
    print("   written")


if __name__ == "__main__":
    main()
