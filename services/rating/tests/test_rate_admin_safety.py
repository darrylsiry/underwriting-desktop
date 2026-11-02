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
