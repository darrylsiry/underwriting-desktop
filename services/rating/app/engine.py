"""Contractors GL rating engine: a pure function of (rate tables, rating input).

premium = base rate × receipts/1000 × territory × ILF × deductible
          × residential × subcontracting × [no-sub-COI] × height
          × experience mod × schedule mod, floored at the class minimum premium.
total   = premium + policy fee + surplus lines tax on both.
"""
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from pydantic import BaseModel, Field


class RatingError(ValueError):
    """The input can't be rated with these tables (unknown class, limit, state...)."""


class RatingInput(BaseModel):
    class_code: str
    # The cap keeps a typo from overflowing the arithmetic or, at the seeded rates' highest, quotes.premium numeric(12,2) (CR-150).
    gross_receipts: Decimal = Field(gt=0, le=Decimal("10000000000"))
    states: list[str] = Field(min_length=1, description="States of operation; the worst territory applies")
    home_state: str = Field(description="Insured's home state; drives surplus lines tax")
    occurrence_limit: int
    aggregate_limit: int
    deductible: Decimal = Decimal(0)
    residential_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    subcontracted_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    subcontractor_coi_required: bool = True
    max_height_ft: Decimal = Field(default=Decimal(0), ge=0)
    experience_mod: Decimal = Decimal(1)
    schedule_mod: Decimal = Decimal(1)


@dataclass
class FactorTable:
    kind: str  # 'exact' | 'band'
    entries: dict[str, tuple[Decimal, str]] = field(default_factory=dict)

    def lookup(self, key) -> tuple[Decimal, str]:
        if self.kind == "exact":
            return self.entries[str(key)]
        bands = sorted(((Decimal(k), v) for k, v in self.entries.items()), key=lambda kv: kv[0])
        match = [v for lower, v in bands if lower <= Decimal(key)]
        if not match:
            raise KeyError(key)
        return match[-1]


@dataclass
class RateTables:
    version_id: int
    version_label: str
    classes: dict[str, dict]  # class_code -> {description, base_rate, min_premium}
    factors: dict[str, FactorTable]
    parameters: dict[str, Decimal]


class WorksheetLine(BaseModel):
    step: str
    detail: str
    factor: Decimal | None = None
    premium: Decimal


class RatingResult(BaseModel):
    rate_version_id: int
    rate_version: str
    class_description: str
    premium: Decimal
    minimum_premium_applied: bool
    policy_fee: Decimal
    surplus_lines_tax: Decimal
    surplus_lines_tax_rate: Decimal
    total: Decimal
    worksheet: list[WorksheetLine]


def _money(x: Decimal) -> Decimal:
    return x.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def rate(tables: RateTables, inp: RatingInput) -> RatingResult:
    cls = tables.classes.get(inp.class_code)
    if cls is None:
        raise RatingError(f"Class code {inp.class_code} is not rated in version {tables.version_label}")

    lines: list[WorksheetLine] = []
    premium = cls["base_rate"] * inp.gross_receipts / 1000
    lines.append(WorksheetLine(
        step="Base premium",
        detail=f"{cls['description']}: ${Decimal(cls['base_rate']):.2f} per $1,000 × ${inp.gross_receipts:,.0f} receipts",  # UX-030
        premium=_money(premium),
    ))

    def apply(step: str, factor: Decimal, detail: str):
        nonlocal premium
        premium = premium * factor
        lines.append(WorksheetLine(step=step, detail=detail, factor=factor, premium=_money(premium)))

    def factor(name: str, key) -> tuple[Decimal, str]:
        try:
            return tables.factors[name].lookup(key)
        except KeyError:
            raise RatingError(f"No {name} factor for {key!r} in version {tables.version_label}") from None

    territories = [(factor("territory", s.upper()), s.upper()) for s in inp.states]
    (t_value, t_label), t_state = max(territories, key=lambda t: t[0][0])
    apply("Territory", t_value, f"{t_label} (highest of {', '.join(s for _, s in territories)})")

    ilf_key = f"{inp.occurrence_limit}/{inp.aggregate_limit}"
    value, label = factor("ilf", ilf_key)
    apply("Increased limits", value, label)

    for step, name, key in [
        ("Deductible", "deductible", inp.deductible),
        ("Residential exposure", "residential_pct", inp.residential_pct),
        ("Subcontracted work", "subcontracted_pct", inp.subcontracted_pct),
        ("Working height", "height_ft", inp.max_height_ft),
    ]:
        value, label = factor(name, key)
        apply(step, value, label)

    if inp.subcontracted_pct > 0 and not inp.subcontractor_coi_required:
        value, label = factor("no_sub_coi", "true")
        apply("Uninsured subcontractors", value, label)

    p = tables.parameters
    for step, mod, lo, hi in [
        ("Experience mod", inp.experience_mod, "experience_mod_min", "experience_mod_max"),
        ("Schedule mod", inp.schedule_mod, "schedule_mod_min", "schedule_mod_max"),
    ]:
        if lo not in p or hi not in p:
            raise RatingError(f"Rate version {tables.version_label} has no {step.lower()} bounds ({lo}/{hi})")
        if not p[lo] <= mod <= p[hi]:
            raise RatingError(f"{step} {mod} is outside the allowed range {p[lo]}–{p[hi]}")
        apply(step, mod, "Underwriter-selected" if mod != 1 else "None applied")

    premium = _money(premium)
    min_applied = premium < cls["min_premium"]
    if min_applied:
        premium = _money(cls["min_premium"])
        lines.append(WorksheetLine(step="Minimum premium", detail=f"Class minimum ${cls['min_premium']:,.0f}", premium=premium))

    fee = _money(p.get("policy_fee", Decimal(0)))
    tax_key = f"sl_tax.{inp.home_state.upper()}"
    if tax_key not in p:
        raise RatingError(f"No surplus lines tax rate for home state {inp.home_state}")
    tax_rate = p[tax_key]
    tax = _money((premium + fee) * tax_rate)

    return RatingResult(
        rate_version_id=tables.version_id,
        rate_version=tables.version_label,
        class_description=cls["description"],
        premium=premium,
        minimum_premium_applied=min_applied,
        policy_fee=fee,
        surplus_lines_tax=tax,
        surplus_lines_tax_rate=tax_rate,
        total=premium + fee + tax,
        worksheet=lines,
    )
