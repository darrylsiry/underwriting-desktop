"""upload -> classify -> extract -> merge into one submission JSON with per-field confidence."""
from app import acord, claude
from app.documents import Document, UnsupportedDocument, load
from app.schema import REQUIRED_FOR_RATING, FieldValue, Loss, build_submission


DOC_TYPE_LABELS = {
    "acord_application": "ACORD-style application", "acord_application_flattened": "flattened ACORD-style application",
    "loss_run": "loss run", "supplemental_questionnaire": "supplemental questionnaire", "broker_email": "broker email",
    "application": "application", "other": "unrecognized document",
}


def run(files: list[tuple[str, bytes]], classes: list[dict], use_claude: bool = True,
        emit: claude.Emit | None = None) -> dict:
    """`emit`, when given, receives a live activity feed (steps, fields, losses, Claude's reasoning)."""
    emit = emit or (lambda _e: None)
    step = lambda stage, message: emit({"type": "step", "stage": stage, "message": message})  # noqa: E731
    docs: list[Document] = []
    warnings: list[str] = []
    step("receive", f"Received {len(files)} file(s): " + ", ".join(f"{n} ({len(d) / 1024:.0f} KB)" for n, d in files))
    for name, data in files:
        try:
            loaded = load(name, data)
            docs += loaded
            for d in loaded:
                how = ("has filled form fields, reading them directly" if d.has_form_fields
                       else "no form fields, Claude will read it")
                where = f" (attached to {d.parent})" if d.parent else ""
                step("classify", f"{d.filename}{where}: {DOC_TYPE_LABELS.get(d.doc_type, d.doc_type)}; {how}")
                warnings += d.skipped
        except UnsupportedDocument as e:
            warnings.append(str(e))
        except Exception as e:  # corrupt file: report it, keep going with the rest
            warnings.append(f"{name}: could not be read ({e})")

    candidates: list[FieldValue] = []
    losses: list[Loss] = []
    for doc in docs:
        if doc.has_form_fields:
            values, rows, w = acord.extract(doc)
            for fv in values:
                emit({"type": "field", "path": fv.path, "value": fv.value, "basis": "stated",
                      "confidence": 1.0, "method": "form_field"})
            for loss in rows:
                emit({"type": "loss", "date": loss.date, "description": loss.description,
                      "incurred": loss.incurred, "status": loss.status, "method": "form_field"})
            step("form", f"Read {len(values)} fields and {len(rows)} loss row(s) from {doc.filename}'s form fields")
            candidates += values
            losses += rows
            warnings += w

    to_read = [d for d in docs if not d.has_form_fields]
    claude_info, notes = None, []
    if to_read and use_claude and claude.enabled():
        if not classes:
            warnings.append("Rating service class list unavailable; Claude's class code is unchecked against rateable classes")
        step("claude", f"Sending {len(to_read)} document(s) to Claude ({claude.MODEL}): "
             + ", ".join(d.filename for d in to_read) + f"; {len(classes)} rateable class codes as context")
        try:
            result = claude.extract(to_read, classes, known=list(candidates), known_losses=list(losses), on_event=emit)
            tokens = result.usage or {}
            step("claude", f"Claude returned {len(result.fields)} fields, {len(result.losses)} loss row(s), "
                 f"{len(result.notes)} note(s) ({tokens.get('input_tokens', 0):,} tokens in, "
                 f"{tokens.get('output_tokens', 0):,} out)")
            candidates += result.fields
            losses += result.losses
            notes, warnings = result.notes, warnings + result.warnings
            claude_info = {"model": result.model, "usage": result.usage}
        except claude.ExtractionError as e:
            warnings.append(f"{e}; {len(to_read)} document(s) were not read")
    elif to_read:
        reason = "turned off for this request" if not use_claude else "disabled (no ANTHROPIC_API_KEY)"
        warnings.append(f"Claude extraction {reason}; not read: {', '.join(d.filename for d in to_read)}")

    chosen, conflicts = merge(candidates)
    missing = [p for p in REQUIRED_FOR_RATING if p not in chosen]
    step("merge", f"Merged into {len(chosen)} fields"
         + (f"; {len(conflicts)} conflict(s) between documents" if conflicts else "")
         + (f"; missing for rating: {', '.join(missing)}" if missing else "; everything rating needs is present"))
    for w in warnings:
        emit({"type": "warning", "message": w})
    return {
        "submission": build_submission(chosen, dedupe_losses(losses, docs)),
        "fields": {path: {k: v for k, v in fv.to_dict().items() if k != "path"} for path, fv in chosen.items()},
        "conflicts": conflicts,
        "missing_for_rating": missing,
        "documents": [d.summary() for d in docs],
        "notes": notes,
        "warnings": warnings,
        "claude": claude_info,
    }


def merge(candidates: list[FieldValue]) -> tuple[dict[str, FieldValue], list[dict]]:
    """Pick one value per field: form fields beat Claude, then stated beats inferred, then confidence."""
    by_path: dict[str, list[FieldValue]] = {}
    for fv in candidates:
        by_path.setdefault(fv.path, []).append(fv)
    chosen, conflicts = {}, []
    for path, options in by_path.items():
        options.sort(key=lambda f: (f.method == "form_field", f.basis == "stated", f.confidence), reverse=True)
        chosen[path] = options[0]
        others = [o for o in options[1:] if not _same_value(o.value, options[0].value)]
        if others:
            conflicts.append({
                "path": path, "chosen": options[0].value,
                "others": [{"value": o.value, "source_document": o.source_document, "method": o.method} for o in others],
            })
    return chosen, conflicts


def _same_value(a, b) -> bool:
    return a.casefold() == b.casefold() if isinstance(a, str) and isinstance(b, str) else a == b


def dedupe_losses(losses: list[Loss], docs: list[Document]) -> list[Loss]:
    """The same claim often appears on the application and the loss run; keep one document's version.

    Rows are grouped by (date, incurred). Within a group, every row from one document is kept
    (two claimants hurt the same day for the same amount are two claims), but the same claim
    repeated on another document is dropped, preferring the loss run's rows.
    """
    loss_runs = {d.filename for d in docs if d.doc_type == "loss_run"}
    groups: dict[tuple, list[Loss]] = {}
    for loss in losses:
        groups.setdefault((loss.date, loss.incurred), []).append(loss)
    kept = []
    for rows in groups.values():
        sources = list(dict.fromkeys(r.source_document for r in rows))
        source = next((s for s in sources if s in loss_runs), sources[0])
        kept += [r for r in rows if r.source_document == source]
    return kept
