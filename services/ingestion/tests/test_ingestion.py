import asyncio
import json
import threading
import time
from contextlib import suppress
from email.message import EmailMessage
from types import SimpleNamespace

import httpx
import pytest
from fastapi.exceptions import ResponseValidationError
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from app import acord, claude, pipeline
from app.contract import contract
from app.documents import Document, load
from app.main import app
from app.responses import ExtractResponse
from app.schema import FieldValue, Loss, NormalizeError, normalize
from tests.conftest import SAMPLES, case_files, fillable_pdf


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
    ("operations.states", "AZ AND NV", ["AZ", "NV"]),  # CR-132
    ("policy.effective_date", "12/01/2026", "2026-12-01"),
    ("applicant.state", "tx", "TX"),
    ("applicant.dba", "  ", None),
])
def test_normalize(path, raw, value):
    assert normalize(path, raw) == value


def test_normalize_rejects_garbage():
    with pytest.raises(NormalizeError):
        normalize("policy.deductible", "see attached")
    with pytest.raises(NormalizeError):
        normalize("operations.states", "ZZZ")


@pytest.mark.parametrize("raw", ["inf", "-inf", "Infinity", "nan", "1e999", "-5", "$-1,000", "-2.5M"])
def test_normalize_rejects_non_finite_and_negative_numbers(raw):
    """CR-106: "inf" and "1e999" used to raise OverflowError, which no extraction path catches."""
    with pytest.raises(NormalizeError):
        normalize("operations.gross_receipts", raw)


def test_extract_survives_an_infinite_number_in_a_form_field():
    """CR-106: one such value warns; the submission's other fields still come through."""
    pdf = fillable_pdf("INSURANCE APPLICATION", {
        "NamedInsured_FullName_A": "Acme LLC", "GeneralLiability_Hazard_Exposure_A": "1e999",
        "LossHistory_OccurrenceDate_A": "01/02/2025", "LossHistory_TotalIncurredAmount_A": "inf",
    })
    res = TestClient(app).post("/extract", files=[("files", ("app.pdf", pdf))])
    assert res.status_code == 200
    body = res.json()
    assert body["submission"]["applicant"]["name"] == "Acme LLC"
    assert body["submission"]["operations"]["gross_receipts"] is None
    assert any("app.pdf" in w and "1e999" in w for w in body["warnings"])
    assert any("loss row A" in w and "inf" in w for w in body["warnings"])


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
    [kept], warnings = pipeline.dedupe_losses(losses, docs)
    assert kept.description == "Trip (loss run)" and warnings == []


def test_same_day_same_amount_claims_on_one_loss_run_both_survive():
    """CR-012: two claimants from one incident are two claims, not a duplicate."""
    docs = [d for name, data in case_files("01") for d in load(name, data)]
    from app.schema import Loss
    loss_run = docs[1].filename
    losses = [Loss("2024-05-02", "Claimant A", 5000, "Closed", loss_run),
              Loss("2024-05-02", "Claimant B", 5000, "Closed", loss_run),
              Loss("2024-05-02", "Same incident (app)", 5000, "Closed", docs[0].filename)]
    kept, warnings = pipeline.dedupe_losses(losses, docs)
    assert sorted(l.description for l in kept) == ["Claimant A", "Claimant B"] and warnings == []


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


def test_upload_limits(monkeypatch):
    """CR-016: direct callers can't post unbounded uploads."""
    import app.main as main
    client = TestClient(app)
    monkeypatch.setattr(main, "MAX_TOTAL_BYTES", 1000)
    assert client.post("/extract", files=[("files", ("big.txt", b"x" * 1001))]).status_code == 413
    monkeypatch.setattr(main, "MAX_FILES", 2)
    assert client.post("/extract", files=[("files", (f"{i}.txt", b"x")) for i in range(3)]).status_code == 413


def test_api_key_prefers_uw_name_and_falls_back_to_standard(monkeypatch):
    assert claude.api_key() is None and not claude.enabled()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "standard")
    assert claude.api_key() == "standard"
    monkeypatch.setenv("UW_ANTHROPIC_API_KEY", "sandbox")
    assert claude.api_key() == "sandbox" and claude.enabled()


