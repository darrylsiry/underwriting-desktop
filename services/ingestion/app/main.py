import json
import os
import queue
import threading
import time
import urllib.request

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app import claude, pipeline

RATING_SERVICE_URL = os.environ.get("RATING_SERVICE_URL", "http://localhost:8001")
# One broker submission is a handful of documents; cap direct callers like the web tier does (25 MB).
MAX_FILES = int(os.environ.get("MAX_UPLOAD_FILES", "20"))
MAX_TOTAL_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024

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


async def read_uploads(files: list[UploadFile]) -> list[tuple[str, bytes]]:
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"At most {MAX_FILES} files per submission")
    uploads, total = [], 0
    for f in files:
        data = await f.read(MAX_TOTAL_BYTES - total + 1)  # never buffer more than the limit
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(413, f"Uploads exceed {MAX_TOTAL_BYTES // (1024 * 1024)} MB in total")
        uploads.append((f.filename or "upload", data))
    if not any(data for _, data in uploads):
        raise HTTPException(422, "No file content uploaded")
    return uploads


@app.post("/extract")
async def extract(files: list[UploadFile] = File(..., description="Every document in one submission"),
                  use_claude: bool = True):
    """Upload one submission's documents (PDF, EML, DOCX, TXT) and get back the canonical submission JSON.

    Fillable ACORD-style PDFs are read from their form fields; everything else goes to Claude.
    """
    uploads = await read_uploads(files)
    # Parsing and the Claude call are synchronous and can take minutes; run them in the threadpool
    # so /health and other requests keep being served meanwhile.
    classes = await run_in_threadpool(rateable_classes)
    return await run_in_threadpool(pipeline.run, uploads, classes, use_claude=use_claude)


@app.post("/extract/stream")
async def extract_stream(files: list[UploadFile] = File(..., description="Every document in one submission"),
                         use_claude: bool = True):
    """Same as /extract, but streams newline-delimited JSON events while it works: `step`, `field`,
    `loss`, `thinking` (Claude's reasoning summary), `warning`, then one `result` (the /extract body)
    or `error`. Every event carries `t`, seconds since the request started."""
    uploads = await read_uploads(files)
    events: queue.Queue = queue.Queue()
    started = time.monotonic()

    def emit(event: dict) -> None:
        events.put({**event, "t": round(time.monotonic() - started, 2)})

    def work() -> None:
        try:
            classes = rateable_classes()
            emit({"type": "step", "stage": "classes",
                  "message": f"Loaded {len(classes)} rateable class codes from the rating service" if classes
                  else "Rating service class list unavailable"})
            emit({"type": "result", "result": pipeline.run(uploads, classes, use_claude=use_claude, emit=emit)})
        except Exception as e:  # the stream has already started, so report errors in-band
            emit({"type": "error", "message": f"Extraction failed: {e}"})
        finally:
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def lines():  # Starlette iterates a sync generator in its threadpool, so blocking get() is fine
        while (event := events.get()) is not None:
            yield json.dumps(event, default=str) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
