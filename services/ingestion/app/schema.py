"""The canonical submission schema (see samples/README.md) and value normalization.

Every extractor, deterministic or Claude, produces `FieldValue`s keyed by a
dotted path such as `operations.gross_receipts`; `normalize` turns raw strings
("$6,800,000", "12/01/2026", "Y", "35%") into the schema's types.
"""
import re
from dataclasses import asdict, dataclass
from datetime import datetime

# path -> type: str | int | bool | date | states
FIELDS: dict[str, str] = {
    "applicant.name": "str",
    "applicant.dba": "str",
    "applicant.street": "str",
    "applicant.city": "str",
    "applicant.state": "state",
    "applicant.zip": "str",
    "applicant.fein": "str",
    "applicant.entity_type": "str",
    "applicant.years_in_business": "int",
    "applicant.website": "str",
    "producer.agency": "str",
    "producer.contact": "str",
    "producer.email": "str",
    "producer.phone": "str",
    "policy.effective_date": "date",
    "policy.expiration_date": "date",
    "policy.occurrence_limit": "int",
    "policy.aggregate_limit": "int",
    "policy.products_aggregate_limit": "int",
    "policy.deductible": "int",
    "operations.description": "str",
    "operations.class_code": "str",
    "operations.states": "states",
    "operations.gross_receipts": "int",
    "operations.payroll": "int",
    "operations.employees": "int",
    "operations.subcontracted_pct": "int",
    "operations.subcontractor_coi_required": "bool",
    "operations.residential_pct": "int",
    "operations.new_construction_pct": "int",
    "operations.max_height_ft": "int",
    "operations.wrap_up_projects": "bool",
    "prior.carrier": "str",
    "prior.premium": "int",
}

# What the rating service needs before a submission can be rated.
REQUIRED_FOR_RATING = [
    "operations.class_code", "operations.gross_receipts", "operations.states", "applicant.state",
    "policy.occurrence_limit", "policy.aggregate_limit",
]


@dataclass
class FieldValue:
    path: str
    value: object
    confidence: float
    method: str            # 'form_field' | 'claude'
    basis: str             # 'stated' | 'inferred'
    source_document: str
    snippet: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


_OPEN_STATUS = re.compile(r"^(o|open|opn|re-?open|pending|litig|in suit|reserved)", re.I)
_CLOSED_STATUS = re.compile(r"^(c|cl|clsd|closed|paid|settled|denied|declined|cwp|cwop|withdrawn)", re.I)


def normalize_status(raw) -> str:
    """A claim status as carriers write it ("O", "OPEN-LIT", "Reopened", "Closed - paid", "CWP") reduced
    to the two words the underwriting rules test for, "Open" or "Closed"; anything else is kept as written."""
    text = str(raw or "").strip()
    if _CLOSED_STATUS.match(text):
        return "Closed"
    if _OPEN_STATUS.match(text):
        return "Open"
    return text


@dataclass
class Loss:
    date: str
    description: str
    incurred: int
    status: str
    source_document: str

    def __post_init__(self):
        self.status = normalize_status(self.status)


class NormalizeError(ValueError):
    pass


def normalize(path: str, raw) -> object:
    """Convert a raw extracted value to the schema type for `path`; None for blank."""
    kind = FIELDS[path]
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    text = str(raw).strip()
    if kind == "str":
        return text
    if kind == "state":
        if not re.fullmatch(r"[A-Za-z]{2}", text):
            raise NormalizeError(f"{path}: {text!r} is not a 2-letter state")
        return text.upper()
    if kind == "states":
        states = [s.upper() for s in re.split(r"[\s,;/&]+|\band\b", text) if s.strip()]
        if not states or not all(re.fullmatch(r"[A-Z]{2}", s) for s in states):
            raise NormalizeError(f"{path}: {text!r} is not a list of 2-letter states")
        return list(dict.fromkeys(states))
    if kind == "int":
        return to_int(text, path)
    if kind == "bool":
        lowered = text.lower()
        if lowered in ("y", "yes", "true", "1"):
            return True
        if lowered in ("n", "no", "false", "0"):
            return False
        raise NormalizeError(f"{path}: {text!r} is not yes/no")
    if kind == "date":
        return to_date(text, path)
    raise AssertionError(kind)


def to_int(text: str, path: str = "value") -> int:
    cleaned = re.sub(r"[$,%\s]|ft\.?$|feet$", "", text, flags=re.I)
    multiplier = 1
    if m := re.fullmatch(r"([\d.]+)([KkMm])", cleaned):
        cleaned, multiplier = m.group(1), 1_000 if m.group(2) in "Kk" else 1_000_000
    try:
        return round(float(cleaned) * multiplier)
    except ValueError:
        raise NormalizeError(f"{path}: {text!r} is not a number") from None


def to_date(text: str, path: str = "value") -> str:
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    raise NormalizeError(f"{path}: {text!r} is not a date")


def build_submission(values: dict[str, FieldValue], losses: list[Loss]) -> dict:
    """Nest chosen values into the canonical submission shape; missing fields are null."""
    out: dict = {}
    for path, kind in FIELDS.items():
        section, name = path.split(".")
        value = values[path].value if path in values else None
        if value is None and kind == "str":
            value = ""
        out.setdefault(section, {})[name] = value
    out["loss_history"] = [
        {"date": loss.date, "description": loss.description, "incurred": loss.incurred, "status": loss.status}
        for loss in sorted(losses, key=lambda loss: loss.date)
    ]
    return {k: out[k] for k in ("applicant", "producer", "policy", "operations", "loss_history", "prior")}