def test_extract_stream_reports_progress_then_the_result():
    """The streaming endpoint narrates the run (for the demo's activity panel) and ends with the /extract body."""
    client = TestClient(app)
    files = [("files", (name, data)) for name, data in case_files("01")]
    with client.stream("POST", "/extract/stream", files=files) as res:
        assert res.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in res.iter_lines() if line]
    kinds = [e["type"] for e in events]
    assert kinds[-1] == "result" and "error" not in kinds
    stages = [e["stage"] for e in events if e["type"] == "step"]
    assert stages[:3] == ["classes", "receive", "classify"] and "form" in stages and stages[-1] == "merge"
    fields = [e for e in events if e["type"] == "field"]
    assert {"path": "applicant.name", "value": "Lone Star Electrical Services LLC", "method": "form_field"}.items() \
        <= next(f for f in fields if f["path"] == "applicant.name").items()
    assert all(e["t"] >= 0 for e in events)
    assert events[-1]["result"]["submission"]["applicant"]["name"] == "Lone Star Electrical Services LLC"


def test_live_field_parser_waits_for_complete_values():
    partial = '{"fields":[{"path":"applicant.name","value":"Lone \\"Star\\" LLC","basis":"stated","confidence":0'
    assert not claude._FIELD_RE.search(partial)  # "0" may still become "0.98"
    m = claude._FIELD_RE.search(partial + '.98,"source_document":"a.pdf"')
    assert (m[1], claude._unescape(m[2]), m[3], m[4]) == ("applicant.name", 'Lone "Star" LLC', "stated", "0.98")
    assert not claude._LOSS_RE.search('{"date":"2025-01-02","description":"x","incurred":12,"status":"Clo')


