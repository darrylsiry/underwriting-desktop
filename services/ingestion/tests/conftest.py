import io
import os
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, TextStringObject

# Repo checkout: services/ingestion/tests -> samples/. In a container, set SAMPLES_DIR.
SAMPLES = Path(os.environ["SAMPLES_DIR"]) if "SAMPLES_DIR" in os.environ else Path(__file__).resolve().parents[3] / "samples"


@pytest.fixture(autouse=True)
def no_claude(monkeypatch):
    """Tests never call the API; Claude parsing is tested with canned replies."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("UW_ANTHROPIC_API_KEY", raising=False)


def case_files(case: str) -> list[tuple[str, bytes]]:
    folder = next((SAMPLES / "submissions").glob(f"{case}*"))
    return [(p.name, p.read_bytes()) for p in sorted(folder.iterdir()) if not p.name.startswith(".")]


def fillable_pdf(heading: str, fields: dict[str, str]) -> bytes:
    """A one-page PDF whose first page reads `heading`, with these filled form fields."""
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                             NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    content = DecodedStreamObject()
    content.set_data(f"BT /F1 12 Tf 72 720 Td ({heading}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(content)
    refs = [writer._add_object(DictionaryObject({NameObject("/FT"): NameObject("/Tx"), NameObject("/T"): TextStringObject(name),
                                                 NameObject("/V"): TextStringObject(value)}))
            for name, value in fields.items()]
    writer.root_object[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({NameObject("/Fields"): ArrayObject(refs)}))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
