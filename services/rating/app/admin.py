"""Rate-table admin: draft versions, per-variable table edits, impact preview, activation.

Only drafts can be edited. Activating a draft retires the current active version.
Every change is written to `rate_table_audit` with before/after rows and the actor
(taken from the X-User header).
"""
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app import repository
from app.db import pool
from app.engine import RatingError, RatingInput, rate

STATIC_DIR = Path(__file__).resolve().parent / "static"
BENCHMARK_RISKS = json.loads((Path(__file__).resolve().parent / "benchmark_risks.json").read_text())

router = APIRouter(prefix="/admin")


@router.get("", include_in_schema=False)
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html")


# --- reading -----------------------------------------------------------------

def _version(conn, version_id: int) -> dict:
    row = conn.execute("SELECT * FROM rate_versions WHERE id = %s", (version_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"Rate version {version_id} not found")
    return row


def _draft(conn, version_id: int) -> dict:
    version = conn.execute("SELECT * FROM rate_versions WHERE id = %s FOR UPDATE", (version_id,)).fetchone()
    if version is None:
        raise HTTPException(404, f"Rate version {version_id} not found")
    if version["status"] != "draft":
        raise HTTPException(409, f"Version {version['label']} is {version['status']}; create a draft to make changes")
    return version


@router.get("/api/versions")
def list_versions():
    with pool.connection() as conn:
        return conn.execute(
            "SELECT v.*, b.label AS based_on_label FROM rate_versions v"
            " LEFT JOIN rate_versions b ON b.id = v.based_on ORDER BY v.id DESC"
        ).fetchall()


@router.get("/api/versions/{version_id}")
def get_version(version_id: int):
    with pool.connection() as conn:
        version = _version(conn, version_id)
        classes = conn.execute(
            "SELECT class_code, description, base_rate, min_premium FROM class_rates"
            " WHERE version_id = %s ORDER BY class_code", (version_id,)).fetchall()
        factors: dict[str, dict] = {}
        for r in conn.execute(
            "SELECT factor, kind, key, value, label FROM factors WHERE version_id = %s"
            " ORDER BY factor, CASE WHEN kind = 'band' THEN key::numeric END, key", (version_id,)
        ):
            table = factors.setdefault(r["factor"], {"kind": r["kind"], "entries": []})
            table["entries"].append({"key": r["key"], "value": r["value"], "label": r["label"]})
        parameters = conn.execute(
            "SELECT name, value, label FROM parameters WHERE version_id = %s ORDER BY name", (version_id,)).fetchall()
    return {"version": version, "classes": classes, "factors": factors, "parameters": parameters}


@router.get("/api/audit")
def audit(version_id: int | None = None, limit: int = 200):
    with pool.connection() as conn:
        return conn.execute(
            "SELECT a.*, v.label AS version_label FROM rate_table_audit a JOIN rate_versions v ON v.id = a.version_id"
            " WHERE %(v)s::int IS NULL OR a.version_id = %(v)s ORDER BY a.id DESC LIMIT %(n)s",
            {"v": version_id, "n": limit},
        ).fetchall()


# --- changing ----------------------------------------------------------------

def _audit(conn, version_id: int, action: str, target: str, actor: str, summary: str, before=None, after=None):
    conn.execute(
        "INSERT INTO rate_table_audit (version_id, action, target, actor, summary, before, after)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (version_id, action, target, actor, summary,
         None if before is None else Jsonb(before), None if after is None else Jsonb(after)),
    )


class NewDraft(BaseModel):
    label: str = Field(min_length=1)
    notes: str = ""
    from_version_id: int | None = Field(default=None, description="Version to clone; defaults to the active one")


