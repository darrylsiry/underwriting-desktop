"""Loads rate tables from the rating DB, records rating calls, and administers rate versions."""
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal

import psycopg
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


def log_rating(version_id: int, reference: str | None, requested_by: str, request: dict, result: dict, rated_at=None) -> str:
    """Record a rating call. `rated_at` back-dates the entry (seeded history); it defaults to now."""
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO rating_log (version_id, reference, requested_by, request, result, created_at)"
            " VALUES (%s, %s, %s, %s, %s, coalesce(%s, now())) RETURNING id",
            (version_id, reference, requested_by, Jsonb(request), Jsonb(result), rated_at),
        ).fetchone()
    return str(row["id"])


def get_rating(rating_id: str) -> dict | None:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM rating_log WHERE id = %s", (rating_id,)).fetchone()


def list_ratings(reference_prefix: str | None = None, limit: int = 200,
                 since: str | None = None, until: str | None = None, tz: str = "UTC") -> list[dict]:
    """Recent rating calls (summary only) for the audit timeline; optionally only one reference family.
    UX-044: `since`/`until` are wall-clock timestamps in `tz`, so a day range chosen in the desktop's zone
    reaches rows older than the newest `limit`."""
    with pool.connection() as conn:
        return conn.execute(
            "SELECT r.id, r.created_at, r.requested_by, r.reference, v.label AS rate_version,"
            " r.request->>'class_code' AS class_code, r.result->>'premium' AS premium, r.result->>'total' AS total"
            " FROM rating_log r JOIN rate_versions v ON v.id = r.version_id"
            " WHERE (%(p)s::text IS NULL OR r.reference LIKE %(p)s || '%%')"
            " AND (%(since)s::timestamp IS NULL OR r.created_at >= (%(since)s::timestamp AT TIME ZONE %(tz)s))"
            " AND (%(until)s::timestamp IS NULL OR r.created_at <= (%(until)s::timestamp AT TIME ZONE %(tz)s))"
            " ORDER BY r.created_at DESC LIMIT %(n)s",
            {"p": reference_prefix, "n": limit, "since": since, "until": until, "tz": tz},
        ).fetchall()


def list_versions() -> list[dict]:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM rate_versions ORDER BY id DESC").fetchall()


# --- Rate-table administration: drafts, edits, activation, audit -------------
# Only drafts can be edited. Activating a draft retires the active version, so
# rating never sees a half-edited table and every quote's version stays intact.

class VersionNotEditable(Exception):
    """The version isn't a draft (active and retired versions are frozen)."""


@dataclass
class Edit:
    kind: str                     # 'class' | 'factor' | 'parameter'
    ident: tuple[str, ...]        # (class_code,) | (factor, key) | (name,)
    values: dict[str, Decimal]    # column -> new value
    # column -> what the user's page showed (CR-052). Empty for API edits, which name only what they change.
    was: dict[str, Decimal] = field(default_factory=dict)


# kind -> (table, identifying columns, editable columns)
EDITABLE = {
    "class": ("class_rates", ("class_code",), ("base_rate", "min_premium")),
    "factor": ("factors", ("factor", "key"), ("value",)),
    "parameter": ("parameters", ("name",), ("value",)),
}

# (kind, column) -> numeric(precision, scale) of that column, from migrations/001_schema.sql.
COLUMN_SIZE = {
    ("class", "base_rate"): (10, 4),
    ("class", "min_premium"): (12, 2),
    ("factor", "value"): (8, 4),
    ("parameter", "value"): (12, 4),
}


def _entity(edit: Edit) -> str:
    return {"class": f"class:{edit.ident[0]}", "factor": ":".join(edit.ident), "parameter": edit.ident[0]}[edit.kind]


def _audit(conn, version_id: int, actor: str, action: str, entity=None, before=None, after=None, reason="") -> None:
    conn.execute(
        "INSERT INTO rate_table_audit (version_id, actor, action, entity, before, after, reason)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (version_id, actor, action, entity, Jsonb(before) if before is not None else None,
         Jsonb(after) if after is not None else None, reason),
    )


