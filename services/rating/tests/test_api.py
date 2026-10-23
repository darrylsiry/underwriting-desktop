"""API tests against a real Postgres (the seeded 2026.1 rates).

Needs TEST_DATABASE_ADMIN_URL (default: the docker compose db); skipped if unreachable.
"""
import os

import psycopg
import pytest

ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL", "postgresql://uw:uw@localhost:5432/postgres")
TEST_DB = "rating_test"


@pytest.fixture(scope="module")
def client():
    try:
        with psycopg.connect(ADMIN_URL, autocommit=True, connect_timeout=3) as conn:
            conn.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
            conn.execute(f"CREATE DATABASE {TEST_DB}")
    except psycopg.OperationalError:
        pytest.skip("Postgres not available")
    os.environ["DATABASE_URL"] = ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


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


def test_unknown_class_is_422(client):
    assert client.post("/rate", json=ELECTRICAL | {"class_code": "00000"}).status_code == 422


def test_classes(client):
    codes = [c["class_code"] for c in client.get("/classes").json()]
    assert "98677" in codes and len(codes) == 8
