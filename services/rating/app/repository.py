"""Loads rate tables from the rating DB, records rating calls, and administers rate versions."""
from dataclasses import dataclass
from decimal import Decimal

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


# kind -> (table, identifying columns, editable columns)
EDITABLE = {
    "class": ("class_rates", ("class_code",), ("base_rate", "min_premium")),
    "factor": ("factors", ("factor", "key"), ("value",)),
    "parameter": ("parameters", ("name",), ("value",)),
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


def create_draft(base_version_id: int, label: str, notes: str, actor: str) -> int:
    """Copy every row of `base_version_id` into a new draft version."""
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
            "INSERT INTO class_rates SELECT %s, class_code, description, base_rate, min_premium"
            " FROM class_rates WHERE version_id = %s", (new_id, base_version_id))
        conn.execute(
            "INSERT INTO factors SELECT %s, factor, kind, key, value, label FROM factors WHERE version_id = %s",
            (new_id, base_version_id))
        conn.execute(
            "INSERT INTO parameters SELECT %s, name, value, label FROM parameters WHERE version_id = %s",
            (new_id, base_version_id))
        _audit(conn, new_id, actor, "create_draft", after={"label": label, "based_on": base["label"]}, reason=notes)
    return new_id


def apply_edits(version_id: int, edits: list[Edit], actor: str, reason: str) -> int:
    """Apply edits to a draft in one transaction, auditing each changed row. Returns rows changed."""
    with pool.connection() as conn:
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
            updates = {c: v for c, v in edit.values.items() if Decimal(v) != row[c]}
            if not updates:
                continue
            if any(Decimal(v) <= 0 for v in updates.values()):
                raise ValueError(f"{_entity(edit)}: values must be greater than zero")
            if not reason.strip():
                raise ValueError("A reason is required for rate changes")
            conn.execute(
                f"UPDATE {table} SET {', '.join(f'{c} = %s' for c in updates)} WHERE version_id = %s AND {where}",
                (*updates.values(), version_id, *edit.ident),
            )
            _audit(conn, version_id, actor, f"update_{edit.kind}", _entity(edit),
                   before={c: str(row[c]) for c in updates}, after={c: str(v) for c, v in updates.items()},
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


def audit_trail(version_id: int | None = None, limit: int = 200) -> list[dict]:
    with pool.connection() as conn:
        return conn.execute(
            "SELECT a.*, v.label AS version_label FROM rate_table_audit a JOIN rate_versions v ON v.id = a.version_id"
            " WHERE %(v)s::int IS NULL OR a.version_id = %(v)s ORDER BY a.id DESC LIMIT %(n)s",
            {"v": version_id, "n": limit},
        ).fetchall()
