#!/usr/bin/env python3
"""Converts live text set in a font that cannot ship into <path> outlines.

The "Frac" wordmark in the post and story templates is set in French Script MT,
which is Monotype's and must not be redistributed - not in this repo and not
inside an exported SVG. Affinity can convert that text to curves on export;
this does the same thing to a template that was exported without it, so the
wordmark looks right on a phone, on a Mac and on a machine that has never heard
of the font.

Only the text elements set in the named font are touched. Everything else in
the file, including the transform of the group the text sits in, is left
exactly as it was.

    pip install fonttools
    python tools/outline-logo.py --font /path/to/FRSCRIPT.TTF \\
        templates/post.svg templates/story.svg

The font is only read. Do not commit it.
"""

import argparse
import io
import os
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

SVG_NS = "http://www.w3.org/2000/svg"
FONT_PROPERTIES = ("font-family", "font-size", "font-weight", "font-style",
                   "font-stretch", "letter-spacing", "text-anchor", "white-space")


def style_dict(style):
    out = {}
    for part in (style or "").split(";"):
        if ":" in part:
            key, value = part.split(":", 1)
            out[key.strip()] = value.strip()
    return out


def paint_style(style):
    """Keeps the paint, drops everything that only means something to text."""
    kept = [(k, v) for k, v in style_dict(style).items() if k not in FONT_PROPERTIES]
    return ";".join("%s:%s" % (k, v) for k, v in kept) + (";" if kept else "")


def kern_pairs(font):
    if "kern" not in font:
        return {}
    pairs = {}
    for table in font["kern"].kernTables:
        pairs.update(table.kernTable)
    return pairs


def outline(font, text, x, y, size):
    """Draws a run of text as one path, in the coordinates the <text> used."""
    upem = font["head"].unitsPerEm
    scale = size / upem
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    widths = font["hmtx"]
    kerning = kern_pairs(font)

    pen = SVGPathPen(glyph_set, ntos=lambda v: repr(round(v, 3)))
    cursor = 0.0
    previous = None
    missing = []

    for character in text:
        name = cmap.get(ord(character))
        if name is None:
            missing.append(character)
            continue
        if previous is not None:
            cursor += kerning.get((previous, name), 0) * scale
        # Font units run upwards, SVG units downwards, hence the flipped y.
        glyph_set[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + cursor, y)))
        cursor += widths[name][0] * scale
        previous = name

    return pen.getCommands(), missing


# A <text> element with a plain string in it: no tspans, nothing nested. The
# templates only pin glyphs with tspans where kerning was baked in, and the
# wordmark is not one of those. Anything more complicated is left alone and
# reported, rather than being guessed at.
TEXT_ELEMENT = re.compile(r'<text\b([^>]*)>([^<]*)</text>')
ATTRIBUTE = re.compile(r'(\w[\w:-]*)\s*=\s*"([^"]*)"')


def convert(path, font, family_pattern, dry_run):
    """Replaces matching <text> elements with <path>, byte for byte otherwise.

    The file is edited as text rather than re-serialised from a parse tree: an
    XML round trip would rewrite every attribute in a two megabyte Affinity
    export, and the templates are the source of truth.
    """
    source = io.open(path, encoding="utf-8", newline="").read()
    hits = [0]
    problems = []

    def replace(match):
        attributes = dict(ATTRIBUTE.findall(match.group(1)))
        style = attributes.get("style", "")
        if not re.search(family_pattern, style, re.I):
            return match.group(0)

        text = match.group(2)
        size = float(re.sub(r"[^\d.]", "", style_dict(style).get("font-size", "16")))
        x = float(re.sub(r"[^\d.\-]", "", attributes.get("x", "0")))
        y = float(re.sub(r"[^\d.\-]", "", attributes.get("y", "0")))

        commands, missing = outline(font, text, x, y, size)
        if missing:
            problems.append("no glyph for %r" % "".join(missing))
            return match.group(0)

        kept = ["d=\"%s\"" % commands]
        paint = paint_style(style)
        if paint:
            kept.append("style=\"%s\"" % paint)
        for name in ("id", "serif:id", "opacity", "clip-path", "mask"):
            if attributes.get(name):
                kept.append('%s="%s"' % (name, attributes[name]))

        hits[0] += 1
        print("%s: %r at %g px -> path of %d bytes"
              % (os.path.basename(path), text, size, len(commands)))
        return "<path " + " ".join(kept) + "/>"

    result = TEXT_ELEMENT.sub(replace, source)
    if problems:
        sys.exit("%s: %s" % (path, "; ".join(problems)))

    if not hits[0]:
        if re.search(family_pattern, source, re.I):
            sys.exit("%s: text is set in %s but is not a plain <text> element. "
                     "Convert it to curves in Affinity instead." % (path, family_pattern))
        print("%s: nothing set in %s" % (os.path.basename(path), family_pattern))
        return False

    if dry_run:
        print("  (dry run, nothing written)")
        return True

    io.open(path, "w", encoding="utf-8", newline="").write(result)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg", nargs="+", help="template(s) to convert in place")
    parser.add_argument("--font", required=True, help="the TTF to take outlines from")
    parser.add_argument("--family", default="FrenchScript",
                        help="font-family pattern to look for (default: FrenchScript)")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args()

    font = TTFont(args.font)
    print("outlines from %s (%s)" % (os.path.basename(args.font), font["name"].getDebugName(4)))
    touched = 0
    for path in args.svg:
        if convert(path, font, args.family, args.dry_run):
            touched += 1
    print("%d file(s) changed." % (0 if args.dry_run else touched))


if __name__ == "__main__":
    main()
