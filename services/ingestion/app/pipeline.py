"""upload -> classify -> extract -> merge into one submission JSON with per-field confidence."""
import threading
from pathlib import PurePath

from app import acord, claude
from app.documents import Document, UnsupportedDocument, load
from app.schema import REQUIRED_FOR_RATING, FieldValue, Loss, build_submission, scrubbed


DOC_TYPE_LABELS = {
    "acord_application": "ACORD-style application", "acord_application_flattened": "flattened ACORD-style application",
    "loss_run": "loss run", "supplemental_questionnaire": "supplemental questionnaire", "broker_email": "broker email",
    "application": "application", "other": "unrecognized document",
}


def run(files: list[tuple[str, bytes]], classes: list[dict], use_claude: bool = True,
        emit: claude.Emit | None = None, cancel: threading.Event | None = None) -> dict:
    """`emit`, when given, receives a live activity feed (steps, fields, losses, Claude's reasoning).
    `cancel`, when set, stops a Claude call that is running or about to start."""
    emit = emit or (lambda _e: None)
    step = lambda stage, message: emit({"type": "step", "stage": stage, "message": message})  # noqa: E731
    docs: list[Document] = []
    warnings: list[str] = []
    first_copy: dict[str, str] = {}  # content hash -> the file name it was first read under
    names: set[str] = set()
    step("receive", f"Received {len(files)} file(s): " + ", ".join(f"{n} ({len(d) / 1024:.0f} KB)" for n, d in files))
    for name, data in files:
        renamed: dict[str, str] = {}
        try:
            for d in load(name, data):
                # A copy would be read twice under one name, and dedupe_losses keeps every row from one document (CR-142).
                first = first_copy.get(d.content_hash)
                if first is not None:
                    warnings.append(f"{d.filename} appears twice with the same contents; read once" if first == d.filename
                                    else f"{d.filename} has the same contents as {first}; read once")
                    continue
                # Everything from here on identifies a document by name, so one name can only mean one document (CR-166).
                d.parent = renamed.get(d.parent, d.parent)
                if d.filename in names:
                    later = _free_name(d.filename, names)
                    warnings.append(f"Two files named {d.filename} have different contents; the later one is read as {later}")
                    renamed[d.filename] = later
                    d.filename = later
                names.add(d.filename)
                first_copy[d.content_hash] = d.filename
                docs.append(d)
                how = ("has filled form fields, reading them directly" if d.read_from_form
                       else "no application form fields, Claude will read it")
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
        if doc.read_from_form:
            values, rows, w = acord.extract(doc)
            values, off_list = _rateable_only(values, classes)
            warnings += off_list
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
            if not values and not rows:
                warnings.append(f"{doc.filename}: no usable values could be read from its form fields")

    to_read = [d for d in docs if not d.read_from_form]
    claude_info, notes = None, []
    if to_read and use_claude and claude.enabled():
        if not classes:
            warnings.append("Rating service class list unavailable; Claude's class code is unchecked against rateable classes")
        step("claude", f"Sending {len(to_read)} document(s) to Claude ({claude.MODEL}): "
             + ", ".join(d.filename for d in to_read) + f"; {len(classes)} rateable class codes as context")
        try:
            result = claude.extract(to_read, classes, known=list(candidates), known_losses=list(losses), on_event=emit,
                                    cancel=cancel)
            tokens = result.usage or {}
            step("claude", f"Claude returned {len(result.fields)} fields, {len(result.losses)} loss row(s), "
                 f"{len(result.notes)} note(s) ({tokens.get('input_tokens', 0):,} tokens in, "
                 f"{tokens.get('output_tokens', 0):,} out)")
            rateable, off_list = _rateable_only(result.fields, classes)
            candidates += rateable
            losses += result.losses
            notes, warnings = result.notes, warnings + result.warnings + off_list
            claude_info = {"model": result.model, "usage": result.usage}
            for d in to_read:
                d.read_by_claude = True
                # Only what the file couldn't say itself: a scan has no first-page text, a Word file no heading test (CR-153),
                # and a subject line that only names loss runs isn't one (CR-177).
                if (d.weak_type or d.doc_type in ("other", "application")) and result.document_types.get(d.filename) in DOC_TYPE_LABELS:
                    d.doc_type = result.document_types[d.filename]
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
    kept_losses, loss_warnings = dedupe_losses(losses, docs)
    warnings += loss_warnings
    for w in warnings:
        emit({"type": "warning", "message": w})
    return scrubbed({
        "submission": build_submission(chosen, kept_losses),
        "fields": {path: {k: v for k, v in fv.to_dict().items() if k != "path"} for path, fv in chosen.items()},
        "conflicts": conflicts,
        "missing_for_rating": missing,
        "documents": [d.summary() for d in docs],
        "notes": notes,
        "warnings": warnings,
        "claude": claude_info,
    })


def _free_name(name: str, taken: set[str]) -> str:
    """`LossRuns.pdf` -> `LossRuns (2).pdf`, or the next number not already in use."""
    path, n = PurePath(name), 2
    while f"{path.stem} ({n}){path.suffix}" in taken:
        n += 1
    return f"{path.stem} ({n}){path.suffix}"


def _rateable_only(fields: list[FieldValue], classes: list[dict]) -> tuple[list[FieldValue], list[str]]:
    """Catch an off-list code at intake rather than failing at Save & rate, whether Claude chose it or a form
    stated it (CR-058, CR-171). With no list there is nothing to check against."""
    rateable = {str(c["class_code"]) for c in classes}
    kept, warnings = [], []
    for fv in fields:
        if fv.path == "operations.class_code" and rateable and fv.value not in rateable:
            warnings.append(f"Class code {fv.value} ({fv.source_document}) is not a rateable class and was dropped")
        else:
            kept.append(fv)
    return kept, warnings


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
    if isinstance(a, list) and isinstance(b, list):  # operations.states: order carries no meaning
        return sorted(a) == sorted(b)
    return a.casefold() == b.casefold() if isinstance(a, str) and isinstance(b, str) else a == b


def dedupe_losses(losses: list[Loss], docs: list[Document]) -> tuple[list[Loss], list[str]]:
    """The same claim often appears on the application and the loss run; keep one document's version.

    A loss run is the source for every date it covers: rows from other documents on those dates are
    dropped, with a warning when their amount isn't on the loss run (the two are often valued on
    different dates). The remaining rows are grouped by (date, incurred). Within a group, every row
    from one document is kept (two claimants hurt the same day for the same amount are two claims),
    but the same claim repeated on another document is dropped.
    """
    labels = {d.filename: DOC_TYPE_LABELS.get(d.doc_type, d.doc_type) for d in docs}
    loss_runs = {d.filename for d in docs if d.doc_type == "loss_run"}
    on_loss_run: dict[str, list[int]] = {}
    for loss in losses:
        if loss.source_document in loss_runs:
            on_loss_run.setdefault(loss.date, []).append(loss.incurred)

    warnings = []
    groups: dict[tuple, list[Loss]] = {}
    for loss in losses:
        if loss.source_document in loss_runs or loss.date not in on_loss_run:
            groups.setdefault((loss.date, loss.incurred), []).append(loss)
        elif loss.incurred not in on_loss_run[loss.date]:
            amounts = " and ".join(f"${n:,}" for n in on_loss_run[loss.date])
            warnings.append(f"{loss.date}: {labels.get(loss.source_document, loss.source_document)} shows "
                            f"${loss.incurred:,}, loss run shows {amounts}; used the loss run")
    kept = []
    for rows in groups.values():
        kept += [r for r in rows if r.source_document == rows[0].source_document]
    return kept, warnings
