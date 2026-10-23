"""upload -> classify -> extract -> merge into one submission JSON."""

import time
import uuid
from datetime import datetime, timezone

from . import acord, claude_extract
from .documents import DOC_TYPES, Document, load
from .schema import (FIELDS, REQUIRED_FOR_RATING, add_one_year, coerce, empty_submission,
                     is_blank, set_path)

LOW_CONFIDENCE = 0.8


def ingest(files: list[tuple[str, bytes]], client=None) -> dict:
    started = time.monotonic()
    docs: list[Document] = []
    for filename, data in files:
        docs += load(filename, data)

    candidates: list[dict] = []
    losses: list[dict] = []
    warnings: list[str] = []
    for doc in docs:
        if doc.doc_type == "acord_application":
            f, l = acord.extract(doc)
            candidates += f
            losses += l

    unstructured = [d for d in docs if d.doc_type != "acord_application"]
    claude = {"used": False, "model": None, "usage": None}
    if unstructured:
        if claude_extract.api_key() or client is not None:
            try:
                result = claude_extract.extract(unstructured, client)
                claude.update(used=True, model=result["model"], usage=result["usage"])
                _apply_claude(result, docs, candidates, losses)
            except Exception as e:  # keep the deterministic results; tell the user why Claude is missing
                warnings.append(f"Claude extraction failed: {e}")
        else:
            names = ", ".join(d.filename for d in unstructured)
            warnings.append(f"No Anthropic API key: skipped Claude extraction for {names}")

    fields = _merge(candidates)
    _infer_expiration(fields)
    submission = empty_submission()
    for path, f in fields.items():
        set_path(submission, path, f["value"])
    submission["loss_history"] = [
        {k: row[k] for k in ("date", "description", "incurred", "status")} for row in _dedupe_losses(losses)
    ]

    return {
        "id": str(uuid.uuid4()),
        "received_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "documents": [d.summary() for d in docs],
        "submission": submission,
        "fields": [fields.get(p) or {"path": p, "value": None, "confidence": 0.0, "method": None,
                                      "document": None, "source": None, "alternatives": []} for p in FIELDS],
        "loss_history": _dedupe_losses(losses),
        "missing_for_rating": [p for p in REQUIRED_FOR_RATING if p not in fields],
        "low_confidence": [p for p, f in fields.items() if f["confidence"] < LOW_CONFIDENCE],
        "conflicts": [p for p, f in fields.items() if f["alternatives"]],
        "claude": claude,
        "warnings": warnings,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
    }


def _apply_claude(result: dict, docs: list[Document], candidates: list[dict], losses: list[dict]) -> None:
    by_name = {d.filename: d for d in docs}
    for item in result.get("documents", []):
        doc = by_name.get(item["filename"].split(" (attached to")[0])
        if doc and doc.doc_type == "unknown" and item["doc_type"] in DOC_TYPES:
            doc.doc_type, doc.confidence, doc.reason = item["doc_type"], 0.85, "Classified by Claude"
    for item in result.get("fields", []):
        value = coerce(item["path"], item["value"])
        if is_blank(value):
            continue
        candidates.append({
            "path": item["path"], "value": value, "method": "claude",
            "confidence": max(0.0, min(1.0, float(item["confidence"]))),
            "document": item["document"], "source": item["source"],
        })
    for row in result.get("loss_history", []):
        losses.append({
            "date": coerce("policy.effective_date", row["date"]), "description": row["description"],
            "incurred": row["incurred"], "status": row["status"].title(),
            "confidence": max(0.0, min(1.0, float(row["confidence"]))),
            "method": "claude", "document": row["document"], "source": row["source"],
        })


def _merge(candidates: list[dict]) -> dict[str, dict]:
    """Highest-confidence candidate wins; disagreeing values are kept as alternatives."""
    fields: dict[str, dict] = {}
    for path in FIELDS:
        cands = sorted((c for c in candidates if c["path"] == path), key=lambda c: -c["confidence"])
        if not cands:
            continue
        best = dict(cands[0])
        best["alternatives"] = [
            {k: c[k] for k in ("value", "confidence", "document", "source")}
            for c in cands[1:] if c["value"] != best["value"]
        ]
        fields[path] = best
    return fields


def _infer_expiration(fields: dict[str, dict]) -> None:
    eff = fields.get("policy.effective_date")
    if eff and "policy.expiration_date" not in fields:
        fields["policy.expiration_date"] = {
            "path": "policy.expiration_date", "value": add_one_year(eff["value"]),
            "confidence": 0.7, "method": "rule", "document": eff["document"],
            "source": "Inferred: standard 12-month term from the effective date", "alternatives": [],
        }


def _dedupe_losses(losses: list[dict]) -> list[dict]:
    """The same claim often appears in an app and its loss run; keep the best copy."""
    best: dict[tuple, dict] = {}
    for row in losses:
        key = (row["date"], row["incurred"])
        if key not in best or row["confidence"] > best[key]["confidence"]:
            best[key] = row
    return sorted(best.values(), key=lambda r: r["date"] or "")
