"""Ingestion tests. No API key needed: Claude is replaced by a fake client.
The sample submissions are read from the repo's samples/ folder."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import claude_extract
from app.documents import load
from app.main import app
from app.pipeline import ingest
from app.schema import coerce

SAMPLES = Path(__file__).resolve().parents[3] / "samples"


def case_files(case: str) -> list[tuple[str, bytes]]:
    return [(p.name, p.read_bytes()) for p in sorted((SAMPLES / "submissions" / case).iterdir())]


def truth(case: str) -> dict:
    return json.loads((SAMPLES / "ground_truth" / f"{case}.json").read_text())


@pytest.fixture(autouse=True)
def no_api_key(monkeypatch):
    monkeypatch.delenv("UW_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


class FakeClaude:
    """Stands in for anthropic.Anthropic; returns a canned structured-output reply."""

    def __init__(self, reply: dict, stop_reason="end_turn"):
        self.calls = []
        create = lambda **kw: self.calls.append(kw) or SimpleNamespace(  # noqa: E731
            stop_reason=stop_reason, model="fake-claude",
            content=[SimpleNamespace(type="text", text=json.dumps(reply))],
            usage=SimpleNamespace(input_tokens=10, output_tokens=5))
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=create))


@pytest.mark.parametrize("filename,doc_types", [
    ("01-lone-star-electric", {"acord_application", "loss_run"}),
    ("03-peachtree-plumbing", {"application"}),
    ("04-cascade-carpentry", {"broker_email", "loss_run"}),
    ("06-empire-builders-gc", {"acord_application", "supplemental_questionnaire"}),
    ("07-sonoran-concrete", {"application"}),
])
def test_classify_samples(filename, doc_types):
    docs = [d for name, data in case_files(filename) for d in load(name, data)]
    assert {d.doc_type for d in docs} == doc_types
    assert all(d.reason for d in docs)


def test_email_attachment_becomes_its_own_document():
    [(name, data)] = case_files("04-cascade-carpentry")
    email_doc, attachment = load(name, data)
    assert attachment.parent == name and attachment.doc_type == "loss_run"
    assert "Cascade Finish Carpentry" in email_doc.text


def test_fillable_acord_extracts_deterministically_without_claude():
    acord = [f for f in case_files("01-lone-star-electric") if "acord" in f[0]]
    result = ingest(acord)
    want = truth("01-lone-star-electric")
    for section in ("applicant", "producer", "policy", "operations", "prior"):
        assert result["submission"][section] == want[section]
    assert result["submission"]["loss_history"] == want["loss_history"]
    assert all(f["method"] == "form_field" and f["confidence"] == 1.0 for f in result["fields"] if f["value"])
    assert result["claude"]["used"] is False and result["warnings"] == []
    assert result["missing_for_rating"] == []


def test_without_key_unstructured_docs_are_skipped_with_a_warning():
    result = ingest(case_files("05-desert-bloom-painting"))
    assert result["claude"]["used"] is False
    assert "No Anthropic API key" in result["warnings"][0]
    assert "operations.gross_receipts" in result["missing_for_rating"]


def test_claude_fields_merge_with_form_fields():
    fake = FakeClaude({
        "documents": [{"filename": "lone-star-electric-loss-run.pdf", "doc_type": "loss_run"}],
        "fields": [
            # disagrees with the form field: form wins, Claude's value kept as an alternative
            {"path": "operations.gross_receipts", "value": "$7.1M", "confidence": 0.8,
             "document": "lone-star-electric-loss-run.pdf", "source": "receipts ~7.1M"},
        ],
        "loss_history": [
            # same claim as the app's loss row: deduped
            {"date": "03/18/2024", "description": "Customer tripped over cable", "incurred": 8200,
             "status": "closed", "confidence": 0.97, "document": "lone-star-electric-loss-run.pdf",
             "source": "CL7874401"},
            {"date": "2025-06-02", "description": "Ladder fell on parked car", "incurred": 3100,
             "status": "open", "confidence": 0.95, "document": "lone-star-electric-loss-run.pdf",
             "source": "CL7874999"},
        ],
    })
    result = ingest(case_files("01-lone-star-electric"), client=fake)

    [call] = fake.calls
    assert [b["title"] for b in call["messages"][0]["content"] if b["type"] == "document"] == \
        ["lone-star-electric-loss-run.pdf"]  # only the unstructured doc goes to Claude
    assert call["output_config"]["format"]["type"] == "json_schema"

    receipts = next(f for f in result["fields"] if f["path"] == "operations.gross_receipts")
    assert receipts["value"] == 6_800_000 and receipts["method"] == "form_field"
    assert receipts["alternatives"][0]["value"] == 7_100_000
    assert result["conflicts"] == ["operations.gross_receipts"]
    assert [(l["date"], l["status"]) for l in result["submission"]["loss_history"]] == \
        [("2024-03-18", "Closed"), ("2025-06-02", "Open")]
    assert result["claude"] == {"used": True, "model": "fake-claude",
                                "usage": {"input_tokens": 10, "output_tokens": 5}}


def test_claude_inferences_are_low_confidence_and_expiration_is_inferred():
    fake = FakeClaude({"documents": [], "loss_history": [], "fields": [
        {"path": "policy.effective_date", "value": "11/01/2026", "confidence": 0.95,
         "document": "e.eml", "source": "effective 11/01/2026"},
        {"path": "operations.class_code", "value": "98304", "confidence": 0.75,
         "document": "e.eml", "source": "Inferred: painting"},
    ]})
    result = ingest(case_files("05-desert-bloom-painting"), client=fake)
    assert result["submission"]["policy"]["expiration_date"] == "2027-11-01"
    assert set(result["low_confidence"]) == {"operations.class_code", "policy.expiration_date"}


def test_refusal_keeps_deterministic_results():
    fake = FakeClaude({}, stop_reason="refusal")
    result = ingest(case_files("01-lone-star-electric"), client=fake)
    assert "declined" in result["warnings"][0]
    assert result["submission"]["applicant"]["name"] == "Lone Star Electrical Services LLC"


@pytest.mark.parametrize("path,raw,want", [
    ("policy.occurrence_limit", "$1M", 1_000_000),
    ("operations.gross_receipts", "18.5 million", 18_500_000),
    ("operations.gross_receipts", "$650,000", 650_000),
    ("operations.employees", "12 months", 12),
    ("operations.subcontracted_pct", "45%", 45),
    ("operations.states", "FL, GA and TX", ["FL", "GA", "TX"]),
    ("operations.wrap_up_projects", "N", False),
    ("policy.effective_date", "12/15/2026", "2026-12-15"),
    ("applicant.state", "Arizona", ""),
    ("prior.premium", "n/a", None),
])
def test_coerce(path, raw, want):
    assert coerce(path, raw) == want


def test_api_ingest_and_health():
    client = TestClient(app)
    assert client.get("/health").json()["claude_extraction"] == "disabled"
    name, data = next(f for f in case_files("08-front-range-hvac") if "acord" in f[0])
    r = client.post("/ingest", files=[("files", (name, data, "application/pdf"))])
    assert r.status_code == 200
    assert r.json()["submission"]["operations"]["class_code"] == "97050"


def test_api_key_falls_back_to_standard_name(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "standard")
    assert claude_extract.api_key() == "standard"
    monkeypatch.setenv("UW_ANTHROPIC_API_KEY", "sandbox")
    assert claude_extract.api_key() == "sandbox"
