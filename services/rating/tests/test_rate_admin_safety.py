"""Rate-table admin when things go wrong: stale pages, values a column can't hold, lost races.

Runs after test_rate_admin.py, whose tests count versions, and makes its own drafts from the seeded
2026.1 (territory FL 1.25, TX 1.10).
"""
import itertools

from tests.test_rate_admin import AS_PAT, edit

_labels = itertools.count(1)


def new_draft(client, label: str | None = None) -> int:
    res = client.post("/rate-versions", json={"label": label or f"safety.{next(_labels)}", "based_on": 1}, headers=AS_PAT)
    assert res.status_code == 201, res.text
    return res.json()["id"]


def factor(client, version_id: int, key: str = "FL") -> float:
    factors = client.get(f"/rate-versions/{version_id}").json()["factors"]
    return next(f["value"] for f in factors if f["factor"] == "territory" and f["key"] == key)


def update_rows(client, version_id: int) -> list[dict]:
    rows = client.get("/rate-table-audit", params={"version_id": version_id}).json()
    return [a for a in rows if a["action"].startswith("update_")]


def save_territory(client, version_id: int, reason: str = "because", **cells):
    """Post the territory section as the form does: `FL=(typed, what the page showed)` per cell."""
    data = {"reason": reason, "actor": "sam"}
    for key, (typed, was) in cells.items():
        data[f"factor|territory|{key}|value"] = typed
        data[f"factor|territory|{key}|value|was"] = was
    return client.post(f"/admin/versions/{version_id}/sections/territory", data=data, follow_redirects=False)


def test_the_form_carries_what_the_page_showed(client):
    vid = new_draft(client)
    page = client.get(f"/admin/versions/{vid}?section=territory").text
    assert 'name="factor|territory|FL|value|was" value="1.2500"' in page


def test_saving_leaves_a_colleagues_change_alone(client):
    """CR-052: FL moved after this page loaded. Saving TX must not write the stale FL back or audit it as ours."""
    vid = new_draft(client)
    assert edit(client, vid, key="FL", value=1.35).json() == {"changed": 1}

    res = save_territory(client, vid, reason="TX only", FL=("1.25", "1.2500"), TX=("1.2", "1.1000"))
    assert res.status_code == 303 and "Saved+1+change" in res.headers["location"]
    assert factor(client, vid, "FL") == 1.35 and factor(client, vid, "TX") == 1.2
    assert [(a["entity"], a["actor"]) for a in update_rows(client, vid)] == [("territory:TX", "sam"), ("territory:FL", "pat")]


def test_changing_a_cell_someone_else_changed_is_refused(client):
    """CR-052: a real edit from a stale page is refused, keeps the typed values, and stays refused on retry."""
    vid = new_draft(client)
    edit(client, vid, key="FL", value=1.35)

    for _ in range(2):
        res = save_territory(client, vid, FL=("1.30", "1.2500"), TX=("1.2", "1.1000"))
        assert res.status_code == 422 and "changed by someone else" in res.text
        assert factor(client, vid, "FL") == 1.35 and factor(client, vid, "TX") == 1.1   # nothing saved, TX included
        assert 'value="1.30"' in res.text and 'name="factor|territory|FL|value|was" value="1.2500"' in res.text
    # The way out: this page was re-rendered at the POST url, and its section links still reach the real page.
    assert f'href="/admin/versions/{vid}?section=territory"' in res.text
    assert client.get(f"/admin/versions/{vid}?section=territory").status_code == 200

    # Both people chose the same value: nothing to do and nothing to refuse.
    res = save_territory(client, vid, FL=("1.35", "1.2500"))
    assert res.status_code == 303 and "Nothing+changed" in res.headers["location"]


def test_a_failed_save_does_not_refresh_what_the_page_showed(client):
    """CR-052: FL moved, then this user's save failed for another reason. Their retry still must not revert FL."""
    vid = new_draft(client)
    edit(client, vid, key="FL", value=1.35)

    res = save_territory(client, vid, reason="", FL=("1.25", "1.2500"), TX=("1.2", "1.1000"))
    assert res.status_code == 422 and 'name="factor|territory|FL|value|was" value="1.2500"' in res.text
    assert save_territory(client, vid, FL=("1.25", "1.2500"), TX=("1.2", "1.1000")).status_code == 303
    assert factor(client, vid, "FL") == 1.35 and factor(client, vid, "TX") == 1.2


