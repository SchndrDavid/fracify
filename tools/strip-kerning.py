#!/usr/bin/env python3
"""Removes the per-glyph positions Affinity bakes into a template's text.

Affinity does not trust the renderer to kern, so it exports a heading as

    SB Co<tspan x="-127.342px -63.905px">wo</tspan>rk 1. patr<tspan x="302.516px">o</tspan>

where each tspan pins glyphs to absolute positions worked out against the exact
cut of the font the designer had installed. Any other build of Metropolis lays
the run out a hair narrower, the pinned glyph stays where it was told, and a
gap opens in the middle of the word - "patr o" instead of "patro".

The app already rebuilds a line without tspans the moment it is edited. This
does the same to the template, so the placeholder text is right before anyone
touches it, and a slot the user leaves alone matches what they see everywhere
else.

    python tools/strip-kerning.py templates/post.svg templates/story.svg
    python tools/strip-kerning.py templates/post.svg --dry-run
"""

import argparse
import io
import os
import re
import sys

TEXT = re.compile(r"<text\b([^>]*)>(.*?)</text>", re.S)
TSPAN = re.compile(r"</?tspan\b[^>]*>")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("svg", nargs="+")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for path in args.svg:
        source = io.open(path, encoding="utf-8", newline="").read()
        touched = []

        def replace(match):
            inner = match.group(2)
            if "<tspan" not in inner:
                # Still worth trimming: xml:space is preserve, so a stray
                # newline before </text> renders as a trailing space and shifts
                # every centred line half a space to the left.
                trimmed = inner.strip()
                if trimmed == inner:
                    return match.group(0)
                touched.append((inner.strip(), "trailing space"))
                return "<text%s>%s</text>" % (match.group(1), trimmed)
            flattened = TSPAN.sub("", inner).strip()
            touched.append((flattened, "%d tspan(s)" % len(re.findall(r"<tspan\b", inner))))
            return "<text%s>%s</text>" % (match.group(1), flattened)

        updated = TEXT.sub(replace, source)
        print("%s: %d text element(s) rebuilt" % (os.path.basename(path), len(touched)))
        for text, why in touched:
            print("   %-40s (%s)" % (text[:40], why))
        if touched and not args.dry_run:
            io.open(path, "w", encoding="utf-8", newline="").write(updated)
    if args.dry_run:
        print("(dry run, nothing written)")


if __name__ == "__main__":
    sys.exit(main())
