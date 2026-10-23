"""Claude extraction for unstructured documents (emails, flattened PDFs,
questionnaires, Word apps, loss runs).

All of a submission's unstructured documents go to Claude in one request so it
can read them together (an email that points at an attached loss run, a
questionnaire that fills gaps in an app). Structured outputs guarantee the
reply matches EXTRACTION_SCHEMA; every field carries a confidence and a verbatim
source snippet so the underwriter can see where it came from.
"""

import base64
import json
import os

import anthropic

from .documents import DOC_TYPES, Document
from .schema import CLASS_CODES, FIELDS

MODEL = os.environ.get("UW_INGEST_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("UW_INGEST_EFFORT", "low")


def api_key() -> str | None:
    # The Claude Code cloud sandbox reserves ANTHROPIC_API_KEY, so the key is
    # stored there as UW_ANTHROPIC_API_KEY. Docker compose, Fly and the live
    # repo use the standard name.
    return os.environ.get("UW_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or None


EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "documents": {
            "type": "array",
            "description": "One entry per document provided, confirming or correcting its type.",
            "items": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string"},
                    "doc_type": {"type": "string", "enum": list(DOC_TYPES)},
                },
                "required": ["filename", "doc_type"],
                "additionalProperties": False,
            },
        },
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "enum": list(FIELDS)},
                    "value": {"type": "string"},
                    "confidence": {"type": "number"},
                    "document": {"type": "string"},
                    "source": {"type": "string"},
                },
                "required": ["path", "value", "confidence", "document", "source"],
                "additionalProperties": False,
            },
        },
        "loss_history": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "date": {"type": "string"},
                    "description": {"type": "string"},
                    "incurred": {"type": "integer"},
                    "status": {"type": "string"},
                    "confidence": {"type": "number"},
                    "document": {"type": "string"},
                    "source": {"type": "string"},
                },
                "required": ["date", "description", "incurred", "status", "confidence", "document", "source"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["documents", "fields", "loss_history"],
    "additionalProperties": False,
}

FIELD_HINTS = {
    "str": "text", "state": "2-letter state code", "states": "comma-separated 2-letter state codes",
    "date": "YYYY-MM-DD", "money": "whole dollars, digits only", "int": "whole number",
    "pct": "0-100, digits only", "bool": "yes or no",
}

SYSTEM = f"""You extract structured data from insurance submissions for an E&S contractors' general liability underwriter.

You receive every unstructured document from one submission (broker emails, flattened or Word applications, supplemental questionnaires, loss runs). Read them together and report each field you can support.

Fields (path: format):
{chr(10).join(f"- {p}: {FIELD_HINTS[k]}" for p, k in FIELDS.items())}

Rules:
- Only report a field when the documents support it. Leave out fields you cannot find; never guess to fill a gap.
- `source` is a short verbatim quote from the document that supports the value. `document` is that document's filename.
- operations.class_code: choose from this class table when the operations clearly match one; otherwise leave it out.
{chr(10).join(f"  - {c}: {d}" for c, d in CLASS_CODES.items())}
- Some values are reasonable inferences rather than statements (a class code from a description, residential_pct of 100 when the work is described as entirely residential, states from where the work is done). Report them, start `source` with "Inferred: " followed by the reasoning, and give a lower confidence.
- operations.description: the applicant's operations in the broker's or applicant's words, lightly cleaned up.
- operations.gross_receipts is projected annual receipts/sales; operations.payroll excludes subcontractor costs. If subcontracting is expressed as a share of job costs, use that number for subcontracted_pct.
- policy limits: "$1M/$2M" means occurrence 1000000 and aggregate 2000000. Only report products_aggregate_limit or deductible when stated.
- prior.carrier and prior.premium are the expiring/current GL carrier and premium. "No prior coverage" means leave them out.
- loss_history: one row per claim or occurrence from loss runs or loss descriptions anywhere in the documents (no rows for "no losses"). date YYYY-MM-DD, incurred in whole dollars (paid + reserve if only those are given), status Open or Closed.
- confidence: 0.95-1.0 when stated explicitly and unambiguously; 0.8-0.94 when stated but needs interpretation (approximate wording, unit conversion); 0.5-0.79 for inferences; below 0.5 for weak signals. When documents conflict, report the value from the most authoritative document (application or questionnaire over email) and lower the confidence.
"""


def _content(docs: list[Document]) -> list[dict]:
    blocks = []
    for doc in docs:
        title = doc.filename + (f" (attached to {doc.parent})" if doc.parent else "")
        if doc.media_type == "pdf":
            source = {"type": "base64", "media_type": "application/pdf",
                      "data": base64.standard_b64encode(doc.data).decode()}
        else:
            source = {"type": "text", "media_type": "text/plain", "data": doc.text}
        blocks.append({"type": "document", "source": source, "title": title,
                       "context": f"Pre-classified as: {DOC_TYPES[doc.doc_type]}"})
    blocks.append({"type": "text", "text": "Extract the submission from these documents."})
    return blocks


class ExtractionError(Exception):
    pass


def extract(docs: list[Document], client: anthropic.Anthropic | None = None) -> dict:
    """One Claude call over all unstructured documents; returns the parsed JSON."""
    client = client or anthropic.Anthropic(api_key=api_key())
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
        system=SYSTEM,
        messages=[{"role": "user", "content": _content(docs)}],
    )
    if response.stop_reason == "refusal":
        raise ExtractionError("Claude declined to extract this submission")
    if response.stop_reason == "max_tokens":
        raise ExtractionError("Claude's extraction was cut off (max_tokens)")
    text = next(b.text for b in response.content if b.type == "text")
    result = json.loads(text)
    result["model"] = response.model
    result["usage"] = {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
    return result
