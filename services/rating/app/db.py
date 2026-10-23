"""Database access for the rating service (owns the `rating` database)."""
import os
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

pool = ConnectionPool(
    os.environ.get("DATABASE_URL", "postgresql://uw:uw@localhost:5432/rating"),
    kwargs={"row_factory": dict_row},
    open=False,
)


def migrate() -> None:
    """Apply any migrations/*.sql files not yet recorded, in filename order."""
    with pool.connection() as conn:
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