def test_class_list_survives_a_cold_start_and_falls_back_to_the_last_good_copy(monkeypatch):
    """The rating machine auto-stops on Fly; the first request can fail while it starts."""
    import io
    import app.main as main
    classes = [{"class_code": "92215", "description": "Electrical"}]
    calls = []

    def flaky(url, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise TimeoutError("machine still starting")
        return io.BytesIO(json.dumps(classes).encode())

    monkeypatch.setattr(main, "_last_classes", [])
    monkeypatch.setattr(main.urllib.request, "urlopen", flaky)
    assert main.rateable_classes() == classes and calls == [10, 10]

    def down(url, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(main.urllib.request, "urlopen", down)
    assert main.rateable_classes() == classes  # last good copy


@pytest.mark.parametrize("raw, expected", [
    ("Open", "Open"), ("O", "Open"), ("OPEN-LIT", "Open"), ("RE-OPENED", "Open"), ("Reopened", "Open"),
    ("Open - suit filed", "Open"), ("Pending", "Open"), ("Litigation", "Open"),
    ("Closed", "Closed"), ("C", "Closed"), ("Closed - paid", "Closed"), ("CWP", "Closed"), ("Settled", "Closed"), ("Denied", "Closed"),
    ("Closed - reopened", "Closed"),
    # Only whole words count (CR-077): these are kept as written, and the web tier then treats them as open.
    ("Claim open", "Claim open"), ("Claim Open - litigation", "Claim Open - litigation"), ("Contested", "Contested"), ("CIP", "CIP"),
    ("Subrogation", "Subrogation"), ("", ""), (None, ""),
])
def test_claim_status_is_normalized_for_the_referral_rules(raw, expected):
    """Carriers write claim status many ways; the web tier's rules test for Open/Closed (CR-030)."""
    from app.schema import Loss, normalize_status
    assert normalize_status(raw) == expected
    assert Loss("2025-01-01", "x", 1, raw, "lr.pdf").status == expected


def broker_email(*attachments) -> bytes:
    """A broker email with a text body and the given (filename, bytes) or EmailMessage attachments."""
    msg = EmailMessage()
    msg["From"], msg["Subject"] = "broker@example.com", "New submission"
    msg.set_content("Gross receipts are $650,000.")
    for item in attachments:
        if isinstance(item, EmailMessage):
            msg.add_attachment(item)
        else:
            msg.add_attachment(item[1], maintype="application", subtype="octet-stream", filename=item[0])
    return msg.as_bytes()


def test_forwarded_and_corrupt_attachments_cost_only_themselves():
    """CR-029: the body and the good attachment survive a forwarded part and a corrupt PDF, each named in a warning."""
    forwarded = EmailMessage()
    forwarded["Subject"] = "Fwd: older thread"
    forwarded.set_content("see below")
    good = fillable_pdf("LOSS RUN", {})
    eml = broker_email(("loss-run.pdf", good), forwarded, ("broken.pdf", b"%PDF-1.4 not really"))

    result = pipeline.run([("broker.eml", eml)], classes=[], use_claude=False)

    assert [(d["filename"], d["doc_type"]) for d in result["documents"]] == [
        ("broker.eml", "broker_email"), ("loss-run.pdf", "loss_run")]
    assert any(w.startswith("broker.eml: attachment message/rfc822 was not read") for w in result["warnings"])
    assert any(w.startswith("broker.eml: attachment broken.pdf could not be read") for w in result["warnings"])
    body = load("broker.eml", eml)[0]
    assert "$650,000" in body.text


def test_unsupported_email_attachment_is_named_in_a_warning():
    """CR-117: an Excel loss run on an email used to vanish silently; uploaded directly it always warned."""
    eml = broker_email(("losses.xlsx", b"PK\x03\x04"))
    result = pipeline.run([("broker.eml", eml)], classes=[], use_claude=False)
    assert "broker.eml: attachment losses.xlsx was not read (unsupported file type)" in result["warnings"]
    assert [d["doc_type"] for d in result["documents"]] == ["broker_email"]


def test_clean_email_has_no_attachment_warnings():
    [(name, data)] = case_files("04")
    result = pipeline.run([(name, data)], classes=[], use_claude=False)
    assert not any("attachment" in w for w in result["warnings"])


def fake_claude(monkeypatch, **reply):
    """Claude "on" with a canned reply (ClaudeResult fields); returns the list of documents each call received."""
    calls = []

    def extract(docs, classes, **_):
        calls.append([d.filename for d in docs])
        return claude.ClaudeResult(reply.get("fields", []), reply.get("losses", []), [], "fake", {})

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(claude, "extract", extract)
    return calls


@pytest.mark.parametrize("heading, doc_type", [
    ("LOSS RUN", "loss_run"),
    ("SUPPLEMENTAL QUESTIONNAIRE", "supplemental_questionnaire"),
    ("INSURANCE APPLICATION", "acord_application_flattened"),  # Policy_Number_A isn't a field acord.py maps
])
def test_fillable_pdf_without_application_fields_goes_to_claude(monkeypatch, heading, doc_type):
    """CR-126: one filled Policy_ field used to send a document to the form reader, which found nothing in it."""
    files = [("carrier.pdf", fillable_pdf(heading, {"Policy_Number_A": "GL-1"}))]

    off = pipeline.run(files, classes=[], use_claude=False)
    assert off["documents"][0]["doc_type"] == doc_type
    assert any("not read" in w and "carrier.pdf" in w for w in off["warnings"])

    calls = fake_claude(monkeypatch)
    pipeline.run(files, classes=[])
    assert calls == [["carrier.pdf"]]


def test_loss_run_with_mapped_field_names_is_still_read_by_claude(monkeypatch):
    calls = fake_claude(monkeypatch)
    pdf = fillable_pdf("LOSS RUN", {"NamedInsured_FullName_A": "Acme LLC", "LossHistory_OccurrenceDate_A": "01/02/2025"})
    result = pipeline.run([("lr.pdf", pdf)], classes=[])
    assert calls == [["lr.pdf"]] and result["documents"][0]["method"] == "claude"


def test_form_read_that_finds_nothing_is_named_in_a_warning():
    pdf = fillable_pdf("INSURANCE APPLICATION", {"GeneralLiability_Hazard_Exposure_A": "see attached"})
    result = pipeline.run([("app.pdf", pdf)], classes=[])
    assert result["documents"][0]["doc_type"] == "acord_application"
    assert "app.pdf: no usable values could be read from its form fields" in result["warnings"]


def test_document_method_says_who_actually_read_it(monkeypatch):
    """CR-042: `claude` only once Claude has read it; `not_read` when it was off or its call failed."""
    files = case_files("01")  # a fillable application plus a loss run only Claude can read
    methods = lambda res: [d["method"] for d in res["documents"]]  # noqa: E731

    assert methods(pipeline.run(files, classes=[], use_claude=False)) == ["form_field", "not_read"]
    assert methods(pipeline.run(files, classes=[])) == ["form_field", "not_read"]  # no API key

    fake_claude(monkeypatch)
    assert methods(pipeline.run(files, classes=[])) == ["form_field", "claude"]

    def fails(docs, classes, **_):
        raise claude.ExtractionError("Claude API error 529: overloaded")

    monkeypatch.setattr(claude, "extract", fails)
    assert methods(pipeline.run(files, classes=[])) == ["form_field", "not_read"]


def form_doc(**fields) -> Document:
    return Document("app.pdf", "acord_application", "application/pdf", form_fields={"NamedInsured_FullName_A": "Acme LLC", **fields})


def test_loss_row_without_a_date_is_named_in_a_warning():
    """CR-123: a $150,000 open claim typed without a date used to vanish, firing no referral."""
    _, losses, warnings = acord.extract(form_doc(
        LossHistory_OccurrenceDescription_A="Scaffold fall", LossHistory_TotalIncurredAmount_A="$150,000",
        LossHistory_ClaimStatusCode_A="Open"))
    assert losses == []
    assert warnings == ["app.pdf: loss row A has no date and was not read (Scaffold fall, $150,000)"]


def test_loss_row_without_an_amount_is_kept_and_named_in_a_warning():
    _, [loss], warnings = acord.extract(form_doc(
        LossHistory_OccurrenceDate_B="03/18/2024", LossHistory_OccurrenceDescription_B="Trip"))
    assert (loss.date, loss.incurred) == ("2024-03-18", 0)
    assert warnings == ["app.pdf: loss row B has no amount and was read as $0 (03/18/2024, Trip)"]


def test_blank_and_complete_loss_rows_warn_about_nothing():
    _, [loss], warnings = acord.extract(form_doc(
        LossHistory_OccurrenceDate_A="03/18/2024", LossHistory_OccurrenceDescription_A="Trip",
        LossHistory_TotalIncurredAmount_A="$8,200", LossHistory_ClaimStatusCode_A="Closed"))
    assert loss.incurred == 8200 and warnings == []


def app_and_loss_run() -> list[Document]:
    return [Document("app.pdf", "acord_application", "application/pdf"), Document("lr.pdf", "loss_run", "application/pdf")]


def test_same_claim_at_two_valuations_counts_once_at_the_loss_run_amount():
    """CR-122: an application and a loss run valued on different dates used to double the claim count."""
    losses = [Loss("2024-03-18", "Trip (app)", 8200, "Closed", "app.pdf"),
              Loss("2024-03-18", "Trip (loss run)", 11846, "Closed", "lr.pdf"),
              Loss("2025-06-01", "Only on the application", 500, "Closed", "app.pdf")]
    kept, warnings = pipeline.dedupe_losses(losses, app_and_loss_run())
    assert sorted((l.date, l.incurred) for l in kept) == [("2024-03-18", 11846), ("2025-06-01", 500)]
    assert warnings == ["2024-03-18: ACORD-style application shows $8,200, loss run shows $11,846; used the loss run"]


def test_loss_run_keeps_several_rows_on_one_date_and_names_them_in_the_warning():
    losses = [Loss("2024-05-02", "Claimant A", 5000, "Closed", "lr.pdf"),
              Loss("2024-05-02", "Claimant B", 7000, "Open", "lr.pdf"),
              Loss("2024-05-02", "Incident (app)", 9000, "Closed", "app.pdf")]
    kept, warnings = pipeline.dedupe_losses(losses, app_and_loss_run())
    assert sorted(l.description for l in kept) == ["Claimant A", "Claimant B"]
    assert warnings == ["2024-05-02: ACORD-style application shows $9,000, loss run shows $5,000 and $7,000; used the loss run"]


def test_without_a_loss_run_rows_at_different_amounts_all_survive():
    docs = [Document("app.pdf", "acord_application", "application/pdf"), Document("a.eml", "broker_email", "text/plain")]
    losses = [Loss("2024-03-18", "Trip", 8200, "Closed", "app.pdf"), Loss("2024-03-18", "Trip", 9000, "Closed", "a.eml")]
    kept, warnings = pipeline.dedupe_losses(losses, docs)
    assert len(kept) == 2 and warnings == []


def test_differing_claim_amounts_reach_the_result_and_the_live_feed(monkeypatch):
    fake_claude(monkeypatch, losses=[Loss("2024-03-18", "Trip", 11846, "Closed", "lone-star-electric-loss-run.pdf")])
    files = case_files("01")
    events = []
    result = pipeline.run(files, classes=[], emit=events.append)
    assert [l["incurred"] for l in result["submission"]["loss_history"]] == [11846]
    text = "2024-03-18: ACORD-style application shows $8,200, loss run shows $11,846; used the loss run"
    assert text in result["warnings"] and {"type": "warning", "message": text} in events


def test_same_states_in_another_order_are_not_a_conflict():
    """CR-060"""
    fv = lambda value, doc: FieldValue("operations.states", value, 0.9, "claude", "stated", doc)  # noqa: E731
    _, conflicts = pipeline.merge([fv(["FL", "GA"], "a.pdf"), fv(["GA", "FL"], "b.pdf")])
    assert conflicts == []
    _, conflicts = pipeline.merge([fv(["FL", "GA"], "a.pdf"), fv(["GA", "SC"], "b.pdf")])
    assert len(conflicts) == 1


USAGE = type("U", (), {"input_tokens": 10, "output_tokens": 5})()


def reply_field(path, value, basis, confidence, source="a.eml"):
    return {"path": path, "value": value, "basis": basis, "confidence": confidence, "source_document": source, "snippet": ""}


def test_claude_candidates_all_reach_merge_so_the_loser_is_a_conflict():
    """CR-025: an inferred 0.85 used to beat a stated 0.7 inside _parse, and the loser was never seen."""
    reply = {"fields": [reply_field("operations.employees", "14", "inferred", 0.85, "a.eml"),
                        reply_field("operations.employees", "12", "stated", 0.7, "b.pdf")],
             "loss_history": [], "notes": []}
    result = claude._parse(reply, "claude-opus-5-5", USAGE)
    assert len(result.fields) == 2
    chosen, conflicts = pipeline.merge(result.fields)
    assert chosen["operations.employees"].value == 12
    assert conflicts == [{"path": "operations.employees", "chosen": 12,
                          "others": [{"value": 14, "source_document": "a.eml", "method": "claude"}]}]


def test_off_list_class_code_is_dropped_with_a_warning(monkeypatch):
    """CR-058: an off-list code used to pass intake and fail only at Save & rate."""
    code = lambda value: FieldValue("operations.class_code", value, 0.8, "claude", "inferred", "a.eml")  # noqa: E731
    classes = [{"class_code": "98304", "description": "Painting"}]
    files = case_files("05")

    fake_claude(monkeypatch, fields=[code("99999")])
    result = pipeline.run(files, classes)
    assert "operations.class_code" in result["missing_for_rating"]
    assert any("99999" in w and "not a rateable class" in w for w in result["warnings"])

    fake_claude(monkeypatch, fields=[code("98304")])
    result = pipeline.run(files, classes)
    assert result["submission"]["operations"]["class_code"] == "98304"
    assert not any("rateable" in w for w in result["warnings"])

    # A second candidate that is off-list costs only itself.
    fake_claude(monkeypatch, fields=[code("99999"), code("98304")])
    result = pipeline.run(files, classes)
    assert result["submission"]["operations"]["class_code"] == "98304" and result["conflicts"] == []

    # With no class list there is nothing to check against: the code stays, and the existing warning says so.
    fake_claude(monkeypatch, fields=[code("99999")])
    result = pipeline.run(files, classes=[])
    assert result["submission"]["operations"]["class_code"] == "99999"
    assert any("class list unavailable" in w for w in result["warnings"])


def delta(kind, **fields):
    return SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type=kind, **fields))


