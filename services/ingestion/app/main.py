import json
import os
import urllib.request

from fastapi import FastAPI, File, HTTPException, UploadFile

from app import claude, pipeline

RATING_SERVICE_URL = os.environ.get("RATING_SERVICE_URL", "http://localhost:8001")

app = FastAPI(
    title="Ingestion Service",
    description="Classify broker submission documents and extract a submission JSON with per-field confidence",
)


@app.get("/health")
def health():
    return {
        "service": "ingestion",
        "status": "ok",
        "claude_extraction": "enabled" if claude.enabled() else "disabled",
        "model": claude.MODEL,
    }


def rateable_classes() -> list[dict]:
    """Class codes from the rating service, so Claude only picks codes we can rate."""
    try:
        with urllib.request.urlopen(f"{RATING_SERVICE_URL}/classes", timeout=3) as r:
            return json.load(r)
    except (OSError, ValueError):
        return []


@app.post("/extract")
async def extract(files: list[UploadFile] = File(..., description="Every document in one submission"),
                  use_claude: bool = True):
    """Upload one submission's documents (PDF, EML, DOCX, TXT) and get back the canonical submission JSON.

    Fillable ACORD-style PDFs are read from their form fields; everything else goes to Claude.
    """
    uploads = [(f.filename or "upload", await f.read()) for f in files]
    if not any(data for _, data in uploads):
        raise HTTPException(422, "No file content uploaded")
    return pipeline.run(uploads, rateable_classes(), use_claude=use_claude)
