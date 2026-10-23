"""Turn uploaded files into classified documents.

An upload can be a PDF (fillable or flattened), a broker email (.eml, whose
attachments become documents of their own), a Word application (.docx) or
plain text. Classification is rule-based on content signals, so it is free,
instant and explainable; each document records why it got its type.
"""

import email
import io
from dataclasses import dataclass, field
from email import policy

import docx
from pypdf import PdfReader

DOC_TYPES = {
    "acord_application": "ACORD-style application (fillable form)",
    "application": "Application (text / flattened / Word)",
    "supplemental_questionnaire": "Supplemental questionnaire",
    "loss_run": "Loss run",
    "broker_email": "Broker email",
    "unknown": "Unclassified document",
}


@dataclass
class Document:
    filename: str
    media_type: str  # pdf | eml | docx | text
    data: bytes
    text: str = ""
    form_fields: dict[str, str] = field(default_factory=dict)
    doc_type: str = "unknown"
    confidence: float = 0.0
    reason: str = ""
    parent: str | None = None  # email this was attached to

    def summary(self) -> dict:
        return {
            "filename": self.filename,
            "parent": self.parent,
            "media_type": self.media_type,
            "doc_type": self.doc_type,
            "doc_type_label": DOC_TYPES[self.doc_type],
            "confidence": self.confidence,
            "reason": self.reason,
            "form_fields": sum(1 for v in self.form_fields.values() if v),
        }


def load(filename: str, data: bytes, parent: str | None = None) -> list[Document]:
    """Parse one upload; emails expand into the email plus its attachments."""
    name = filename.lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        return [_classify(_pdf(filename, data, parent))]
    if name.endswith(".docx"):
        return [_classify(_docx(filename, data, parent))]
    if name.endswith(".eml"):
        return _eml(filename, data, parent)
    text = data.decode("utf-8", errors="replace")
    return [_classify(Document(filename, "text", data, text=text, parent=parent))]


def _pdf(filename, data, parent) -> Document:
    reader = PdfReader(io.BytesIO(data))
    fields = {k: str(v.get("/V") or "").strip() for k, v in (reader.get_fields() or {}).items()}
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return Document(filename, "pdf", data, text=text, form_fields=fields, parent=parent)


def _docx(filename, data, parent) -> Document:
    d = docx.Document(io.BytesIO(data))
    lines = [p.text for p in d.paragraphs if p.text.strip()]
    for table in d.tables:
        for row in table.rows:
            lines.append(" | ".join(c.text.replace("\n", ", ") for c in row.cells))
    return Document(filename, "docx", data, text="\n".join(lines), parent=parent)


def _eml(filename, data, parent) -> list[Document]:
    msg = email.message_from_bytes(data, policy=policy.default)
    body = msg.get_body(preferencelist=("plain", "html"))
    header = "\n".join(f"{h}: {msg[h]}" for h in ("From", "To", "Subject", "Date") if msg[h])
    text = header + "\n\n" + (body.get_content() if body else "")
    doc = Document(filename, "eml", data, text=text, parent=parent,
                   doc_type="broker_email", confidence=0.99, reason="RFC 822 email (.eml)")
    docs = [doc]
    for part in msg.iter_attachments():
        att_name = part.get_filename() or "attachment"
        docs += load(att_name, part.get_payload(decode=True) or b"", parent=filename)
    return docs


def _classify(doc: Document) -> Document:
    head = doc.text[:600].upper()
    filled = [k for k, v in doc.form_fields.items() if v]
    if any(k.startswith("NamedInsured_") for k in filled):
        doc.doc_type, doc.confidence = "acord_application", 0.99
        doc.reason = f"PDF with {len(filled)} filled ACORD-style form fields"
    elif "LOSS RUN" in head:
        doc.doc_type, doc.confidence, doc.reason = "loss_run", 0.95, "Title contains 'Loss Run'"
    elif "SUPPLEMENTAL" in head and "QUESTIONNAIRE" in head:
        doc.doc_type, doc.confidence = "supplemental_questionnaire", 0.95
        doc.reason = "Title contains 'Supplemental Questionnaire'"
    elif "APPLICATION" in head:
        doc.doc_type, doc.confidence = "application", 0.9
        doc.reason = "Title contains 'Application'" + (" (no fillable fields)" if doc.media_type == "pdf" else "")
    elif doc.media_type == "text" and head.startswith(("FROM:", "SUBJECT:")):
        doc.doc_type, doc.confidence, doc.reason = "broker_email", 0.8, "Email headers in text"
    elif doc.media_type == "pdf" and not doc.text.strip():
        doc.doc_type, doc.confidence, doc.reason = "unknown", 0.3, "Image-only PDF; Claude will read it"
    else:
        doc.reason = "No known title or form fields"
    return doc
