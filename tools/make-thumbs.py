#!/usr/bin/env python3
"""Renders templates/thumbs/<id>.jpg for the template picker.

The thumbnails are committed, so the picker never has to download nine
multi-megabyte SVGs just to draw a grid. Re-run this after adding or changing
a template:

    pip install pillow
    python tools/make-thumbs.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THUMBS = os.path.join(ROOT, "templates", "thumbs")
PORT = 8766
WIDTH = 480

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def find_chrome():
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    sys.exit("Chrome not found. Set CHROME=<path to chrome>.")


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = lambda *a, **kw: Quiet(*a, directory=ROOT, **kw)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for _ in range(50):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/index.html" % PORT, timeout=1)
            return server
        except Exception:
            time.sleep(0.1)
    sys.exit("local server did not come up")


def main():
    manifest = json.load(open(os.path.join(ROOT, "templates", "manifest.json"), encoding="utf-8"))
    os.makedirs(THUMBS, exist_ok=True)
    chrome = find_chrome()
    server = serve()
    scratch = tempfile.mkdtemp(prefix="fracify-thumbs-")

    try:
        for entry in manifest["templates"]:
            head = open(os.path.join(ROOT, "templates", entry["file"]), encoding="utf-8").read(4000)
            box = head.split('viewBox="')[1].split('"')[0].split()
            width, height = int(float(box[2])), int(float(box[3]))
            shot = os.path.join(scratch, entry["id"] + ".png")

            subprocess.run([
                chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                "--force-device-scale-factor=1", "--run-all-compositor-stages-before-draw",
                "--virtual-time-budget=40000", "--screenshot=" + shot,
                "--window-size=%d,%d" % (width, height),
                "http://127.0.0.1:%d/tools/fidelity-test.html?template=%s&mode=reference" % (PORT, entry["id"]),
            ], check=True, capture_output=True)

            image = Image.open(shot).convert("RGB")
            thumb = image.resize((WIDTH, max(1, round(WIDTH * height / width))), Image.LANCZOS)
            out = os.path.join(THUMBS, entry["id"] + ".jpg")
            thumb.save(out, quality=82, optimize=True)
            print("%-8s %4d x %4d  %5d B" % (entry["id"], thumb.width, thumb.height, os.path.getsize(out)))
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
