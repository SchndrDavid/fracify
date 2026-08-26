#!/usr/bin/env python3
"""Puts the transparency back into a panel Affinity flattened on export.

The blue panel in the post and story templates is drawn over the photos at less
than full opacity. Affinity's SVG export rasterises it - and bakes whatever was
behind it at that moment into the bitmap. The panel then arrives fully opaque
with a ghost of the designer's stock photo frozen inside it, so swapping the
photo leaves the panel showing the old one.

This recovers what the layer actually was. It renders the template once with
the panel taken out to see what sits behind it, fits

    baked = opacity * colour + (1 - opacity) * behind

over the pixels of the panel, and writes the panel back as its own colour at
its own opacity, keeping the alpha shape - the rounded corners - as it was.

The fit is trimmed, because parts of the panel are covered by layers drawn
after it - the white strip, the wordmark - and those pixels were never
composited with anything behind. They show up as large residuals and are
dropped. What survives has to be flat to within a few levels or the tool
refuses to touch the file.

    pip install pillow
    python tools/unflatten-panel.py templates/post.svg --image _Image9
    python tools/unflatten-panel.py templates/post.svg --image _Image9 --dry-run

Needs Chrome to render the "behind" pass.
"""

import argparse
import base64
import io
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

IMAGE = '<image id="%s" width="(\\d+)px" height="(\\d+)px" xlink:href="data:image/(\\w+);base64,([A-Za-z0-9+/=]*)"'


def find_chrome():
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    sys.exit("Chrome not found. Set CHROME=<path to chrome>.")


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def viewbox(source):
    box = source.split('viewBox="')[1].split('"')[0].split()
    return int(float(box[2])), int(float(box[3]))


def panel_bitmap(source, image_id):
    match = re.search(IMAGE % image_id, source)
    if not match:
        sys.exit("no <image id=\"%s\"> in this file" % image_id)
    return Image.open(io.BytesIO(base64.b64decode(match.group(4)))).convert("RGBA")


def panel_placement(source, image_id):
    """Where the <use> that references the panel puts it on the canvas."""
    match = re.search(r'<use[^>]*xlink:href="#%s"[^>]*/>' % image_id, source)
    if not match:
        sys.exit("nothing references #%s with a <use>" % image_id)
    tag = match.group(0)
    if "transform" in tag:
        sys.exit("the <use> for #%s carries a transform; this tool only handles "
                 "a panel placed straight onto the canvas" % image_id)
    x = float(re.search(r'\bx="([-\d.]+)"', tag).group(1))
    y = float(re.search(r'\by="([-\d.]+)"', tag).group(1))
    return tag, x, y


def render_without(source, tag, size, chrome):
    """Screenshots the template with one element dropped."""
    scratch = tempfile.mkdtemp(prefix="fracify-unflatten-")
    svg_path = os.path.join(scratch, "behind.svg")
    png_path = os.path.join(scratch, "behind.png")
    io.open(svg_path, "w", encoding="utf-8", newline="").write(source.replace(tag, ""))
    subprocess.run([
        chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=30000", "--no-first-run",
        "--user-data-dir=" + os.path.join(scratch, "profile"),
        "--screenshot=" + png_path, "--window-size=%d,%d" % size,
        "file:///" + svg_path.replace("\\", "/"),
    ], check=True, capture_output=True)
    if not os.path.exists(png_path):
        sys.exit("Chrome rendered nothing for the behind pass")
    return Image.open(png_path).convert("RGB")


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    if not n:
        return None
    return ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0


