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


def test_a_non_ascii_bearer_token_is_refused_not_a_crash(client, monkeypatch):
    """CR-110: compare_digest raises on a non-ASCII str, which was a 500 here and lost the rating on /rate."""
    monkeypatch.setenv("RATING_ADMIN_TOKEN", "s3cret")
    bad = {"Authorization": "Bearer \u00e9".encode("latin-1")}
    assert client.get("/admin", headers=bad).status_code == 401
    assert client.post("/rate-versions", json={"label": "nope"}, headers=bad).status_code == 401
    res = client.post("/rate", json=ELECTRICAL, headers=bad | {"x-uw-user": "mallory"})
    assert res.status_code == 200
    assert client.get(f"/ratings/{res.json()['rating_id']}").json()["requested_by"] == "anonymous"


def test_acting_user_is_percent_decoded(client):
    """CR-072: the web app percent-encodes the name, so a name outside Latin-1 fits in the header."""
    res = client.post("/rate", json=ELECTRICAL, headers={"x-uw-user": "%C5%81ukasz%20K%0D%0A"})
    assert client.get(f"/ratings/{res.json()['rating_id']}").json()["requested_by"] == "Łukasz K"


def test_unknown_time_zone_is_refused_not_a_500(client):
    """CR-094: the pattern lets a misspelt zone through; it must not reach AT TIME ZONE."""
    for path in ("/ratings", "/rate-table-audit"):
        assert client.get(path, params={"tz": "Not/AZone"}).status_code == 422
        assert client.get(path, params={"tz": "America/NewYork", "since": "2026-01-01"}).status_code == 422
        assert client.get(path, params={"tz": "America"}).status_code == 422
        assert client.get(path, params={"tz": "America/New_York"}).status_code == 200
        assert client.get(path).status_code == 200


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


def test_reference_prefix_is_one_reference_and_not_its_lookalikes(client):
    """CR-045: SUB-7000 also matched SUB-70001, and % and _ acted as wildcards."""
    for reference in ("SUB-7000", "SUB-7000 (expiring rates)", "SUB-70001", "SUBX7000"):
        client.post("/rate", json=ELECTRICAL | {"reference": reference})

    def found(prefix):
        return {r["reference"] for r in client.get("/ratings", params={"reference_prefix": prefix}).json()}

    assert found("SUB-7000") == {"SUB-7000", "SUB-7000 (expiring rates)"}
    assert found("SUB-700") == set()
    assert found("SUB_7000") == set() and found("SUB-70%") == set()


def test_ratings_feed_honours_a_day_range(client):
    """UX-044: since/until are wall-clock bounds in the given zone; a range in the future returns nothing,
    an open range returns the rows, and a malformed bound is refused."""
    assert client.get("/ratings", params={"since": "2999-01-01T00:00:00", "tz": "America/New_York"}).json() == []
    assert client.get("/ratings", params={"until": "2999-01-01T23:59:59.999", "tz": "America/New_York"}).status_code == 200
    assert client.get("/rate-table-audit", params={"since": "2999-01-01", "tz": "UTC"}).json() == []
    assert client.get("/ratings", params={"since": "yesterday"}).status_code == 422
    assert client.get("/ratings", params={"tz": "Not a zone;drop"}).status_code == 422


def test_feeds_page_below_an_exact_instant(client):
    """CR-095: `before` is exclusive and carries its zone, so a page's last row isn't repeated on the next."""
    client.post("/rate", json=ELECTRICAL | {"reference": "Q-2026-8888 v1"})
    family = {"reference_prefix": "Q-2026-8888"}
    at = client.get("/ratings", params=family).json()[0]["created_at"]
    assert client.get("/ratings", params=family | {"before": at}).json() == []
    assert len(client.get("/ratings", params=family | {"before": "2999-01-01T00:00:00Z"}).json()) == 1
    assert client.get("/rate-table-audit", params={"before": "1970-01-01T00:00:00+00:00"}).json() == []
    assert client.get("/rate-table-audit", params={"before": "2999-01-01T00:00:00Z"}).status_code == 200
    for bad in ("2026-02-30T00:00:00Z", "2026-01-01T00:00:00", "yesterday"):
        assert client.get("/ratings", params={"before": bad}).status_code == 422, bad


def test_feeds_refuse_a_date_that_is_not_on_the_calendar(client):
    """CR-068: it fits the pattern, so it used to reach the ::timestamp cast and come back as a 500."""
    assert client.get("/ratings", params={"since": "2026-02-30T00:00:00"}).status_code == 422
    assert client.get("/ratings", params={"until": "2026-02-30"}).status_code == 422
    assert client.get("/rate-table-audit", params={"since": "2026-02-30"}).status_code == 422
    assert client.get("/rate-table-audit", params={"until": "2026-13-01T00:00:00"}).status_code == 422


def test_gross_receipts_past_the_cap_are_a_refused_input_not_a_fault(client):
    """CR-150: 1e31 overflowed the money arithmetic into a 500; a smaller typo overflowed quotes.premium at issue."""
    res = client.post("/rate", json=ELECTRICAL | {"gross_receipts": 1e31}, headers=AS_TEST)
    assert res.status_code == 422
    assert client.post("/rate", json=ELECTRICAL | {"gross_receipts": 10_000_000_000}, headers=AS_TEST).status_code == 200
