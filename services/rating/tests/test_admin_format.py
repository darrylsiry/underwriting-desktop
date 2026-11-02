"""Display helpers of the /admin UI: number formatting per kind of value (UX-019) and timestamps in one
named zone (UX-006). No database needed."""
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.admin import audit_kind, audit_value, diff_summary, num, value_kind, when


@pytest.mark.parametrize("value, kind, expected", [
    ("1.0000", "factor", "1.00"), ("0.9", "factor", "0.90"), (Decimal("1.35"), "factor", "1.35"),
    ("1.125", "factor", "1.125"),                       # never rounds a value away
    ("9.4000", "rate", "9.40"), ("22", "rate", "22.00"),
    ("2500.00", "amount", "2500"), (Decimal("250"), "amount", "250"), ("2500.50", "amount", "2500.50"),
    ("0.0300", "tax", "0.0300"), ("0.0489", "tax", "0.0489"), ("0.05", "tax", "0.0500"),
    ("9.4000", None, "9.4"), ("1.0000", None, "1"),     # no kind: the old behaviour, trailing zeros dropped
    (None, "factor", ""), ("", "factor", ""), ("abc", "factor", "abc"), ("Infinity", "rate", "Infinity"),
])
def test_num_aligns_decimals_per_kind(value, kind, expected):
    assert num(value, kind) == expected


def test_value_kind_follows_how_the_engine_uses_the_value():
    assert value_kind("class", ("98677",), "base_rate") == "rate"
    assert value_kind("class", ("98677",), "min_premium") == "amount"
    assert value_kind("factor", ("territory", "FL"), "value") == "factor"
    assert value_kind("parameter", ("policy_fee",), "value") == "amount"
    assert value_kind("parameter", ("schedule_mod_min",), "value") == "factor"
    assert value_kind("parameter", ("sl_tax.FL",), "value") == "tax"


def test_audit_kind_reads_the_audit_row():
    assert audit_kind({"action": "update_class", "entity": "class:98677"}, "min_premium") == "amount"
    assert audit_kind({"action": "update_factor", "entity": "territory:FL"}, "value") == "factor"
    assert audit_kind({"action": "update_parameter", "entity": "sl_tax.FL"}, "value") == "tax"
    assert audit_kind({"action": "update_parameter", "entity": "policy_fee"}, "value") == "amount"


def test_audit_value_formats_numbers_and_leaves_version_labels_alone():
    """CR-039: an activation's before/after are version labels, so 2026.10 must not become 2026.1."""
    activation = {"action": "activate"}
    assert audit_value("2026.10", activation, "active") == "2026.10"
    assert audit_value(None, activation, "active") == ""   # the first activation had nothing before it
    assert audit_value("1.2000", {"action": "update_factor", "entity": "territory:FL"}, "value") == "1.20"


def test_when_renders_in_display_tz(monkeypatch):
    t = datetime(2026, 10, 23, 1, 55, tzinfo=timezone.utc)   # 21:55 the evening before in New York
    monkeypatch.delenv("DISPLAY_TZ", raising=False)
    assert when(t) == "Oct 22, 2026, 9:55 PM EDT"
    monkeypatch.setenv("DISPLAY_TZ", "Europe/London")
    assert when(t) == "Oct 23, 2026, 2:55 AM BST"
    monkeypatch.setenv("DISPLAY_TZ", "Not/AZone")
    assert when(t) == "Oct 23, 2026, 1:55 AM UTC"   # a bad setting still labels the zone rather than failing
    assert when(None) == ""
    assert when(datetime(2026, 10, 23, 1, 55)) == when(t)   # a naive value is taken as UTC


def test_diff_summary_names_the_differences():
    v, a = {"label": "2026.3"}, {"label": "2026.2"}
    one = [{"section": "Territory", "key": "FL", "label": "Florida", "column": "", "active": Decimal("1.25"),
            "draft": Decimal("1.35"), "fmt": "factor"}]
    text = diff_summary(v, a, one)
    assert text.startswith("Activate 2026.3? 1 value differs from active 2026.2:") and "Territory FL: 1.25 -> 1.35" in text
    assert "no differences from active 2026.2" in diff_summary(v, a, [])
    assert "no active version" in diff_summary(v, None, [])
    many = one * 10
    assert "and 2 more" in diff_summary(v, a, many)


def test_audit_kind_leaves_version_labels_alone():
    """UX-027: an activate row holds version labels, not factors: 2026.1 stays 2026.1, never 2026.10."""
    from app.admin import audit_kind, num

    row = {"action": "activate", "entity": "version:2", "before": {"active": "2026.1"}, "after": {"active": "2026.2"}}
    assert audit_kind(row, "active") is None
    assert num("2026.1", audit_kind(row, "active")) == "2026.1"
    assert audit_kind({"action": "update_factor", "entity": "territory:FL"}, "value") == "factor"
