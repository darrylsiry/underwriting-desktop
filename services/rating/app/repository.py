"""Loads rate tables from the rating DB and records rating calls."""
from psycopg.types.json import Jsonb

from app.db import pool
from app.engine import FactorTable, RateTables


def active_version_id() -> int:
    with pool.connection() as conn:
        row = conn.execute("SELECT id FROM rate_versions WHERE status = 'active'").fetchone()
    if row is None:
        raise LookupError("No active rate version")
    return row["id"]


def load_tables(version_id: int | None = None) -> RateTables:
    version_id = version_id or active_version_id()
    with pool.connection() as conn:
        version = conn.execute("SELECT id, label FROM rate_versions WHERE id = %s", (version_id,)).fetchone()
        if version is None:
            raise LookupError(f"Rate version {version_id} not found")
        classes = {
            r["class_code"]: {"description": r["description"], "base_rate": r["base_rate"], "min_premium": r["min_premium"]}
            for r in conn.execute("SELECT * FROM class_rates WHERE version_id = %s", (version_id,))
        }
        factors: dict[str, FactorTable] = {}
        for r in conn.execute("SELECT * FROM factors WHERE version_id = %s", (version_id,)):
            table = factors.setdefault(r["factor"], FactorTable(kind=r["kind"]))
            table.entries[r["key"]] = (r["value"], r["label"])
        parameters = {
            r["name"]: r["value"] for r in conn.execute("SELECT name, value FROM parameters WHERE version_id = %s", (version_id,))
        }
    return RateTables(version["id"], version["label"], classes, factors, parameters)


def log_rating(version_id: int, reference: str | None, requested_by: str, request: dict, result: dict) -> str:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO rating_log (version_id, reference, requested_by, request, result)"
            " VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (version_id, reference, requested_by, Jsonb(request), Jsonb(result)),
        ).fetchone()
    return str(row["id"])


def get_rating(rating_id: str) -> dict | None:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM rating_log WHERE id = %s", (rating_id,)).fetchone()


def list_versions() -> list[dict]:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM rate_versions ORDER BY id DESC").fetchall()
