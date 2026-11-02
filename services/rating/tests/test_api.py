"""API tests against the seeded 2026.1 rates (client fixture in conftest.py)."""
import psycopg
import pytest


ELECTRICAL = {
    "class_code": "92215", "gross_receipts": 6_800_000, "states": ["TX"], "home_state": "TX",
    "occurrence_limit": 1_000_000, "aggregate_limit": 2_000_000, "deductible": 5000,
    "residential_pct": 0, "subcontracted_pct": 10, "subcontractor_coi_required": True, "max_height_ft": 30,
    "reference": "sub-001",
}
ON_SEEDED_RATES = ELECTRICAL | {"rate_version_id": 1}   # 2026.1 whatever is active: test_rate_admin.py activates a newer version (CR-014)
AS_TEST = {"x-uw-user": "test"}   # who is acting travels in a header (SEC-002)


def test_rate_and_log(client):
    res = client.post("/rate", json=ON_SEEDED_RATES, headers=AS_TEST)
    assert res.status_code == 200, res.text
    body = res.json()
    # 6.50 × 6,800 = 44,200 × 1.10 TX × 1.00 ILF × 0.93 ded × 1.10 height = 49,738.26
    assert body["premium"] == "49738"
    assert body["rate_version"] == "2026.1"
    logged = client.get(f"/ratings/{body['rating_id']}").json()
    assert logged["reference"] == "sub-001" and logged["requested_by"] == "test"


def test_requested_by_comes_from_the_header_not_the_body(client):
    """SEC-002: a body can't name the requester; without a trusted caller's header it is anonymous."""
    res = client.post("/rate", json=ELECTRICAL | {"requested_by": "mallory"})
    assert res.status_code == 200, res.text
    assert client.get(f"/ratings/{res.json()['rating_id']}").json()["requested_by"] == "anonymous"


def test_admin_token_gates_changes_and_the_acting_user(client, monkeypatch):
    """SEC-002: with RATING_ADMIN_TOKEN set, changing rate tables and naming the actor need the bearer token."""
    monkeypatch.setenv("RATING_ADMIN_TOKEN", "s3cret")
    assert client.post("/rate-versions", json={"label": "nope"}).status_code == 401
    assert client.post("/rate-versions", json={"label": "nope"}, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/admin").status_code == 401
    assert client.get("/admin", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    # /rate itself stays open, but an unproven x-uw-user is not believed
    res = client.post("/rate", json=ELECTRICAL, headers={"x-uw-user": "mallory"})
    assert client.get(f"/ratings/{res.json()['rating_id']}").json()["requested_by"] == "anonymous"
    res = client.post("/rate", json=ELECTRICAL, headers={"x-uw-user": "pat", "Authorization": "Bearer s3cret"})
    assert client.get(f"/ratings/{res.json()['rating_id']}").json()["requested_by"] == "pat"
    monkeypatch.setenv("FLY_APP_NAME", "uwdesk-rating")
    monkeypatch.delenv("RATING_ADMIN_TOKEN")
    assert client.post("/rate-versions", json={"label": "nope"}).status_code == 503   # fails closed on Fly without the secret


def test_rated_at_backdates_the_log_entry(client):
    res = client.post("/rate", json=ELECTRICAL | {"reference": "SUB-0099", "rated_at": "2026-03-30T18:13:00Z"})
    assert res.status_code == 200, res.text
    logged = client.get(f"/ratings/{res.json()['rating_id']}").json()
    assert logged["created_at"].startswith("2026-03-30T18:13:00")
    assert "rated_at" not in logged["request"]
    assert not logged["recorded_at"].startswith("2026-03-30"), "recorded_at shows when the row was really written"


def test_only_a_trusted_caller_can_backdate(client, monkeypatch):
    """CR-074: POST /rate is open, so a date from an unproven caller is ignored, and nobody can choose recorded_at."""
    monkeypatch.setenv("RATING_ADMIN_TOKEN", "s3cret")
    body = ELECTRICAL | {"rated_at": "2026-03-30T18:13:00Z", "recorded_at": "2020-01-01T00:00:00Z"}
    anon = client.get(f"/ratings/{client.post('/rate', json=body).json()['rating_id']}").json()
    assert not anon["created_at"].startswith("2026-03-30")
    held = client.post("/rate", json=body, headers={"Authorization": "Bearer s3cret"})
    logged = client.get(f"/ratings/{held.json()['rating_id']}").json()
    assert logged["created_at"].startswith("2026-03-30T18:13:00")
    assert not logged["recorded_at"].startswith("2020")


def test_recorded_at_cannot_be_set_or_changed(client):
    """CR-074: the database stamps it on insert whatever the statement says; the append-only trigger still refuses updates."""
    from app import db
    row = client.get(f"/ratings/{client.post('/rate', json=ELECTRICAL).json()['rating_id']}").json()
    with db.pool.connection() as conn:
        written = conn.execute(
            "INSERT INTO rating_log (version_id, requested_by, request, result, created_at, recorded_at)"
            " VALUES (%s, 'x', '{}', '{}', '2026-01-01', '2020-01-01') RETURNING created_at, recorded_at", (row["version_id"],),
        ).fetchone()
        conn.rollback()
    assert written["created_at"].year == 2026 and written["recorded_at"].year > 2020
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.pool.connection() as conn:
        conn.execute("UPDATE rating_log SET recorded_at = '2020-01-01' WHERE id = %s", (row["id"],))


def test_unknown_class_is_422(client):
    assert client.post("/rate", json=ELECTRICAL | {"class_code": "00000"}).status_code == 422


def test_classes(client):
    codes = [c["class_code"] for c in client.get("/classes").json()]
    assert "98677" in codes and len(codes) == 8


def test_bad_rating_id_is_422_not_500(client):
    assert client.get("/ratings/not-a-uuid").status_code == 422
    assert client.get("/ratings/00000000-0000-0000-0000-000000000000").status_code == 404


def test_list_ratings_filters_by_reference(client):
    client.post("/rate", json=ON_SEEDED_RATES | {"reference": "Q-2026-9999 v1"})
    rows = client.get("/ratings", params={"reference_prefix": "Q-2026-9999"}).json()
    assert len(rows) == 1 and rows[0]["reference"] == "Q-2026-9999 v1" and rows[0]["total"]
    assert rows[0]["rate_version"] == "2026.1" and rows[0]["class_code"] == "92215"
    assert client.get("/ratings", params={"limit": 0}).status_code == 422


def test_ratings_feed_honours_a_day_range(client):
    """UX-044: since/until are wall-clock bounds in the given zone; a range in the future returns nothing,
    an open range returns the rows, and a malformed bound is refused."""
    assert client.get("/ratings", params={"since": "2999-01-01T00:00:00", "tz": "America/New_York"}).json() == []
    assert client.get("/ratings", params={"until": "2999-01-01T23:59:59.999", "tz": "America/New_York"}).status_code == 200
    assert client.get("/rate-table-audit", params={"since": "2999-01-01", "tz": "UTC"}).json() == []
    assert client.get("/ratings", params={"since": "yesterday"}).status_code == 422
    assert client.get("/ratings", params={"tz": "Not a zone;drop"}).status_code == 422
