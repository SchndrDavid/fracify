FROM python:3.12-slim

WORKDIR /app

# Dependencies before sources, so editing the page does not invalidate the
# pip layer and force a reinstall on every rebuild.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY index.html app.js styles.css ./static/
COPY fonts ./static/fonts
COPY templates ./static/templates

EXPOSE 8000

# Shell form so ${PORT} expands; exec so uvicorn stays PID 1 and gets the
# SIGTERM from `docker stop` instead of being killed ten seconds later.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
