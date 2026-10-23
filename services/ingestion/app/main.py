import os

from fastapi import FastAPI

app = FastAPI(title="Ingestion Service")


@app.get("/health")
def health():
    return {
        "service": "ingestion",
        "status": "ok",
        "claude_extraction": "enabled" if os.environ.get("ANTHROPIC_API_KEY") else "disabled",
    }
