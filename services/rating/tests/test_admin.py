"""Rate-table admin API: draft → edit → impact → activate, with audit."""
import pytest

from tests.test_api import ELECTRICAL

USER = {"X-User": "pat.actuary"}


def test_admin_page(client):
    res = client.get("/admin")
    assert res.status_code == 200 and "Rate tables" in res.text


def test_active_version_is_read_only(client):
    res = client.put("/admin/api/versions/1/factors/territory", json={"entries": [{"key": "TX", "value": 1.2}]})
    assert res.status_code == 409


@pytest.fixture
def restore_active_version(client):
    """Put 2026.1 back as the active version so other tests see the seeded rates."""
    yield
    from app.db import pool

    with pool.connection() as conn:
        conn.execute("UPDATE rate_versions SET status = 'retired' WHERE status = 'active'")
        conn.execute("UPDATE rate_versions SET status = 'active' WHERE id = 1")


def test_draft_edit_impact_activate(client, restore_active_version):
    draft = client.post("/admin/api/versions", json={"label": "2026.2", "notes": "Texas +10%"}, headers=USER)
    assert draft.status_code == 201, draft.text
    body = draft.json()
    vid = body["version"]["id"]
    assert body["version"]["status"] == "draft" and body["version"]["based_on"] == 1
    territory = body["factors"]["territory"]["entries"]
    assert len(territory) == 11

    # Saving an unchanged table is a no-op
    same = client.put(f"/admin/api/versions/{vid}/factors/territory", json={"entries": territory}, headers=USER)
    assert same.json() == {"changed": False, "summary": None}

    edited = [e | {"value": "1.21"} if e["key"] == "TX" else e for e in territory]
    res = client.put(f"/admin/api/versions/{vid}/factors/territory", json={"entries": edited}, headers=USER)
    assert res.status_code == 200, res.text
    assert res.json()["summary"] == "TX: 1.1 → 1.21"

    # Only the Texas risk moves, by exactly 10%
    impact = client.get(f"/admin/api/versions/{vid}/impact").json()
    changed = {r["case"]: r["change_pct"] for r in impact["risks"] if r["change_pct"]}
    assert changed == {"01-lone-star-electric": 10.0}
    assert all(r["error"] is None for r in impact["risks"])

    # Draft can be rated explicitly before activation; the active version is unchanged
    pinned = client.post("/rate", json=ELECTRICAL | {"rate_version_id": vid}).json()
    assert pinned["rate_version"] == "2026.2"
    assert client.post("/rate", json=ELECTRICAL).json()["premium"] == "49738"

    res = client.post(f"/admin/api/versions/{vid}/activate", headers=USER)
    assert res.json()["summary"] == "Activated 2026.2, retiring 2026.1"
    # 49,738.26 × 1.21/1.10 = 54,712.09
    assert client.post("/rate", json=ELECTRICAL).json()["premium"] == "54712"
    statuses = {v["label"]: v["status"] for v in client.get("/admin/api/versions").json()}
    assert statuses == {"2026.1": "retired", "2026.2": "active"}

    trail = client.get("/admin/api/audit", params={"version_id": vid}).json()
    assert [a["action"] for a in trail] == ["activate", "update_table", "create_draft"]
    assert {a["actor"] for a in trail} == {"pat.actuary"}
    assert trail[1]["target"] == "factor:territory"


def test_validation(client):
    vid = client.post("/admin/api/versions", json={"label": "bad-edits"}).json()["version"]["id"]
    url = f"/admin/api/versions/{vid}"
    assert client.post("/admin/api/versions", json={"label": "bad-edits"}).status_code == 409
    assert client.put(f"{url}/factors/deductible", json={"entries": [{"key": "abc", "value": 1}]}).status_code == 422
    assert client.put(f"{url}/factors/territory", json={"entries": [{"key": "TX", "value": 0}]}).status_code == 422
    assert client.put(f"{url}/factors/nope", json={"entries": [{"key": "1", "value": 1}]}).status_code == 404
    params = client.get(url).json()["parameters"]
    bad = [p | {"value": "1.1"} if p["name"] == "schedule_mod_min" else p for p in params]
    assert client.put(f"{url}/parameters", json={"entries": bad}).status_code == 422

    classes = client.get(url).json()["classes"]
    res = client.put(f"{url}/classes", json={"entries": classes[:-1]})
    assert res.json()["summary"] == f"removed {classes[-1]['class_code']}"
    # Removing a class shows up as an unrateable risk in the impact preview
    assert any(r["error"] for r in client.get(f"{url}/impact").json()["risks"])