@router.post("/api/versions", status_code=201)
def create_draft(body: NewDraft, x_user: str = Header(default="admin")):
    source_id = body.from_version_id or repository.active_version_id()
    with pool.connection() as conn:
        source = _version(conn, source_id)
        if conn.execute("SELECT 1 FROM rate_versions WHERE label = %s", (body.label,)).fetchone():
            raise HTTPException(409, f"Version label {body.label!r} already exists")
        new_id = conn.execute(
            "INSERT INTO rate_versions (label, status, notes, created_by, based_on)"
            " VALUES (%s, 'draft', %s, %s, %s) RETURNING id",
            (body.label, body.notes, x_user, source_id),
        ).fetchone()["id"]
        for table, cols in [
            ("class_rates", "class_code, description, base_rate, min_premium"),
            ("factors", "factor, kind, key, value, label"),
            ("parameters", "name, value, label"),
        ]:
            conn.execute(
                f"INSERT INTO {table} (version_id, {cols}) SELECT %s, {cols} FROM {table} WHERE version_id = %s",
                (new_id, source_id),
            )
        _audit(conn, new_id, "create_draft", "version", x_user,
               f"Draft {body.label} created from {source['label']}", after={"notes": body.notes})
    return get_version(new_id)


class FactorEntry(BaseModel):
    key: str = Field(min_length=1)
    value: Decimal = Field(gt=0)
    label: str = ""


class ClassEntry(BaseModel):
    class_code: str = Field(min_length=1)
    description: str = Field(min_length=1)
    base_rate: Decimal = Field(gt=0)
    min_premium: Decimal = Field(ge=0)


class ParameterEntry(BaseModel):
    name: str = Field(min_length=1)
    value: Decimal = Field(ge=0)
    label: str = ""


def _rows(entries: list[BaseModel], key: str) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for e in entries:
        row = e.model_dump(mode="json")
        if row[key] in rows:
            raise HTTPException(422, f"Duplicate {key} {row[key]!r}")
        rows[row[key]] = row
    return rows


NUMERIC = {"value", "base_rate", "min_premium"}


def _num(v) -> str:
    """Canonical string for a number, so 1.60 (DB) and "1.6" (request) compare equal."""
    d = Decimal(v)
    return str(d.quantize(Decimal(1)) if d == d.to_integral() else d.normalize())


def _canonical(rows, key: str) -> dict[str, dict]:
    return {str(r[key]): {c: _num(v) if c in NUMERIC else v for c, v in r.items()} for r in rows}


def _summarize(before: dict[str, dict], after: dict[str, dict], fields: list[str]) -> str:
    parts = []
    for k, row in after.items():
        if k not in before:
            parts.append(f"added {k}")
            continue
        for f in fields:
            if before[k][f] != row[f]:
                parts.append(f"{k}{'' if f == 'value' else ' ' + f}: {before[k][f]} → {row[f]}")
    parts += [f"removed {k}" for k in before if k not in after]
    return "; ".join(parts)


def _replace(conn, version_id: int, actor: str, target: str, table: str, where: str, where_args: tuple,
             key: str, fields: list[str], current: list[dict], new_rows: dict[str, dict],
             extra: dict | None = None) -> str | None:
    """Replace one section of a draft's tables; audit and return a summary, or None if nothing changed."""
    before, after = _canonical(current, key), _canonical(new_rows.values(), key)
    summary = _summarize(before, after, fields)
    if not summary:
        return None
    conn.execute(f"DELETE FROM {table} WHERE version_id = %s AND {where}", (version_id, *where_args))
    extra = extra or {}
    cols = ["version_id", *extra, *next(iter(after.values()))]
    with conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
            [(version_id, *extra.values(), *r.values()) for r in after.values()],
        )
    _audit(conn, version_id, "update_table", target, actor, summary,
           before=list(before.values()), after=list(after.values()))
    return summary


class FactorUpdate(BaseModel):
    entries: list[FactorEntry] = Field(min_length=1)


@router.put("/api/versions/{version_id}/factors/{factor}")
def update_factor(version_id: int, factor: str, body: FactorUpdate, x_user: str = Header(default="admin")):
    rows = _rows(body.entries, "key")
    with pool.connection() as conn:
        _draft(conn, version_id)
        current = conn.execute(
            "SELECT key, value, label, kind FROM factors WHERE version_id = %s AND factor = %s", (version_id, factor),
        ).fetchall()
        if not current:
            raise HTTPException(404, f"No factor {factor!r} in this version")
        kind = current[0]["kind"]
        if kind == "band":
            try:
                [Decimal(k) for k in rows]
            except InvalidOperation:
                raise HTTPException(422, "Band keys must be numbers (the lower bound of each band)") from None
        current = [{k: r[k] for k in ("key", "value", "label")} for r in current]
        summary = _replace(conn, version_id, x_user, f"factor:{factor}", "factors", "factor = %s", (factor,),
                           "key", ["value", "label"], current, rows, extra={"factor": factor, "kind": kind})
    return {"changed": summary is not None, "summary": summary}