def fit(panel, behind, x, y):
    """Recovers the layer's opacity and colour from what was baked.

    For any two panel pixels a and b,

        front_a - front_b = (1 - opacity) * (behind_a - behind_b)

    so every pair of pixels whose backgrounds differ enough is one estimate of
    the opacity. The median over thousands of pairs is taken instead of a least
    squares fit because a good fifth of the panel is covered by layers drawn
    after it - the white strip, the wordmark - whose pixels never took part in
    the compositing at all and would drag a fit anywhere. A median tolerates
    them; it only needs the honest pixels to be the majority.
    """
    px = panel.load()
    bx = behind.load()
    samples = []
    width, height = panel.size
    step = max(1, min(width, height) // 300)
    for j in range(0, height, step):
        for i in range(0, width, step):
            if px[i, j][3] != 255:
                continue
            cx, cy = int(round(x)) + i, int(round(y)) + j
            if 0 <= cx < behind.size[0] and 0 <= cy < behind.size[1]:
                samples.append((bx[cx, cy], px[i, j]))
    if len(samples) < 500:
        sys.exit("not enough panel pixels to fit")

    slopes = []
    count = len(samples)
    seed = 1
    for k in range(count * 4):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        a = samples[seed % count]
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        b = samples[seed % count]
        for c in range(3):
            spread = a[0][c] - b[0][c]
            if abs(spread) >= 24:
                slopes.append((a[1][c] - b[1][c]) / float(spread))
    if len(slopes) < 200:
        sys.exit("the background under the panel is too flat to measure its opacity")

    opacity = 1 - median(slopes)
    colours = [median([(f[c] - (1 - opacity) * b[c]) / opacity for b, f in samples]) for c in range(3)]

    def agreeing(opacity, colours):
        return [(b, f) for b, f in samples
                if all(abs(f[c] - (opacity * colours[c] + (1 - opacity) * b[c])) <= 3 for c in range(3))]

    # One refinement pass over the pixels that already fit, so the covered ones
    # stop pulling the estimate around.
    clean = agreeing(opacity, colours)
    if len(clean) > 500:
        refined = []
        seed = 7
        for k in range(len(clean) * 4):
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            a = clean[seed % len(clean)]
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            b = clean[seed % len(clean)]
            for c in range(3):
                spread = a[0][c] - b[0][c]
                if abs(spread) >= 24:
                    refined.append((a[1][c] - b[1][c]) / float(spread))
        if len(refined) >= 200:
            opacity = 1 - median(refined)
        colours = [median([(f[c] - (1 - opacity) * b[c]) / opacity for b, f in clean]) for c in range(3)]

    return opacity, colours, len(agreeing(opacity, colours)) / float(len(samples)), len(samples)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg")
    parser.add_argument("--image", required=True, help="id of the flattened <image>")
    parser.add_argument("--colour", help="skip the measurement and use this R,G,B")
    parser.add_argument("--opacity", type=float, help="skip the measurement and use this opacity")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = read(args.svg)
    panel = panel_bitmap(source, args.image)
    tag, x, y = panel_placement(source, args.image)
    print("%s  #%s at (%g, %g), %d x %d" % (os.path.basename(args.svg), args.image, x, y, panel.size[0], panel.size[1]))

    if args.colour and args.opacity:
        # For a file whose panel was baked over a photograph rather than over a
        # flat placeholder: too little of the background repeats for the
        # measurement to converge, so the values measured on the flat export
        # are carried over.
        colour = tuple(int(v) for v in args.colour.split(","))
        opacity = args.opacity
        print("   given rgba(%d, %d, %d, %.3f), not measured" % (colour + (opacity,)))
    else:
        behind = render_without(source, tag, viewbox(source), find_chrome())
        opacity, colours, agreement, sampled = fit(panel, behind, x, y)
        colour = tuple(max(0, min(255, int(round(v)))) for v in colours)
        print("   %d px sampled, %.1f%% of them explained by one flat layer" % (sampled, agreement * 100))
        print("   -> rgba(%d, %d, %d, %.3f)" % (colour + (opacity,)))
        if agreement < 0.55:
            sys.exit("   only %.1f%% of the panel behaves like one flat colour; refusing to replace it"
                     % (agreement * 100))
    if not 0.05 < opacity < 0.999:
        sys.exit("   opacity %.3f is not plausible; refusing to replace it" % opacity)

    restored = Image.new("RGBA", panel.size, colour + (0,))
    alpha = panel.getchannel("A").point(lambda v: int(round(v * opacity)))
    restored.putalpha(alpha)

    if args.dry_run:
        print("   (dry run, nothing written)")
        return

    buffer = io.BytesIO()
    restored.save(buffer, "PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    updated = re.sub(IMAGE % args.image,
                     lambda m: '<image id="%s" width="%spx" height="%spx" xlink:href="data:image/png;base64,%s"'
                     % (args.image, m.group(1), m.group(2), encoded),
                     source, count=1)
    io.open(args.svg, "w", encoding="utf-8", newline="").write(updated)
    print("   written, %d B of PNG" % len(buffer.getvalue()))


if __name__ == "__main__":
    main()
