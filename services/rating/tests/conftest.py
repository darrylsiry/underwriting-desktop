"""Shared fixture: the API on a throwaway `rating_test` DB, migrated and seeded once per run."""
import os

import psycopg
import pytest

ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL", "postgresql://uw:uw@localhost:5432/postgres")
TEST_DB = "rating_test"


@pytest.fixture(scope="session")
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
