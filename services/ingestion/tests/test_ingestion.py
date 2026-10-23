import json

import pytest
from fastapi.testclient import TestClient

from app import claude, pipeline
from app.documents import load
from app.main import app
from app.schema import FieldValue, NormalizeError, normalize
from tests.conftest import SAMPLES, case_files


@pytest.mark.parametrize("case, expected", [
    ("01", {"acord_application", "loss_run"}),
    ("03", {"acord_application_flattened"}),
    ("04", {"broker_email", "loss_run"}),        # loss run is an email attachment
    ("05", {"broker_email"}),
    ("06", {"acord_application", "supplemental_questionnaire"}),
    ("07", {"application"}),
])
def test_classifies_every_format(case, expected):
    docs = [d for name, data in case_files(case) for d in load(name, data)]
    assert {d.doc_type for d in docs} == expected


def test_email_attachment_records_parent():
    [(name, data)] = case_files("04")
    body, attachment = load(name, data)
    assert "From: Sam Okafor" in body.text and attachment.parent == name


@pytest.mark.parametrize("path, raw, value", [
    ("operations.gross_receipts", "$6,800,000", 6800000),
    ("operations.gross_receipts", "$2.3M", 2300000),
    ("operations.subcontracted_pct", "10%", 10),
    ("operations.max_height_ft", "30 ft", 30),
    ("operations.subcontractor_coi_required", "Y", True),
    ("operations.states", "FL, GA", ["FL", "GA"]),
    ("operations.states", "AZ and NV", ["AZ", "NV"]),
    ("policy.effective_date", "12/01/2026", "2026-12-01"),
    ("applicant.state", "tx", "TX"),
    ("applicant.dba", "  ", None),
])
def test_normalize(path, raw, value):
    assert normalize(path, raw) == value


def test_normalize_rejects_garbage():
    with pytest.raises(NormalizeError):
        normalize("policy.deductible", "see attached")


@pytest.mark.parametrize("case", ["01", "02", "08"])
def test_fillable_acord_matches_ground_truth_without_claude(case):
    """Fillable cases are fully read from form fields; only the loss run needs Claude."""
    result = pipeline.run(case_files(case), classes=[])
    truth = json.loads(next((SAMPLES / "ground_truth").glob(f"{case}*")).read_text())
    for section in ("applicant", "producer", "policy", "operations"):
        assert result["submission"][section] == truth[section], section
    assert all(f["method"] == "form_field" and f["confidence"] == 1.0 for f in result["fields"].values())
    assert result["missing_for_rating"] == []
    assert any("not read" in w and "loss-run" in w for w in result["warnings"])


def test_without_claude_unreadable_docs_are_reported():
    result = pipeline.run(case_files("05"), classes=[])
    assert result["fields"] == {} and "operations.class_code" in result["missing_for_rating"]
    assert result["warnings"] == ["Claude extraction disabled (no ANTHROPIC_API_KEY); not read: "
                                  "desert-bloom-painting-submission-email.eml"]


def test_merge_prefers_form_fields_then_stated_then_confidence():
    fv = lambda value, method, basis, conf: FieldValue("operations.employees", value, conf, method, basis, "x.pdf")  # noqa: E731
    chosen, conflicts = pipeline.merge([fv(12, "claude", "stated", 0.95), fv(14, "form_field", "stated", 1.0)])
    assert chosen["operations.employees"].value == 14 and conflicts[0]["others"][0]["value"] == 12
    chosen, _ = pipeline.merge([fv(12, "claude", "inferred", 0.9), fv(11, "claude", "stated", 0.7)])
    assert chosen["operations.employees"].value == 11


def test_parse_claude_reply_normalizes_and_drops_bad_values():
    reply = {
        "fields": [
            {"path": "operations.gross_receipts", "value": "$650,000", "basis": "stated", "confidence": 0.95,
             "source_document": "a.eml", "snippet": "roughly $650,000 in sales"},
            {"path": "operations.class_code", "value": "98304", "basis": "inferred", "confidence": 0.8,
             "source_document": "a.eml", "snippet": "residential painting"},
            {"path": "policy.deductible", "value": "unknown", "basis": "stated", "confidence": 0.4,
             "source_document": "a.eml", "snippet": ""},
        ],
        "loss_history": [{"date": "03/18/2024", "description": "Trip", "incurred": 8200, "status": "Closed",
                          "source_document": "a.eml"}],
        "notes": ["No prior coverage"],
    }
    usage = type("U", (), {"input_tokens": 10, "output_tokens": 5})()
    result = claude._parse(reply, "claude-opus-5-5", usage)
    assert {f.path: f.value for f in result.fields} == {"operations.gross_receipts": 650000, "operations.class_code": "98304"}
    assert result.losses[0].date == "2024-03-18" and len(result.warnings) == 1


def test_loss_from_application_and_loss_run_counted_once():
    docs = [d for name, data in case_files("01") for d in load(name, data)]
    from app.schema import Loss
    losses = [Loss("2024-03-18", "Trip (app)", 8200, "Closed", docs[0].filename),
              Loss("2024-03-18", "Trip (loss run)", 8200, "Closed", docs[1].filename)]
    [kept] = pipeline.dedupe_losses(losses, docs)
    assert kept.description == "Trip (loss run)"


def test_same_day_same_amount_claims_on_one_loss_run_both_survive():
    """CR-012: two claimants from one incident are two claims, not a duplicate."""
    docs = [d for name, data in case_files("01") for d in load(name, data)]
    from app.schema import Loss
    loss_run = docs[1].filename
    losses = [Loss("2024-05-02", "Claimant A", 5000, "Closed", loss_run),
              Loss("2024-05-02", "Claimant B", 5000, "Closed", loss_run),
              Loss("2024-05-02", "Same incident (app)", 5000, "Closed", docs[0].filename)]
    kept = pipeline.dedupe_losses(losses, docs)
    assert sorted(l.description for l in kept) == ["Claimant A", "Claimant B"]


def test_extract_endpoint():
    client = TestClient(app)
    files = [("files", (name, data)) for name, data in case_files("01")]
    res = client.post("/extract?use_claude=false", files=files)
    assert res.status_code == 200
    body = res.json()
    assert body["submission"]["operations"]["class_code"] == "92215"
    assert body["fields"]["operations.gross_receipts"]["snippet"] == "GeneralLiability_Hazard_Exposure_A = $6,800,000"
    assert [d["doc_type"] for d in body["documents"]] == ["acord_application", "loss_run"]
    assert client.post("/extract", files=[("files", ("a.xlsx", b"x"))]).json()["warnings"][0].startswith("a.xlsx")


def test_missing_class_list_is_reported(monkeypatch):
    """CR-013: if the rating service's class list is unavailable, say so instead of silently dropping the guard."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(claude, "extract", lambda docs, classes, **_: claude.ClaudeResult([], [], [], "fake", {}))
    result = pipeline.run(case_files("05"), classes=[])
    assert any("class list unavailable" in w for w in result["warnings"])
