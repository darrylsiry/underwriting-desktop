"""Shapes of the responses the web tier reads. `Extraction` in web/src/lib/submission.ts mirrors
ExtractResponse, so a renamed key fails at this service instead of reaching a page as undefined."""
from typing import Literal

from pydantic import BaseModel

Value = str | int | bool | list[str] | None


class Health(BaseModel):
    service: str
    status: str
    claude_extraction: Literal["enabled", "disabled"]
    model: str


class LossRow(BaseModel):
    date: str
    description: str
    incurred: int
    status: str


class Submission(BaseModel):
    applicant: dict[str, Value]
    producer: dict[str, Value]
    policy: dict[str, Value]
    operations: dict[str, Value]
    loss_history: list[LossRow]
    prior: dict[str, Value]


class FieldMeta(BaseModel):
    value: Value
    confidence: float
    method: Literal["form_field", "claude"]
    basis: Literal["stated", "inferred"]
    source_document: str
    snippet: str


class ConflictOption(BaseModel):
    value: Value
    source_document: str
    method: Literal["form_field", "claude"]


class Conflict(BaseModel):
    path: str
    chosen: Value
    others: list[ConflictOption]


class DocumentSummary(BaseModel):
    filename: str
    doc_type: str
    parent: str | None
    method: Literal["form_field", "claude", "not_read"]


class ClaudeInfo(BaseModel):
    model: str
    usage: dict[str, int]


class ExtractResponse(BaseModel):
    submission: Submission
    fields: dict[str, FieldMeta]
    conflicts: list[Conflict]
    missing_for_rating: list[str]
    documents: list[DocumentSummary]
    notes: list[str]
    warnings: list[str]
    claude: ClaudeInfo | None