class FakeStream:
    """Stands in for the SDK's message stream: yields `events` (raising any that are exceptions)."""

    def __init__(self, events, content=()):
        self.events, self.content, self.closed, self.consumed = events, list(content), False, 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def __iter__(self):
        for event in self.events:
            if isinstance(event, Exception):
                raise event
            self.consumed += 1
            yield event

    def get_final_message(self):
        return SimpleNamespace(stop_reason="end_turn", content=self.content, model="fake", usage=USAGE)


def fake_sdk(monkeypatch, stream):
    """Replace the Anthropic client; returns the keyword arguments the client was built with."""
    built = {}

    def client(**kwargs):
        built.update(kwargs)
        return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=lambda **_: stream)))

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(claude.anthropic, "Anthropic", client)
    return built


EMAIL_DOC = Document("a.eml", "broker_email", "text/plain", text="hello")


def test_claude_client_retries_once_within_a_shorter_timeout(monkeypatch):
    """CR-020: the default of two retries at 300 s could hold a request for about 15 minutes."""
    built = fake_sdk(monkeypatch, FakeStream([], [SimpleNamespace(type="text", text='{"fields":[],"loss_history":[],"notes":[]}')]))
    assert claude.extract([EMAIL_DOC], []).fields == []
    assert built["timeout"] == 240.0 and built["max_retries"] == 1


