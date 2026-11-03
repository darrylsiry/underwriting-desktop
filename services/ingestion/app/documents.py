"""Turn uploaded files into classified documents.

Classification is deterministic (file type, ACORD form-field names, title
text) so it's free, instant, and explainable. Emails are unpacked: the body
becomes one document and each attachment is classified on its own.
"""
import email
import hashlib
import io
import re
from dataclasses import dataclass, field
from email import policy
from pathlib import PurePath

from docx import Document as DocxDocument
from docx.table import Table
from pypdf import PdfReader
from pypdf.generic import NameObject

from app import acord

NOT_READ_FROM_FORM = ("loss_run", "supplemental_questionnaire")
# A mention isn't a loss run: applications and cover letters say "attach loss runs" (CR-160).
LOSS_RUN_MENTION = re.compile(r"\b(ATTACH\w*|ENCLOS\w*|INCLUD\w*|SEE|PLEASE|PROVIDE\w*|REQUEST\w*|SEND|SENT|FOLLOW\w*|NEED\w*|REQUIRED|NO|NOT|PENDING)\b")
LOSS_RUN_TERMS = ("TOTAL INCURRED", "VALUED AS OF", "VALUATION DATE")


@dataclass
class Document:
    filename: str
    doc_type: str   # acord_application | acord_application_flattened | loss_run | supplemental_questionnaire
                    # | broker_email | application | other
    media_type: str  # application/pdf | text/plain
    data: bytes = b""            # original bytes (PDFs go to Claude as documents)
    text: str = ""               # plain text (emails, Word files)
    form_fields: dict[str, str] = field(default_factory=dict)
    parent: str | None = None    # email this came attached to
    skipped: list[str] = field(default_factory=list)  # an email's attachments that weren't read, as warnings
    read_by_claude: bool = False  # set by the pipeline once a Claude call over this document succeeds
    weak_type: bool = False      # a loss-run heading with none of a loss run's own terms: Claude may correct it (CR-177)

    @property
    def read_from_form(self) -> bool:
        """Only a filled application is read from its fields. A fillable loss run or questionnaire, or a
        PDF whose filled fields aren't ones acord.py maps, would yield nothing that way, so Claude reads it."""
        return self.doc_type not in NOT_READ_FROM_FORM and acord.has_mapped_fields(self.form_fields)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.data or self.text.encode("utf-8", "replace")).hexdigest()

    def summary(self) -> dict:
        method = "form_field" if self.read_from_form else "claude" if self.read_by_claude else "not_read"
        return {"filename": self.filename, "doc_type": self.doc_type, "parent": self.parent, "method": method}


class UnsupportedDocument(ValueError):
    pass


def load(filename: str, data: bytes, parent: str | None = None) -> list[Document]:
    suffix = PurePath(filename).suffix.lower()
    if suffix == ".pdf" or data[:5] == b"%PDF-":
        return [_pdf(filename, data, parent)]
    if suffix == ".eml":
        return _email(filename, data)
    if suffix == ".docx":
        return [Document(filename, "application", "text/plain", text=_docx_text(data), parent=parent)]
    if suffix in (".txt", ".md"):
        return [Document(filename, "other", "text/plain", text=data.decode("utf-8", "replace"), parent=parent)]
    raise UnsupportedDocument(f"{filename}: unsupported file type (send PDF, EML, DOCX, or TXT)")


def _form_value(value) -> str:
    """A checkbox's value is a PDF name: /Off is an unticked box, so no answer, and /Yes reads as yes (CR-162)."""
    if isinstance(value, NameObject):
        return "" if value == "/Off" else value.lstrip("/")
    return str(value or "").strip()


def _is_loss_run(first_page: str, application: bool) -> bool:
    """It says so at the top of the page, or says so and carries a loss run's own terms."""
    lines = [line for line in first_page.splitlines() if line.strip()]
    if any("LOSS RUN" in line and not LOSS_RUN_MENTION.search(line) for line in lines[:5]):
        return True
    return not application and "LOSS RUN" in first_page and any(term in first_page for term in LOSS_RUN_TERMS)


def _doc_type(first_page: str, fields: dict[str, str]) -> str:
    """A filled application is one whatever else it says, so its fields get read (CR-160)."""
    application = "INSURANCE APPLICATION" in first_page or "ACORD" in first_page
    if application and acord.has_mapped_fields(fields):
        return "acord_application"
    if _is_loss_run(first_page, application):
        return "loss_run"
    if "SUPPLEMENTAL QUESTIONNAIRE" in first_page:
        return "supplemental_questionnaire"
    if application:
        return "acord_application_flattened"
    return "application" if "APPLICATION" in first_page else "other"


def _pdf(filename: str, data: bytes, parent: str | None) -> Document:
    reader = PdfReader(io.BytesIO(data))
    fields = {k: _form_value(v.get("/V")) for k, v in (reader.get_fields() or {}).items()}
    first_page = (reader.pages[0].extract_text() or "").upper() if reader.pages else ""
    doc_type = _doc_type(first_page, fields)
    weak = doc_type == "loss_run" and not any(term in first_page for term in LOSS_RUN_TERMS)
    return Document(filename, doc_type, "application/pdf", data=data, form_fields=fields, parent=parent, weak_type=weak)


def _attachments(part, body):
    """Every file in a message, however it is nested: iter_attachments misses those inside multipart/alternative
    and multipart/related (CR-169). A forwarded message stops the walk and keeps its warning; a logo an HTML
    body shows by Content-ID isn't a document."""
    for sub in part.iter_parts():
        if sub.get_content_type() == "message/rfc822":
            yield sub
        elif sub.is_multipart():
            yield from _attachments(sub, body)
        elif sub is body or (sub.get_content_maintype() == "image" and sub["Content-ID"]):
            continue
        elif sub.get_filename() or sub.get_content_maintype() != "text":
            yield sub


def _email(filename: str, data: bytes) -> list[Document]:
    msg = email.message_from_bytes(data, policy=policy.default)
    body = msg.get_body(preferencelist=("plain", "html"))
    header = "\n".join(f"{h}: {msg[h]}" for h in ("From", "To", "Date", "Subject") if msg[h])
    main = Document(filename, "broker_email", "text/plain", text=f"{header}\n\n{body.get_content() if body else ''}")
    docs = [main]
    for part in _attachments(msg, body):
        name = part.get_filename() or "attachment"
        try:
            payload = part.get_payload(decode=True)
            if payload is None:  # a forwarded message (message/rfc822) holds parts, not bytes
                main.skipped.append(f"{filename}: attachment {part.get_filename() or part.get_content_type()} "
                                    "was not read (a forwarded message); ask the broker to send its files directly")
                continue
            docs += load(name, payload, parent=filename)
        except UnsupportedDocument:
            main.skipped.append(f"{filename}: attachment {name} was not read (unsupported file type)")
        except Exception as e:  # corrupt attachment: report it, keep the body and the other attachments
            main.skipped.append(f"{filename}: attachment {name} could not be read ({e})")
    return docs


def _docx_text(data: bytes) -> str:
    """Paragraphs and table rows in document order (headings label the tables below them)."""
    lines = []
    for block in DocxDocument(io.BytesIO(data)).iter_inner_content():
        if isinstance(block, Table):
            lines += [" | ".join(cell.text.replace("\n", ", ") for cell in row.cells) for row in block.rows]
        elif block.text.strip():
            lines.append(block.text)
    return "\n".join(lines)