def test_a_value_with_more_decimals_than_its_column_is_refused(client):
    """CR-105: Postgres would round 1.12345 to 1.1235 while the audit row said 1.12345."""
    vid = new_draft(client)
    res = edit(client, vid, key="FL", value=1.12345)
    assert res.status_code == 422 and "at most 4 decimals" in res.json()["detail"]
    assert edit(client, vid, key="FL", value=1.12345).status_code == 422   # no further audit rows on a repeat
    assert factor(client, vid, "FL") == 1.25 and update_rows(client, vid) == []

    res = client.post(f"/rate-versions/{vid}/edits", headers=AS_PAT, json={"reason": "cents", "edits": [
        {"kind": "class", "class_code": "92215", "min_premium": 2500.555}]})
    assert res.status_code == 422 and "min premium" in res.json()["detail"] and "at most 2 decimals" in res.json()["detail"]

    res = save_territory(client, vid, FL=("1.12345", "1.2500"))
    assert res.status_code == 422 and "at most 4 decimals" in res.text and 'value="1.12345"' in res.text


def test_trailing_zeros_past_the_scale_are_not_extra_decimals(client):
    vid = new_draft(client)
    res = client.post(f"/rate-versions/{vid}/edits", headers=AS_PAT, json={"reason": "zeros", "edits": [
        {"kind": "factor", "factor": "territory", "key": "FL", "value": "1.300000"}]})
    assert res.json() == {"changed": 1}
    assert factor(client, vid, "FL") == 1.3
    assert edit(client, vid, key="FL", value=1.3).json() == {"changed": 0}


def test_a_value_too_large_for_its_column_is_refused(client):
    """CR-032: numeric(8,4) overflows at 10,000, and the DataError was a 500 from the UI and the API."""
    vid = new_draft(client)
    res = edit(client, vid, key="FL", value=100000)
    assert res.status_code == 422 and "below 10,000" in res.json()["detail"]
    assert edit(client, vid, key="FL", value=9999.9999).json() == {"changed": 1}   # the largest it holds
    assert edit(client, vid, key="FL", value="Infinity").status_code == 422

    res = client.post(f"/rate-versions/{vid}/edits", headers=AS_PAT, json={"reason": "big", "edits": [
        {"kind": "class", "class_code": "92215", "base_rate": 1000000}]})
    assert res.status_code == 422 and "below 1,000,000" in res.json()["detail"]

    res = save_territory(client, vid, TX=("100000", "1.1000"))
    assert res.status_code == 422 and "below 10,000" in res.text and 'value="100000.00"' in res.text


def test_text_postgres_cannot_store_is_refused_not_a_500(client):
    """CR-032: whatever else Postgres refuses as data (a NUL in a reason) is the caller's error as well."""
    vid = new_draft(client)
    assert edit(client, vid, key="FL", value=1.3, reason="bad\x00reason").status_code == 422
    assert factor(client, vid, "FL") == 1.25


def test_activating_shows_a_two_digit_label_whole(client):
    """CR-039: the audit's Change column showed 2026.10 as 2026.1."""
    vid = new_draft(client, "2026.10")
    assert client.post(f"/rate-versions/{vid}/activate", json={"reason": "go"}, headers=AS_PAT).status_code == 200
    assert "→ <strong>2026.10</strong>" in client.get(f"/admin/versions/{vid}").text


def test_a_name_outside_latin1_saves_and_is_remembered(client):
    """CR-057: the cookie can't carry Ł as is, and the 500 came after the change had been committed."""
    vid = new_draft(client)
    try:
        res = client.post(f"/admin/versions/{vid}/sections/territory", follow_redirects=False, data={
            "factor|territory|TX|value": "1.2", "reason": "from Gdansk", "actor": "Łukasz"})
        assert res.status_code == 303
        assert update_rows(client, vid)[0]["actor"] == "Łukasz"
        assert 'name="actor" value="Łukasz"' in client.get(f"/admin/versions/{vid}").text
    finally:
        client.cookies.clear()
