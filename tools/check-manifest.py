#!/usr/bin/env python3
"""Checks templates/manifest.json against the SVGs, and lists what is in them.

    python tools/check-manifest.py            # validate every template
    python tools/check-manifest.py --list dis1  # dump one template's <text>
                                                # elements and <image> ids

The listing is what you need when adding a template that has no slot: layer
names: it prints the index of every <text> element in document order, which is
exactly what a slot's "texts" array refers to.

Needs nothing but the standard library.
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "templates")
SVG = "{http://www.w3.org/2000/svg}"
SERIF = "{http://www.serif.com/}"
XLINK = "{http://www.w3.org/1999/xlink}"
SLOT_PREFIX = "slot:"


def parse(path):
    root = ET.parse(path).getroot()
    texts = [e for e in root.iter() if e.tag == SVG + "text"]
    images = [e for e in root.iter() if e.tag == SVG + "image"]
    slot_names = []
    for element in root.iter():
        name = element.get(SERIF + "id") or element.get("id") or ""
        if name.startswith(SLOT_PREFIX):
            slot_names.append(name)
    return root, texts, images, slot_names


def text_of(element):
    return "".join(element.itertext())


def show(template_id, entry):
    path = os.path.join(TEMPLATES, entry["file"])
    root, texts, images, slot_names = parse(path)
    print("%s  %s  viewBox=%s" % (template_id, entry["file"], root.get("viewBox")))
    if slot_names:
        print("  slot: layer names (the manifest is ignored for this file):")
        for name in slot_names:
            print("    %s" % name)
    print("  <text> elements, in document order:")
    for i, element in enumerate(texts):
        style = element.get("style", "")
        size = re.search(r"font-size:([\d.]+)", style)
        family = re.search(r"font-family:'([^']+)'", style)
        print("    [%2d] y=%-10s %-20s %-7s %r" % (
            i, element.get("y"), (family.group(1) if family else "?"),
            (size.group(1) if size else "?"), text_of(element)))
    print("  <image> elements:")
    for element in images:
        print("    %-10s %s x %s" % (element.get("id"), element.get("width"), element.get("height")))


def check_placement(root, images, wanted, where, problems):
    """A photo slot has to be the box it is drawn in.

    The app crops an upload to the <image>'s own width and height and writes
    the result straight into it. An Affinity export that parks the bitmap in
    <defs> and draws it through a scaled <use> still looks right, but those
    dimensions are then the source file's pixels rather than the frame on the
    artboard: the crop is cut to the wrong shape, only a window of it lands in
    the frame, and the framing sliders push the photo somewhere the eye cannot
    follow. Placing the <image> itself, sized to the box it fills, is what the
    app reads.
    """
    if not wanted:
        return
    parent = {child: node for node in root.iter() for child in node}
    referenced = set()
    for element in root.iter():
        if element.tag == SVG + "use":
            href = element.get(XLINK + "href") or element.get("href") or ""
            referenced.add(href.lstrip("#"))
    for element in images:
        image_id = element.get("id")
        if image_id not in wanted:
            continue
        node = parent.get(element)
        in_defs = False
        while node is not None:
            if node.tag == SVG + "defs":
                in_defs = True
                break
            node = parent.get(node)
        if in_defs or image_id in referenced:
            problems.append('%s: the photo slot <image id="%s"> is %s - place it on the '
                            "artboard, sized to the frame it fills, or the crop is cut to "
                            "the source file's shape instead of the frame's"
                            % (where, image_id,
                               "defined in <defs> and drawn through <use>" if in_defs
                               else "drawn through <use>"))


def check(entry, problems):
    where = entry.get("id", "?")
    path = os.path.join(TEMPLATES, entry.get("file", ""))
    if not os.path.exists(path):
        problems.append("%s: %s does not exist" % (where, entry.get("file")))
        return
    root, texts, images, slot_names = parse(path)
    if slot_names:
        # The file names its own slots, so the manifest mapping is unused - but
        # a named image layer has to be placed like any other photo slot.
        named = set(e.get("id") for e in images
                    if (e.get(SERIF + "id") or e.get("id") or "").startswith(SLOT_PREFIX))
        check_placement(root, images, named, where, problems)
        return

    slots = entry.get("slots") or []
    if not slots:
        problems.append("%s: no slots in the manifest and no slot: layer names in the file "
                        "- the app will show it as unsupported" % where)
        return

    image_ids = set(e.get("id") for e in images)
    check_placement(root, images,
                    set(d["image"] for d in slots if d.get("image")) & image_ids,
                    where, problems)
    used = {}
    for slot in slots:
        slot_id = slot.get("id")
        if not slot_id:
            problems.append("%s: a slot has no id" % where)
            continue
        if "image" in slot:
            if slot["image"] not in image_ids:
                problems.append("%s.%s: no <image id=\"%s\"> in the file" % (where, slot_id, slot["image"]))
            continue
        indices = slot.get("texts")
        if not indices:
            problems.append("%s.%s: neither texts nor image" % (where, slot_id))
            continue
        for index in indices:
            if index >= len(texts):
                problems.append("%s.%s: <text> %d, but the file has %d" % (where, slot_id, index, len(texts)))
            elif index in used:
                problems.append("%s.%s: <text> %d is already used by %s" % (where, slot_id, index, used[index]))
            else:
                used[index] = slot_id
    unused = [i for i in range(len(texts)) if i not in used]
    if unused:
        print("note  %-8s <text> %s not mapped to any slot (fine if they are fixed labels)"
              % (where, ", ".join(str(i) for i in unused)))


def main():
    manifest = json.load(open(os.path.join(TEMPLATES, "manifest.json"), encoding="utf-8"))
    entries = manifest["templates"]

    if "--list" in sys.argv:
        wanted = sys.argv[sys.argv.index("--list") + 1:]
        for entry in entries:
            if not wanted or entry["id"] in wanted:
                show(entry["id"], entry)
                print()
        return 0

    problems = []
    for entry in entries:
        check(entry, problems)
    for problem in problems:
        print("FAIL  " + problem)
    print("%d template(s) checked, %d problem(s)." % (len(entries), len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