def _check_storable(edit: Edit, column: str, value: Decimal) -> None:
    """Refuse a value its column can't hold exactly. Postgres would raise on one too large (CR-032) and
    silently round one with too many decimals, leaving the audit naming a rate that never priced anything (CR-105)."""
    precision, scale = COLUMN_SIZE[(edit.kind, column)]
    what = f"{_entity(edit)}: {column.replace('_', ' ')}"
    if not value.is_finite():
        raise ValueError(f"{what} must be a number")
    if value <= 0:
        raise ValueError(f"{_entity(edit)}: values must be greater than zero")
    limit = 10 ** (precision - scale)
    if value >= limit:
        raise ValueError(f"{what} must be below {limit:,}")
    if round(value, scale) != value:
        raise ValueError(f"{what} can have at most {scale} decimals")


def _changes(edit: Edit, row: dict) -> dict[str, Decimal]:
    """The columns this edit really changes. CR-052: a cell left as the page showed it is not an edit, whatever
    the database holds now; a cell changed from a value that is no longer there is someone else's work."""
    changes = {}
    for column, value in edit.values.items():
        was = edit.was.get(column)
        if value == was or value == row[column]:
            continue
        if was is not None and was != row[column]:
            raise ValueError(f"{_entity(edit)}: {column.replace('_', ' ')} was changed by someone else after this page"
                             f" loaded (it is now {row[column]}). Nothing was saved: open the section again to see the"
                             " current values.")
        changes[column] = value
    return changes


@contextmanager
def _transaction():
    """One transaction. A value Postgres refuses as data (a NUL in a reason) is the caller's mistake, not a 500 (CR-032)."""
    try:
        with pool.connection() as conn:
            yield conn
    except psycopg.DataError as e:
        raise ValueError(f"That can't be stored: {e}") from e


def _lock_draft(conn, version_id: int) -> dict:
    version = conn.execute("SELECT * FROM rate_versions WHERE id = %s FOR UPDATE", (version_id,)).fetchone()
    if version is None:
        raise LookupError(f"Rate version {version_id} not found")
    if version["status"] != "draft":
        raise VersionNotEditable(f"Version {version['label']} is {version['status']}; only drafts can be changed")
    return version


def get_version(version_id: int) -> dict | None:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM rate_versions WHERE id = %s", (version_id,)).fetchone()


def _sort_key(key: str):
    try:
        return (0, tuple(Decimal(part) for part in key.split("/")))
    except ArithmeticError:
        return (1, key)


def version_rows(version_id: int) -> dict:
    """All rate-table rows of one version, in display order, for the admin UI and API."""
    with pool.connection() as conn:
        classes = conn.execute(
            "SELECT class_code, description, base_rate, min_premium FROM class_rates"
            " WHERE version_id = %s ORDER BY class_code", (version_id,)).fetchall()
        factors = conn.execute(
            "SELECT factor, kind, key, value, label FROM factors WHERE version_id = %s", (version_id,)).fetchall()
        parameters = conn.execute(
            "SELECT name, value, label FROM parameters WHERE version_id = %s ORDER BY name", (version_id,)).fetchall()
    factors.sort(key=lambda r: (r["factor"], _sort_key(r["key"])))
    return {"classes": classes, "factors": factors, "parameters": parameters}


LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")