@pytest.mark.parametrize("stream", [
    FakeStream([], [SimpleNamespace(type="thinking", thinking="hmm")]),  # thinking only: no text block at all
    FakeStream([], [SimpleNamespace(type="text", text="not json")]),
    FakeStream([], [SimpleNamespace(type="text", text='{"fields":[]}')]),  # missing keys
    FakeStream([ConnectionResetError("peer closed the connection mid-stream")]),
], ids=["thinking-only", "not-json", "missing-keys", "dropped-mid-stream"])
def test_unreadable_claude_reply_is_a_warning_not_a_500(monkeypatch, stream):
    """CR-020: these escaped pipeline.run, so /extract answered 500 and lost the other documents."""
    fake_sdk(monkeypatch, stream)
    res = TestClient(app).post("/extract", files=[("files", (name, data)) for name, data in case_files("01")])
    assert res.status_code == 200
    body = res.json()
    assert body["submission"]["applicant"]["name"] == "Lone Star Electrical Services LLC"
    assert any("1 document(s) were not read" in w for w in body["warnings"])
    assert body["documents"][1]["method"] == "not_read"


def test_setting_cancel_stops_the_claude_stream_at_its_next_event(monkeypatch):
    """CR-087: leaving the `with` is what closes the connection and ends the token spend."""
    cancel = threading.Event()
    stream = FakeStream([delta("thinking_delta", thinking="one"), delta("thinking_delta", thinking="two"),
                         delta("thinking_delta", thinking="three")])
    fake_sdk(monkeypatch, stream)
    seen = []

    def on_event(event):
        seen.append(event["text"])
        cancel.set()

    with pytest.raises(claude.ExtractionError, match="cancelled"):
        claude.extract([EMAIL_DOC], [], on_event=on_event, cancel=cancel)
    assert seen == ["one"] and stream.closed and stream.consumed == 2


