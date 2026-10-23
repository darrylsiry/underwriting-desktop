"""Claude extraction for documents without form fields (emails, scans, questionnaires, loss runs).

All of a submission's documents go to Claude in one request, so it can read
them together (an email that says "loss runs attached" plus the loss run).
Structured outputs guarantee the reply matches SCHEMA; each field comes back
with a confidence, whether it was stated or inferred, its source document,
and a quoted snippet so the underwriter can check it.
"""
import base64
import json
import os
from dataclasses import dataclass, field

import anthropic

from app.documents import Document
from app.schema import FIELDS, FieldValue, Loss, NormalizeError, normalize, to_date

MODEL = os.environ.get("EXTRACTION_MODEL", "claude-opus-5-5")

SYSTEM = """You are an intake analyst for an excess & surplus lines insurer that writes \
contractors' general liability. Brokers send submissions in many shapes: ACORD-style \
applications, scanned forms, emails, supplemental questionnaires, and loss runs. You read \
them and extract the facts an underwriter needs, citing where each one came from. Accuracy \
matters more than completeness: an empty field is a question for the broker, a wrong field \
is a mispriced policy."""

INSTRUCTIONS = """Extract this submission into the fields of the response schema.

Fields
- Return one entry per field you have evidence for. Leave out fields with no evidence at all; never guess.
- Normalize values: dates as YYYY-MM-DD; money as whole dollars, digits only (e.g. 2300000); \
percentages as a number 0-100; yes/no as "true" or "false"; operations.states as comma-separated \
2-letter codes; applicant.state is the state of the mailing address.
- basis "stated": the document says it directly (reformatting is fine). basis "inferred": you derived \
it, e.g. expiration = effective + 1 year when only the effective date is given, residential_pct 100 for \
"single family repaints", or the class code that matches the described operations.
- confidence: 0.9-1.0 stated and unambiguous; 0.6-0.85 inferred with strong support or stated but \
ambiguous; 0.3-0.5 weak inference.
- snippet: a short exact quote (under 200 characters) from the source that supports the value.
- If documents disagree, prefer the signed application over a questionnaire over an email, and say so in notes.

Class codes: choose operations.class_code only from this list, as an inference unless a document states it.
{classes}

Loss history: list every individual claim from loss runs or applications (incurred in whole dollars, \
status as written). If a document says there were no losses, return an empty list.

{known}Notes: up to 5 short underwriting-relevant facts the fields don't capture (e.g. New York Labor Law \
240 exposure, a large open claim, documents the broker promised but didn't send)."""


def response_schema(filenames: list[str]) -> dict:
    source = {"type": "string", "enum": filenames}
    return {
        "type": "object",
        "properties": {
            "fields": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "enum": list(FIELDS)},
                    "value": {"type": "string"},
                    "basis": {"type": "string", "enum": ["stated", "inferred"]},
                    "confidence": {"type": "number"},
                    "source_document": source,
                    "snippet": {"type": "string"},
                },
                "required": ["path", "value", "basis", "confidence", "source_document", "snippet"],
                "additionalProperties": False,
            }},
            "loss_history": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "date": {"type": "string"},
                    "description": {"type": "string"},
                    "incurred": {"type": "integer"},
                    "status": {"type": "string"},
                    "source_document": source,
                },
                "required": ["date", "description", "incurred", "status", "source_document"],
                "additionalProperties": False,
            }},
            "notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["fields", "loss_history", "notes"],
        "additionalProperties": False,
    }


@dataclass
class ClaudeResult:
    fields: list[FieldValue]
    losses: list[Loss]
    notes: list[str]
    model: str
    usage: dict
    warnings: list[str] = field(default_factory=list)


class ExtractionError(RuntimeError):
    pass


def api_key() -> str | None:
    # The Claude Code cloud sandbox reserves ANTHROPIC_API_KEY and doesn't pass it into
    # sessions, so the key is stored there as UW_ANTHROPIC_API_KEY. Compose and Fly use the standard name.
    return os.environ.get("UW_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or None


def enabled() -> bool:
    return api_key() is not None


def _content_block(doc: Document) -> dict:
    if doc.media_type == "application/pdf":
        source = {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(doc.data).decode()}
    else:
        source = {"type": "text", "media_type": "text/plain", "data": doc.text}
    title = f"{doc.filename} ({doc.doc_type.replace('_', ' ')}{f', attached to {doc.parent}' if doc.parent else ''})"
    return {"type": "document", "source": source, "title": title}


def _known_section(known: list[FieldValue], known_losses: list[Loss]) -> str:
    """Values already read from fillable forms, so notes don't call them missing."""
    if not known and not known_losses:
        return ""
    lines = [f"- {f.path} = {f.value!r} ({f.source_document})" for f in known]
    lines += [f"- loss {l.date}: {l.description}, ${l.incurred:,} incurred, {l.status} ({l.source_document})" for l in known_losses]
    return ("Already read from fillable form fields (not shown to you). Don't repeat these fields unless a "
            "document you can see states a different value; use them for context and notes:\n"
            + "\n".join(lines) + "\n\n")


def extract(docs: list[Document], classes: list[dict], known: list[FieldValue] = (),
            known_losses: list[Loss] = ()) -> ClaudeResult:
    filenames = [d.filename for d in docs]
    class_list = "\n".join(f"- {c['class_code']}: {c['description']}" for c in classes) or "(class list unavailable)"
    client = anthropic.Anthropic(api_key=api_key(), timeout=300.0)
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": response_schema(filenames)}},
            system=SYSTEM,
            messages=[{"role": "user", "content": [
                *(_content_block(d) for d in docs),
                {"type": "text", "text": INSTRUCTIONS.format(classes=class_list, known=_known_section(known, known_losses))},
            ]}],
        )
    except anthropic.APIStatusError as e:
        raise ExtractionError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ExtractionError(f"Could not reach the Claude API: {e}") from e

    if response.stop_reason == "refusal":
        raise ExtractionError("Claude declined to extract these documents")
    if response.stop_reason == "max_tokens":
        raise ExtractionError("Claude's reply was cut off (max_tokens)")
    text = next(b.text for b in response.content if b.type == "text")
    return _parse(json.loads(text), response.model, response.usage)


def _parse(data: dict, model: str, usage) -> ClaudeResult:
    warnings, best = [], {}
    for item in data["fields"]:
        try:
            value = normalize(item["path"], item["value"])
        except NormalizeError as e:
            warnings.append(f"Claude: {e}")
            continue
        if value is None:
            continue
        fv = FieldValue(item["path"], value, max(0.0, min(1.0, item["confidence"])), "claude",
                        item["basis"], item["source_document"], item["snippet"])
        if item["path"] not in best or fv.confidence > best[item["path"]].confidence:
            best[item["path"]] = fv

    losses = []
    for item in data["loss_history"]:
        try:
            losses.append(Loss(to_date(item["date"]), item["description"], item["incurred"], item["status"],
                               item["source_document"]))
        except NormalizeError as e:
            warnings.append(f"Claude loss row: {e}")

    return ClaudeResult(
        fields=list(best.values()), losses=losses, notes=data["notes"], model=model,
        usage={"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens},
        warnings=warnings,
    )
