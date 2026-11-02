import asyncio
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
# Each stream holds a thread and its uploads in memory for as long as Claude takes; beyond this, callers get a 503.
_stream_slots = threading.BoundedSemaphore(int(os.environ.get("MAX_CONCURRENT_EXTRACTIONS", "8")))

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


# Last class list the rating service returned. Class codes change only when a rate version is
# activated, so a recent copy is a much better fallback than no list at all.
_last_classes: list[dict] = []


def rateable_classes(attempts: int = 2, timeout: float = 10) -> list[dict]:
    """Class codes from the rating service, so Claude only picks codes we can rate.

    On Fly the rating machine auto-stops when idle and takes a few seconds to start on the first
    request, so wait long enough for a cold start and retry once before falling back.
    """
    global _last_classes
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(f"{RATING_SERVICE_URL}/classes", timeout=timeout) as r:
                classes = json.load(r)
            if classes:
                _last_classes = classes
                return classes
        except (OSError, ValueError):
            pass
    return _last_classes


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


class _CancelOnClose(StreamingResponse):
    """Whatever ends the response, the client going away included, tells the worker to stop."""

    def __init__(self, *args, cancel: threading.Event, **kwargs):
        super().__init__(*args, **kwargs)
        self.cancel = cancel

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.cancel.set()


@app.post("/extract/stream")
async def extract_stream(files: list[UploadFile] = File(..., description="Every document in one submission"),
                         use_claude: bool = True):
    """Same as /extract, but streams newline-delimited JSON events while it works: `step`, `field`,
    `loss`, `thinking` (Claude's reasoning summary), `warning`, then one `result` (the /extract body)
    or `error`. Every event carries `t`, seconds since the request started."""
    uploads = await read_uploads(files)
    if not _stream_slots.acquire(blocking=False):
        raise HTTPException(503, "Too many extractions are running; try again in a minute", headers={"Retry-After": "60"})
    events: queue.Queue = queue.Queue()
    cancel = threading.Event()
    started = time.monotonic()

    def emit(event: dict) -> None:
        events.put({**event, "t": round(time.monotonic() - started, 2)})

    def work() -> None:
        try:
            classes = rateable_classes()
            emit({"type": "step", "stage": "classes",
                  "message": f"Loaded {len(classes)} rateable class codes from the rating service" if classes
                  else "Rating service class list unavailable"})
            emit({"type": "result", "result": pipeline.run(uploads, classes, use_claude=use_claude, emit=emit, cancel=cancel)})
        except Exception as e:  # the stream has already started, so report errors in-band
            emit({"type": "error", "message": f"Extraction failed: {e}"})
        finally:
            _stream_slots.release()
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    async def lines():
        while True:
            try:
                event = events.get_nowait()
            except queue.Empty:
                # Not a blocking get() in a thread: a disconnect couldn't cancel that until the next event arrived.
                await asyncio.sleep(0.05)
                continue
            if event is None:
                return
            yield json.dumps(event, default=str) + "\n"

    return _CancelOnClose(lines(), cancel=cancel, media_type="application/x-ndjson",
                          headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
