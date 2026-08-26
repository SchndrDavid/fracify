#!/usr/bin/env python3
"""Splits a photo layer Affinity flattened into one bitmap back into two.

The post and the story are built from two photos: one covering the whole
canvas, and a straight-edged cutout of a second one laid over it. Affinity's
SVG export rasterises both into a single <image>, so only one of them is left
to address and the join between them is frozen into the pixels.

This finds the join and undoes it. The flattened placeholder is two flat
colours meeting along one straight edge; the edge is fitted, turned into a
clipPath, and the single <use> becomes two - the original image underneath and
a second, clipped one on top. Both start out pointing at the same bitmap, so
the template renders exactly as it did until a photo is actually dropped into
one of them.

    pip install pillow
    python tools/split-photo-layer.py templates/post.svg --image _Image1
    python tools/split-photo-layer.py templates/post.svg --image _Image1 --dry-run

It refuses to touch anything whose join is not a straight line between two flat
colours, which is the only case it can claim to be reconstructing rather than
inventing.
"""

import argparse
import base64
import io
import os
import re
import sys

from PIL import Image

IMAGE = '<image id="%s" width="(\\d+)px" height="(\\d+)px" xlink:href="data:image/(\\w+);base64,([A-Za-z0-9+/=]*)"'


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def dominant_colours(image, step=4):
    counts = {}
    px = image.load()
    for y in range(0, image.size[1], step):
        for x in range(0, image.size[0], step):
            counts[px[x, y]] = counts.get(px[x, y], 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    total = float(sum(counts.values()))
    return [(colour, n / total) for colour, n in ranked[:2]]


def nearer(colour, first, second):
    da = sum((colour[i] - first[i]) ** 2 for i in range(3))
    db = sum((colour[i] - second[i]) ** 2 for i in range(3))
    return 0 if da < db else 1


def trace_edge(image, first, second):
    """The first left-to-right change of region on each row."""
    px = image.load()
    width, height = image.size
    points = []
    for y in range(height):
        previous = None
        for x in range(width):
            side = nearer(px[x, y], first, second)
            if previous is not None and side != previous:
                points.append((x, y))
                break
            previous = side
    return points


def fit_edge(points):
    """x = slope * y + intercept, and how far the worst point strays from it."""
    n = len(points)
    mx = sum(p[0] for p in points) / float(n)
    my = sum(p[1] for p in points) / float(n)
    syy = sum((p[1] - my) ** 2 for p in points)
    if syy < 1e-6:
        return None
    slope = sum((p[1] - my) * (p[0] - mx) for p in points) / syy
    intercept = mx - slope * my
    worst = max(abs(p[0] - (slope * p[1] + intercept)) for p in points)
    return slope, intercept, worst


def cutout_polygon(slope, intercept, width, height, region_of):
    """The canvas corners on one side of the fitted line, in order.

    Which corners belong to the cutout is read off the bitmap itself rather
    than reasoned out from the sign of the slope, which is easy to get
    backwards and impossible to notice afterwards.
    """
    def x_at(y):
        return slope * y + intercept

    def y_at(x):
        return (x - intercept) / slope if abs(slope) > 1e-9 else None

    crossings = []
    for x in (0.0, float(width)):
        y = y_at(x)
        if y is not None and -1 <= y <= height + 1:
            crossings.append((x, min(max(y, 0.0), float(height))))
    for y in (0.0, float(height)):
        x = x_at(y)
        if -1 <= x <= width + 1:
            crossings.append((min(max(x, 0.0), float(width)), y))
    unique = []
    for point in crossings:
        if not any(abs(point[0] - q[0]) < 0.5 and abs(point[1] - q[1]) < 0.5 for q in unique):
            unique.append(point)
    if len(unique) != 2:
        sys.exit("the join does not cross the canvas cleanly (%d crossings)" % len(unique))

    corners = [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]
    kept = [c for c in corners if region_of(c)]
    if not kept:
        sys.exit("the cutout does not include a single corner of the canvas")

    # Walk the outline clockwise, dropping in the two crossings where they fall.
    outline = []
    for i, corner in enumerate(corners):
        if corner in kept:
            outline.append(corner)
        nxt = corners[(i + 1) % 4]
        for point in unique:
            on_edge = (abs(corner[0] - nxt[0]) < 1e-9 and abs(point[0] - corner[0]) < 0.5) or \
                      (abs(corner[1] - nxt[1]) < 1e-9 and abs(point[1] - corner[1]) < 0.5)
            between = min(corner[0], nxt[0]) - 0.5 <= point[0] <= max(corner[0], nxt[0]) + 0.5 and \
                      min(corner[1], nxt[1]) - 0.5 <= point[1] <= max(corner[1], nxt[1]) + 0.5
            if on_edge and between and point not in outline:
                outline.append(point)
    return outline


def next_image_id(source):
    used = [int(n) for n in re.findall(r'<image id="_Image(\d+)"', source)]
    return "_Image%d" % (max(used) + 1 if used else 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg")
    parser.add_argument("--image", required=True, help="id of the flattened photo <image>")
    parser.add_argument("--lower", action="store_true",
                        help="clip the lower region instead of the upper one")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = read(args.svg)
    match = re.search(IMAGE % args.image, source)
    if not match:
        sys.exit("no <image id=\"%s\"> in this file" % args.image)
    width, height = int(match.group(1)), int(match.group(2))
    bitmap = Image.open(io.BytesIO(base64.b64decode(match.group(4)))).convert("RGB")

    use_match = re.search(r'<use[^>]*xlink:href="#%s"[^>]*/>' % args.image, source)
    if not use_match:
        sys.exit("nothing references #%s with a <use>" % args.image)
    use_tag = use_match.group(0)

    (first, share_a), (second, share_b) = dominant_colours(bitmap)
    print("%s  #%s  %d x %d" % (os.path.basename(args.svg), args.image, width, height))
    print("   two flat regions: %s %.1f%% and %s %.1f%%" % (first, share_a * 100, second, share_b * 100))
    if share_a + share_b < 0.9:
        sys.exit("   the layer is not two flat colours (%.1f%% covered); refusing to split it"
                 % ((share_a + share_b) * 100))

    points = trace_edge(bitmap, first, second)
    if len(points) < 50:
        sys.exit("   no join found between the two regions")
    fitted = fit_edge(points)
    if not fitted:
        sys.exit("   the join is not a line this tool can express")
    slope, intercept, worst = fitted
    print("   join traced on %d rows: x = %.5f*y + %.3f, worst deviation %.2f px" % (len(points), slope, intercept, worst))
    if worst > 2.5:
        sys.exit("   the join is not straight (%.2f px); refusing to split it" % worst)

    px = bitmap.load()

    def side_at(x, y):
        sx = int(min(max(x, 2), width - 3))
        sy = int(min(max(y, 2), height - 3))
        return nearer(px[sx, sy], first, second)

    # The cutout is the region touching the top edge, unless told otherwise.
    wanted = side_at(width / 2.0, height - 3) if args.lower else side_at(width / 2.0, 2)
    polygon = cutout_polygon(slope, intercept, width, height,
                             lambda c: side_at(c[0], c[1]) == wanted)
    path = "M" + "L".join("%g,%g" % (round(x, 3), round(y, 3)) for x, y in polygon) + "Z"
    print("   cutout: %s" % path)

    top_id = next_image_id(source)
    clip_id = "_clipPhotoTop"
    replacement = (
        '%s<clipPath id="%s"><path d="%s"/></clipPath>'
        '<g clip-path="url(#%s)"><use xlink:href="#%s" x="0" y="0" width="%dpx" height="%dpx"/></g>'
        % (use_tag, clip_id, path, clip_id, top_id, width, height)
    )
    updated = source.replace(use_tag, replacement, 1)

    twin = '<image id="%s" width="%dpx" height="%dpx" xlink:href="data:image/%s;base64,%s"/>' % (
        top_id, width, height, match.group(3), match.group(4))
    element = match.group(0) + "/>"
    if element not in updated:
        sys.exit("could not find the end of the <image> element")
    updated = updated.replace(element, element + twin, 1)

    print("   -> #%s stays as the layer underneath, #%s is the cutout on top" % (args.image, top_id))
    if args.dry_run:
        print("   (dry run, nothing written)")
        return
    io.open(args.svg, "w", encoding="utf-8", newline="").write(updated)
    print("   written")


if __name__ == "__main__":
    main()
