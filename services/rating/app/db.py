"""Database access for the rating service (owns the `rating` database)."""
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_LOCK = 72_700_101

pool = ConnectionPool(
    os.environ.get("DATABASE_URL", "postgresql://uw:uw@localhost:5432/rating"),
    kwargs={"row_factory": dict_row},
    open=False,
)


def _migration_connection():
    """The owner's connection when MIGRATION_DATABASE_URL is set, for installs whose runtime role can't change the schema (CR-096)."""
    url = os.environ.get("MIGRATION_DATABASE_URL")
    return psycopg.connect(url, row_factory=dict_row) if url else pool.connection()


def migrate() -> None:
    """Apply any migrations/*.sql files not yet recorded, in filename order, one starting instance at a time (CR-038)."""
    with _migration_connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))  # held until this transaction, the whole pass, commits
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in applied:
                continue
            conn.execute(path.read_text())
            conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