def create_draft(base_version_id: int, label: str, notes: str, actor: str) -> int:
    """Copy every row of `base_version_id` into a new draft version."""
    if not LABEL_RE.match(label):
        raise ValueError("A version label is 1-32 letters, digits, dots, dashes or underscores (e.g. 2026.2)")
    with pool.connection() as conn:
        base = conn.execute("SELECT id, label FROM rate_versions WHERE id = %s", (base_version_id,)).fetchone()
        if base is None:
            raise LookupError(f"Rate version {base_version_id} not found")
        if conn.execute("SELECT 1 FROM rate_versions WHERE label = %s", (label,)).fetchone():
            raise ValueError(f"A version labelled {label} already exists")
        new_id = conn.execute(
            "INSERT INTO rate_versions (label, status, notes, created_by, based_on)"
            " VALUES (%s, 'draft', %s, %s, %s) RETURNING id",
            (label, notes, actor, base_version_id),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO class_rates (version_id, class_code, description, base_rate, min_premium)"
            " SELECT %s, class_code, description, base_rate, min_premium"
            " FROM class_rates WHERE version_id = %s", (new_id, base_version_id))
        conn.execute(
            "INSERT INTO factors (version_id, factor, kind, key, value, label)"
            " SELECT %s, factor, kind, key, value, label FROM factors WHERE version_id = %s",
            (new_id, base_version_id))
        conn.execute(
            "INSERT INTO parameters (version_id, name, value, label)"
            " SELECT %s, name, value, label FROM parameters WHERE version_id = %s",
            (new_id, base_version_id))
        _audit(conn, new_id, actor, "create_draft", after={"label": label, "based_on": base["label"]}, reason=notes)
    return new_id


def apply_edits(version_id: int, edits: list[Edit], actor: str, reason: str) -> int:
    """Apply edits to a draft in one transaction, auditing each changed row. Returns rows changed."""
    with _transaction() as conn:
        _lock_draft(conn, version_id)
        changed = 0
        for edit in edits:
            table, id_cols, value_cols = EDITABLE[edit.kind]
            if set(edit.values) - set(value_cols):
                raise ValueError(f"Can't edit {sorted(set(edit.values) - set(value_cols))} on {edit.kind}")
            where = " AND ".join(f"{c} = %s" for c in id_cols)
            row = conn.execute(
                f"SELECT {', '.join(value_cols)} FROM {table} WHERE version_id = %s AND {where}",
                (version_id, *edit.ident),
            ).fetchone()
            if row is None:
                raise LookupError(f"No {_entity(edit)} in this version")
            updates = _changes(edit, row)
            if not updates:
                continue
            for column, value in updates.items():
                _check_storable(edit, column, value)
            if not reason.strip():
                raise ValueError("A reason is required for rate changes")
            conn.execute(
                f"UPDATE {table} SET {', '.join(f'{c} = %s' for c in updates)} WHERE version_id = %s AND {where}",
                (*updates.values(), version_id, *edit.ident),
            )
            _audit(conn, version_id, actor, f"update_{edit.kind}", _entity(edit),
                   before={c: str(row[c]) for c in updates}, after={c: f"{v:f}" for c, v in updates.items()},
                   reason=reason)
            changed += 1
    return changed


def activate(version_id: int, actor: str, reason: str) -> None:
    """Make a draft the active version and retire the previously active one."""
    if not reason.strip():
        raise ValueError("A reason is required to activate a version")
    with pool.connection() as conn:
        version = _lock_draft(conn, version_id)
        previous = conn.execute(
            "UPDATE rate_versions SET status = 'retired' WHERE status = 'active' RETURNING label").fetchone()
        conn.execute("UPDATE rate_versions SET status = 'active', activated_at = now() WHERE id = %s", (version_id,))
        _audit(conn, version_id, actor, "activate",
               before={"active": previous["label"] if previous else None}, after={"active": version["label"]},
               reason=reason)


def audit_trail(version_id: int | None = None, limit: int = 200,
                since: str | None = None, until: str | None = None, tz: str = "UTC") -> list[dict]:
    """Rate-table changes, newest first. UX-044: `since`/`until` as in list_ratings."""
    with pool.connection() as conn:
        return conn.execute(
            "SELECT a.*, v.label AS version_label FROM rate_table_audit a JOIN rate_versions v ON v.id = a.version_id"
            " WHERE (%(v)s::int IS NULL OR a.version_id = %(v)s)"
            " AND (%(since)s::timestamp IS NULL OR a.created_at >= (%(since)s::timestamp AT TIME ZONE %(tz)s))"
            " AND (%(until)s::timestamp IS NULL OR a.created_at <= (%(until)s::timestamp AT TIME ZONE %(tz)s))"
            " ORDER BY a.id DESC LIMIT %(n)s",
            {"v": version_id, "n": limit, "since": since, "until": until, "tz": tz},
        ).fetchall()
