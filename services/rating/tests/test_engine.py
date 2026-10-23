from decimal import Decimal as D

import pytest

from app.engine import FactorTable, RateTables, RatingError, RatingInput, rate


@pytest.fixture
def tables():
    def band(**kv):
        return FactorTable("band", {k.lstrip("_"): (D(str(v)), k) for k, v in kv.items()})

    return RateTables(
        version_id=1,
        version_label="test",
        classes={"92215": {"description": "Electrical", "base_rate": D("6.50"), "min_premium": D("2500")}},
        factors={
            "territory": FactorTable("exact", {"TX": (D("1.10"), "Texas"), "OK": (D("0.95"), "Oklahoma")}),
            "ilf": FactorTable("exact", {"1000000/2000000": (D("1.00"), "$1M/$2M")}),
            "deductible": band(_0=1.00, _5000=0.93),
            "residential_pct": band(_0=1.00, _76=1.20),
            "subcontracted_pct": band(_0=1.00, _50=1.10),
            "height_ft": band(_0=1.00, _30=1.10),
            "no_sub_coi": FactorTable("exact", {"true": (D("1.25"), "No COIs")}),
        },
        parameters={
            "schedule_mod_min": D("0.75"), "schedule_mod_max": D("1.25"),
            "experience_mod_min": D("0.80"), "experience_mod_max": D("1.50"),
            "policy_fee": D("250"), "sl_tax.TX": D("0.0489"),
        },
    )


def make(**overrides):
    base = dict(class_code="92215", gross_receipts=1_000_000, states=["TX"], home_state="TX",
                occurrence_limit=1_000_000, aggregate_limit=2_000_000)
    return RatingInput(**(base | overrides))


def test_base_case(tables):
    r = rate(tables, make())
    # 6.50 × 1,000 × 1.10 territory = 7,150
    assert r.premium == D("7150")
    assert r.policy_fee == D("250")
    assert r.surplus_lines_tax == D("362")  # (7150 + 250) × 4.89% = 361.86
    assert r.total == D("7762")
    assert [line.step for line in r.worksheet][:3] == ["Base premium", "Territory", "Increased limits"]


def test_worst_territory_applies(tables):
    r = rate(tables, make(states=["OK", "TX"]))
    assert r.worksheet[1].factor == D("1.10")


def test_bands_pick_largest_lower_bound(tables):
    r = rate(tables, make(deductible=7500, residential_pct=80, max_height_ft=35))
    factors = {line.step: line.factor for line in r.worksheet}
    assert factors["Deductible"] == D("0.93")
    assert factors["Residential exposure"] == D("1.20")
    assert factors["Working height"] == D("1.10")


def test_uninsured_subs_load_only_when_subbing(tables):
    with_subs = rate(tables, make(subcontracted_pct=60, subcontractor_coi_required=False))
    no_subs = rate(tables, make(subcontracted_pct=0, subcontractor_coi_required=False))
    assert "Uninsured subcontractors" in [line.step for line in with_subs.worksheet]
    assert "Uninsured subcontractors" not in [line.step for line in no_subs.worksheet]


def test_minimum_premium(tables):
    r = rate(tables, make(gross_receipts=100_000))
    assert r.minimum_premium_applied and r.premium == D("2500")


def test_schedule_mod_bounds(tables):
    assert rate(tables, make(schedule_mod=D("0.80"))).premium == D("5720")
    with pytest.raises(RatingError, match="outside the allowed range"):
        rate(tables, make(schedule_mod=D("0.60")))


@pytest.mark.parametrize("field,value,msg", [
    ("class_code", "99999", "Class code 99999"),
    ("states", ["ZZ"], "territory"),
    ("occurrence_limit", 5_000_000, "ilf"),
])
def test_unrateable_inputs(tables, field, value, msg):
    with pytest.raises(RatingError, match=msg):
        rate(tables, make(**{field: value}))