def test_cancel_set_before_the_call_never_starts_it(monkeypatch):
    def must_not_build(**_):
        raise AssertionError("the client was built")

    monkeypatch.setattr(claude.anthropic, "Anthropic", must_not_build)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(claude.ExtractionError, match="cancelled"):
        claude.extract([EMAIL_DOC], [], cancel=cancel)


def stream_scope(request: httpx.Request, spec_version: str) -> dict:
    return {"type": "http", "asgi": {"version": "3.0", "spec_version": spec_version}, "http_version": "1.1",
            "method": request.method, "scheme": "http", "path": request.url.path, "raw_path": request.url.raw_path,
            "root_path": "", "query_string": b"", "client": ("test", 1), "server": ("test", 80),
            "headers": [(k.lower().encode(), v.encode()) for k, v in request.headers.items()]}


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])  # uvicorn reports 2.3: the disconnect arrives on receive()
def test_client_going_away_cancels_the_extraction_and_frees_its_slot(monkeypatch, spec_version):
    """CR-087: TestClient buffers whole responses, so this drives the ASGI app and hangs up after the first line."""
    import app.main as main
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(main, "_stream_slots", slots)
    monkeypatch.setattr(main, "rateable_classes", lambda: [])
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    saw_cancel, finished = threading.Event(), threading.Event()

    def slow_extract(docs, classes, cancel, **_):
        if cancel.wait(5):
            saw_cancel.set()
        finished.set()
        raise claude.ExtractionError("stopped")

    monkeypatch.setattr(claude, "extract", slow_extract)
    request = httpx.Request("POST", "http://test/extract/stream", files=[("files", ("a.txt", b"hello"))])
    body = request.read()

    async def hang_up_after_first_line():
        hung_up = asyncio.Event()
        incoming = [{"type": "http.request", "body": body, "more_body": False}]

        async def receive():
            if incoming:
                return incoming.pop(0)
            await hung_up.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body" and message.get("body"):
                hung_up.set()
                if spec_version == "2.4":
                    raise OSError("client disconnected")

        with suppress(ClientDisconnect):
            await asyncio.wait_for(app(stream_scope(request, spec_version), receive, send), timeout=5)

    asyncio.run(hang_up_after_first_line())
    assert saw_cancel.wait(5), "the extractor never saw the cancel"
    assert finished.wait(5)
    for _ in range(100):  # the worker releases its slot just after the extractor returns
        if slots.acquire(blocking=False):
            break
        time.sleep(0.02)
    else:
        pytest.fail("the stream slot was never released")


