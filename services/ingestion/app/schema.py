"""Canonical submission schema (see BUILD_LOG step-02) and value coercion.

Every scalar field has a dotted path such as `operations.gross_receipts`.
Extractors return raw strings; `coerce` turns them into the canonical type
(ISO dates, whole dollars, 0-100 percentages, booleans, state lists).
"""

import re
from datetime import date, datetime

# path -> type. Order is the order fields are shown in the UI.
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
    "policy.occurrence_limit": "money",
    "policy.aggregate_limit": "money",
    "policy.products_aggregate_limit": "money",
    "policy.deductible": "money",
    "operations.description": "str",
    "operations.class_code": "str",
    "operations.states": "states",
    "operations.gross_receipts": "money",
    "operations.payroll": "money",
    "operations.employees": "int",
    "operations.subcontracted_pct": "pct",
    "operations.subcontractor_coi_required": "bool",
    "operations.residential_pct": "pct",
    "operations.new_construction_pct": "pct",
    "operations.max_height_ft": "int",
    "operations.wrap_up_projects": "bool",
    "prior.carrier": "str",
    "prior.premium": "money",
}

# Fields the rating service needs; missing ones are flagged for the underwriter.
REQUIRED_FOR_RATING = [
    "operations.class_code", "operations.states", "operations.gross_receipts",
    "policy.occurrence_limit", "policy.aggregate_limit",
]

# Mirrors the rating service's 2026.1 class table, so Claude can map a
# description to a code. Keep in sync with services/rating/migrations/002_*.
CLASS_CODES = {
    "91342": "Carpentry - residential (interior finish)",
    "91560": "Concrete construction (flatwork, foundations)",
    "91583": "General contractor - remodel / renovation",
    "92215": "Electrical work - within buildings",
    "97050": "HVAC systems - commercial",
    "98304": "Painting - exterior / interior",
    "98482": "Plumbing - commercial and industrial",
    "98677": "Roofing - residential",
}

STATE_CODES = set(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM "
    "NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split()
)


def empty_submission() -> dict:
    sub: dict = {"loss_history": []}
    for path, kind in FIELDS.items():
        section, key = path.split(".")
        sub.setdefault(section, {})[key] = "" if kind in ("str", "state") else ([] if kind == "states" else None)
    return sub


def set_path(sub: dict, path: str, value) -> None:
    section, key = path.split(".")
    sub[section][key] = value


def is_blank(value) -> bool:
    return value is None or value == "" or value == []


def _number(raw: str, scaled: bool) -> float | None:
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", raw)
    if not m:
        return None
    n = float(m.group().replace(",", ""))
    tail = raw[m.end():].strip().lower()
    if not scaled:
        return n
    if re.match(r"(mm?|million)\b", tail):
        n *= 1_000_000
    elif re.match(r"(k|thousand)\b", tail):
        n *= 1_000
    return n


def _date(raw: str) -> str | None:
    raw = raw.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def coerce(path: str, raw):
    """Convert an extracted value to the canonical type; None/"" if unusable."""
    kind = FIELDS[path]
    blank = [] if kind == "states" else ("" if kind in ("str", "state") else None)
    if raw is None:
        return blank
    if isinstance(raw, bool) or isinstance(raw, (int, float)):
        raw = str(raw).lower() if isinstance(raw, bool) else str(raw)
    if isinstance(raw, list):
        raw = ", ".join(str(r) for r in raw)
    raw = str(raw).strip()
    if raw == "" or raw.lower() in ("null", "none", "n/a", "unknown"):
        return blank
    if kind == "str":
        return raw
    if kind == "state":
        return raw.upper() if raw.upper() in STATE_CODES else blank
    if kind == "states":
        return [s for s in re.findall(r"\b[A-Z]{2}\b", raw.upper()) if s in STATE_CODES]
    if kind == "date":
        return _date(raw)
    if kind == "bool":
        low = raw.lower()
        if low in ("y", "yes", "true", "1"):
            return True
        if low in ("n", "no", "false", "0"):
            return False
        return None
    n = _number(raw, scaled=kind == "money")
    if n is None:
        return None
    return round(n)


def add_one_year(iso: str) -> str:
    d = date.fromisoformat(iso)
    try:
        return d.replace(year=d.year + 1).isoformat()
    except ValueError:  # Feb 29
        return d.replace(year=d.year + 1, day=28).isoformat()