class ClassUpdate(BaseModel):
    entries: list[ClassEntry] = Field(min_length=1)


@router.put("/api/versions/{version_id}/classes")
def update_classes(version_id: int, body: ClassUpdate, x_user: str = Header(default="admin")):
    rows = _rows(body.entries, "class_code")
    with pool.connection() as conn:
        _draft(conn, version_id)
        current = conn.execute(
            "SELECT class_code, description, base_rate, min_premium FROM class_rates WHERE version_id = %s",
            (version_id,)).fetchall()
        summary = _replace(conn, version_id, x_user, "classes", "class_rates", "TRUE", (), "class_code",
                           ["description", "base_rate", "min_premium"], current, rows)
    return {"changed": summary is not None, "summary": summary}


REQUIRED_PARAMETERS = {"schedule_mod_min", "schedule_mod_max", "experience_mod_min", "experience_mod_max"}


class ParameterUpdate(BaseModel):
    entries: list[ParameterEntry] = Field(min_length=1)


@router.put("/api/versions/{version_id}/parameters")
def update_parameters(version_id: int, body: ParameterUpdate, x_user: str = Header(default="admin")):
    rows = _rows(body.entries, "name")
    missing = REQUIRED_PARAMETERS - rows.keys()
    if missing:
        raise HTTPException(422, f"Missing required parameters: {', '.join(sorted(missing))}")
    for mod in ("schedule_mod", "experience_mod"):
        if not Decimal(rows[f"{mod}_min"]["value"]) <= 1 <= Decimal(rows[f"{mod}_max"]["value"]):
            raise HTTPException(422, f"{mod} bounds must include 1.0")
    with pool.connection() as conn:
        _draft(conn, version_id)
        current = conn.execute("SELECT name, value, label FROM parameters WHERE version_id = %s", (version_id,)).fetchall()
        summary = _replace(conn, version_id, x_user, "parameters", "parameters", "TRUE", (), "name",
                           ["value", "label"], current, rows)
    return {"changed": summary is not None, "summary": summary}


@router.post("/api/versions/{version_id}/activate")
def activate(version_id: int, x_user: str = Header(default="admin")):
    with pool.connection() as conn:
        version = _draft(conn, version_id)
        previous = conn.execute(
            "UPDATE rate_versions SET status = 'retired' WHERE status = 'active' RETURNING id, label").fetchone()
        conn.execute("UPDATE rate_versions SET status = 'active', activated_at = now() WHERE id = %s", (version_id,))
        summary = f"Activated {version['label']}" + (f", retiring {previous['label']}" if previous else "")
        _audit(conn, version_id, "activate", "version", x_user, summary,
               before={"active": previous and previous["label"]}, after={"active": version["label"]})
    return {"summary": summary}


# --- impact preview ----------------------------------------------------------

@router.get("/api/versions/{version_id}/impact")
def impact(version_id: int, against: int | None = None):
    """Rate the benchmark book (the 8 sample risks) on this version vs. the active one (not logged)."""
    try:
        target = repository.load_tables(version_id)
        base = repository.load_tables(against)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e

    def total(tables, risk):
        try:
            return rate(tables, RatingInput(**risk)).total, None
        except RatingError as e:
            return None, str(e)

    rows, base_sum, new_sum = [], Decimal(0), Decimal(0)
    for risk in BENCHMARK_RISKS:
        b, b_err = total(base, risk)
        n, n_err = total(target, risk)
        change = (n - b) / b * 100 if b and n is not None else None
        if b is not None and n is not None:
            base_sum, new_sum = base_sum + b, new_sum + n
        rows.append({
            "case": risk["case"], "name": risk["name"], "class_code": risk["class_code"],
            "states": risk["states"], "base_total": b, "new_total": n,
            "change_pct": None if change is None else round(change, 1), "error": n_err or b_err,
        })
    return {
        "version": target.version_label, "against": base.version_label, "risks": rows,
        "base_total": base_sum, "new_total": new_sum,
        "change_pct": round((new_sum - base_sum) / base_sum * 100, 1) if base_sum else None,
    }
