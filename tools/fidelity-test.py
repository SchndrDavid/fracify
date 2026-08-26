#!/usr/bin/env python3
"""The acceptance test: an untouched export must be the template.

For every template, headless Chrome runs the app's own pipeline twice and posts
the resulting PNG back to this script, which diffs the two:

    baseline    the untouched template, fonts inlined, rasterised through
                <img> and canvas
    export      the same template with every slot torn out and rebuilt by the
                app, then rasterised the same way

Anything that breaks the slot machinery, the serialisation, the font baking or
the root size shows up as a difference.

    pip install pillow
    python tools/fidelity-test.py             # all templates
    python tools/fidelity-test.py post story  # just these
    python tools/fidelity-test.py --stress    # also render the long-text pass

Output lands in .fidelity/ so it can be looked at afterwards.
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

from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".fidelity")
PORT = 8765
TIMEOUT = 120

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

# Both sides go through the same rasteriser, so an untouched export has to come
# back identical. Not "close enough" - identical.
TOLERANCE = 0
MAX_DIFFERING = 0


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        name = self.path.split("name=", 1)[1] if "name=" in self.path else "unnamed"
        name = "".join(c for c in name if c.isalnum() or c in "-_")
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(os.path.join(OUT, name + ".png"), "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def find_chrome():
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    sys.exit("Chrome not found. Set CHROME=<path to chrome>.")


def serve():
    handler = lambda *a, **kw: Handler(*a, directory=ROOT, **kw)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for _ in range(50):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/index.html" % PORT, timeout=1)
            return server
        except Exception:
            time.sleep(0.1)
    sys.exit("local server did not come up")


def run(chrome, template, mode, extra=()):
    """Loads a page and waits for the PNG it posts back."""
    target = os.path.join(OUT, "%s-%s.png" % (template, mode))
    if os.path.exists(target):
        os.remove(target)
    url = "http://127.0.0.1:%d/tools/fidelity-test.html?template=%s&mode=%s" % (PORT, template, mode)
    profile = tempfile.mkdtemp(prefix="fracify-chrome-")
    process = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
         "--user-data-dir=" + profile] + list(extra) + [url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            if os.path.exists(target) and os.path.getsize(target) > 0:
                time.sleep(0.2)  # let the write settle
                return target
            if process.poll() is not None and time.time() > deadline - TIMEOUT + 5:
                break
            time.sleep(0.2)
        raise RuntimeError("%s/%s produced nothing in %d s" % (template, mode, TIMEOUT))
    finally:
        process.terminate()


def compare(a_path, b_path, diff_path):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return {"note": "size %s vs %s" % (a.size, b.size), "ok": False}
    grey = ImageChops.difference(a, b).convert("L")
    histogram = grey.histogram()
    differing = sum(histogram[TOLERANCE + 1:])
    worst = max(i for i, count in enumerate(histogram) if count)
    if differing:
        grey.point(lambda v: min(255, v * 8)).save(diff_path)
    elif os.path.exists(diff_path):
        os.remove(diff_path)
    return {
        "ok": differing <= MAX_DIFFERING,
        "differing": differing,
        "total": a.size[0] * a.size[1],
        "worst": worst,
        "size": a.size,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    stress = "--stress" in sys.argv

    manifest = json.load(open(os.path.join(ROOT, "templates", "manifest.json"), encoding="utf-8"))
    entries = manifest["templates"]
    if args:
        entries = [e for e in entries if e["id"] in args]
        if not entries:
            sys.exit("no such template: " + ", ".join(args))

    os.makedirs(OUT, exist_ok=True)
    chrome = find_chrome()
    server = serve()
    failures = 0

    try:
        for entry in entries:
            started = time.time()
            baseline = run(chrome, entry["id"], "baseline")
            export = run(chrome, entry["id"], "export")
            result = compare(baseline, export, os.path.join(OUT, entry["id"] + "-diff.png"))

            if result.get("note"):
                print("FAIL %-8s %s" % (entry["id"], result["note"]))
                failures += 1
            else:
                print("%s %-8s %d x %d, %d px differ (worst delta %d), %.1f s" % (
                    "ok  " if result["ok"] else "FAIL", entry["id"],
                    result["size"][0], result["size"][1],
                    result["differing"], result["worst"], time.time() - started))
                if not result["ok"]:
                    failures += 1

            if stress:
                run(chrome, entry["id"], "stress")
    finally:
        server.shutdown()

    print()
    print("%d template(s), %d failed. Output in %s" % (len(entries), failures, os.path.relpath(OUT, ROOT)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
