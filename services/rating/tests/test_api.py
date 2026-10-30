"""API tests against the seeded 2026.1 rates (client fixture in conftest.py)."""


ELECTRICAL = {
    "class_code": "92215", "gross_receipts": 6_800_000, "states": ["TX"], "home_state": "TX",
    "occurrence_limit": 1_000_000, "aggregate_limit": 2_000_000, "deductible": 5000,
    "residential_pct": 0, "subcontracted_pct": 10, "subcontractor_coi_required": True, "max_height_ft": 30,
    "reference": "sub-001", "requested_by": "test",
}


def test_rate_and_log(client):
    res = client.post("/rate", json=ELECTRICAL)
    assert res.status_code == 200, res.text
    body = res.json()
    # 6.50 × 6,800 = 44,200 × 1.10 TX × 1.00 ILF × 0.93 ded × 1.10 height = 49,738.26
    assert body["premium"] == "49738"
    assert body["rate_version"] == "2026.1"
    logged = client.get(f"/ratings/{body['rating_id']}").json()
    assert logged["reference"] == "sub-001"


def test_rated_at_backdates_the_log_entry(client):
    res = client.post("/rate", json=ELECTRICAL | {"reference": "SUB-0099", "rated_at": "2026-03-30T18:13:00Z"})
    assert res.status_code == 200, res.text
    logged = client.get(f"/ratings/{res.json()['rating_id']}").json()
    assert logged["created_at"].startswith("2026-03-30T18:13:00")
    assert "rated_at" not in logged["request"]


def test_unknown_class_is_422(client):
    assert client.post("/rate", json=ELECTRICAL | {"class_code": "00000"}).status_code == 422


def test_classes(client):
    codes = [c["class_code"] for c in client.get("/classes").json()]
    assert "98677" in codes and len(codes) == 8


def test_bad_rating_id_is_422_not_500(client):
    assert client.get("/ratings/not-a-uuid").status_code == 422
    assert client.get("/ratings/00000000-0000-0000-0000-000000000000").status_code == 404


def test_list_ratings_filters_by_reference(client):
    client.post("/rate", json=ELECTRICAL | {"reference": "Q-2026-9999 v1"})
    rows = client.get("/ratings", params={"reference_prefix": "Q-2026-9999"}).json()
    assert len(rows) == 1 and rows[0]["reference"] == "Q-2026-9999 v1" and rows[0]["total"]
    assert rows[0]["rate_version"] == "2026.1" and rows[0]["class_code"] == "92215"
    assert client.get("/ratings", params={"limit": 0}).status_code == 422
