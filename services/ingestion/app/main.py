from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import claude_extract
from .pipeline import ingest
from .schema import FIELDS

app = FastAPI(title="Ingestion Service")
STATIC = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@app.get("/health")
def health():
    return {
        "service": "ingestion",
        "status": "ok",
        "claude_extraction": "enabled" if claude_extract.api_key() else "disabled",
        "model": claude_extract.MODEL,
    }


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/schema")
def schema():
    """Canonical submission field paths and their types."""
    return FIELDS


@app.post("/ingest")
def ingest_files(files: list[UploadFile] = File(...)):
    """Upload one submission's documents; returns the extracted submission JSON
    with per-field confidence, source snippet, and method."""
    payload = []
    for f in files:
        data = f.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"{f.filename} is larger than 20 MB")
        payload.append((f.filename or "upload", data))
    try:
        return ingest(payload)
    except Exception as e:
        raise HTTPException(422, f"Could not read the upload: {e}")