def test_stream_slots_bound_concurrency_and_are_released(monkeypatch):
    """CR-087: every /extract/stream used to start another thread, with nothing limiting how many."""
    import app.main as main
    monkeypatch.setattr(main, "rateable_classes", lambda: [])
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(main, "_stream_slots", slots)
    client = TestClient(app)
    files = [("files", ("a.txt", b"hello"))]

    assert slots.acquire(blocking=False)  # a stream is already running
    res = client.post("/extract/stream", files=files)
    assert res.status_code == 503 and res.headers["retry-after"] == "60"
    slots.release()

    for _ in range(2):  # a finished stream gives its slot back, so the next one gets it
        res = client.post("/extract/stream", files=files)
        assert res.status_code == 200
        assert json.loads(res.text.splitlines()[-1])["type"] == "result"


def test_read_endpoints_declare_their_response_shapes():
    """CR-064: the web tier hand-types these bodies."""
    client = TestClient(app)
    paths = client.get("/openapi.json").json()["paths"]
    schema_of = lambda path, verb: paths[path][verb]["responses"]["200"]["content"]["application/json"]["schema"]  # noqa: E731
    assert schema_of("/health", "get") == {"$ref": "#/components/schemas/Health"}
    assert schema_of("/extract", "post") == {"$ref": "#/components/schemas/ExtractResponse"}
    assert client.get("/health").json()["service"] == "ingestion"


def test_extract_refuses_to_send_a_body_that_has_drifted_from_its_model(monkeypatch):
    """CR-064: a renamed key fails at the service instead of reaching a page as undefined."""
    good = pipeline.run(case_files("01"), classes=[], use_claude=False)
    assert ExtractResponse.model_validate(good).model_dump().keys() == good.keys()

    monkeypatch.setattr(pipeline, "run", lambda *a, **k: {**good, "warning_list": good["warnings"], "warnings": None})
    with pytest.raises(ResponseValidationError):
        TestClient(app).post("/extract", files=[("files", ("a.txt", b"x"))])


def test_every_sample_body_fits_the_response_model():
    for case_dir in sorted((SAMPLES / "submissions").iterdir()):
        if case_dir.is_dir():
            files = [(p.name, p.read_bytes()) for p in sorted(case_dir.iterdir()) if not p.name.startswith(".")]
            ExtractResponse.model_validate(pipeline.run(files, classes=[], use_claude=False))


def test_stream_result_has_the_extract_body():
    client = TestClient(app)
    files = [("files", (name, data)) for name, data in case_files("01")]
    plain = client.post("/extract?use_claude=false", files=files).json()
    with client.stream("POST", "/extract/stream?use_claude=false", files=files) as res:
        last = [json.loads(line) for line in res.iter_lines() if line][-1]
    assert last["type"] == "result" and last["result"] == plain


def test_schema_contract_file_is_current():
    """CR-015: web/src/lib/submission.test.ts asserts the TypeScript copy against this same file.
    After a deliberate change, regenerate it: python -m app.contract > ../../samples/schema.json"""
    assert json.loads((SAMPLES / "schema.json").read_text()) == contract()


def test_sample_generator_writes_every_form_field_the_reader_reads():
    source = (SAMPLES / "generate.py").read_text()
    names = [*acord.FIELD_MAP, *(f"LossHistory_{column}_" for column in acord.LOSS_COLUMNS)]
    assert [name for name in names if name not in source] == []
