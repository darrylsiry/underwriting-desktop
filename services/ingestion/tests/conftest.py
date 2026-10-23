import os
from pathlib import Path

import pytest

# Repo checkout: services/ingestion/tests -> samples/. In a container, set SAMPLES_DIR.
SAMPLES = Path(os.environ["SAMPLES_DIR"]) if "SAMPLES_DIR" in os.environ else Path(__file__).resolve().parents[3] / "samples"


@pytest.fixture(autouse=True)
def no_claude(monkeypatch):
    """Tests never call the API; Claude parsing is tested with canned replies."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("UW_ANTHROPIC_API_KEY", raising=False)


def case_files(case: str) -> list[tuple[str, bytes]]:
    folder = next((SAMPLES / "submissions").glob(f"{case}*"))
    return [(p.name, p.read_bytes()) for p in sorted(folder.iterdir()) if not p.name.startswith(".")]
