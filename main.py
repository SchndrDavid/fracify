"""Serves the Fracify page.

There is no application logic here on purpose: everything the tool does -
parsing templates, laying out text, cropping photos, rasterising the export -
happens in the browser. This process only hands out static files, so the
container is disposable and nothing is written to disk.
"""

import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

app = FastAPI(title="fracify", docs_url=None, redoc_url=None)


@app.get("/api/health")
def health():
    """Liveness probe, also used by the container healthcheck."""
    return {"status": "ok", "service": "fracify"}


# Registered last: routes match in registration order, so mounting "/" earlier
# would swallow /api/health and answer it with a 404 from the static handler.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
