"""Rate-table admin UI (server-rendered HTML at /admin).

Pick a variable, edit its values in a draft version, give a reason, save.
Each changed value is audited. Activating the draft makes it the version
`POST /rate` uses.
"""
import os
from datetime import timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from app import auth, repository

# The whole admin UI needs the service's bearer token, which the UW Desktop proxy attaches (SEC-002).
router = APIRouter(prefix="/admin", include_in_schema=False, dependencies=[Depends(auth.require_admin)])
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


# UX-019: decimals shown per kind of value, so a column lines up. Factors and mod bounds multiply the
# premium (1.00, 0.90, 1.35); a class base rate is per $1,000 of receipts (9.40); surplus lines tax is a
# fraction of premium (0.0489); fees and minimum premiums are whole dollars (250, 2500).
DECIMALS = {"factor": 2, "rate": 2, "tax": 4, "amount": 0}


def num(value, kind: str | None = None) -> str:
    """Format a rate-table number for display; pass anything that isn't a number through unchanged.

    With a `kind` (see DECIMALS) the value gets that many decimals, or more when it really has more
    (1.125 stays 1.125); without one, trailing zeros are dropped (9.4000 -> 9.4)."""
    if value is None or value == "":
        return ""
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, TypeError, ValueError):
        return str(value)
    if not d.is_finite():
        return str(value)
    needed = max(0, -d.normalize().as_tuple().exponent)  # decimals the value can't do without
    places = DECIMALS.get(kind)
    if places is None:
        return f"{d.normalize():f}"
    if kind == "amount" and needed:   # a whole-dollar parameter that isn't whole shows cents (2500.50)
        places = 2
    return f"{d:.{max(places, needed)}f}"


def value_kind(kind: str, ident: tuple, column: str) -> str:
    """UX-019: which DECIMALS entry a cell uses; `kind`/`ident`/`column` as in the form field name
    ('class' | 'factor' | 'parameter'), decided by how the engine uses the value."""
    if kind == "class":
        return "rate" if column == "base_rate" else "amount"   # base_rate per $1,000; min_premium in dollars
    if kind == "factor":
        return "factor"
    name = ident[0] if ident else ""
    if name.startswith("sl_tax."):
        return "tax"
    if name.endswith(("_fee", "_premium", "_limit")):   # whole-dollar parameters (policy_fee)
        return "amount"
    return "factor"   # mod bounds (schedule_mod_min ...) are factors


def audit_kind(entry: dict, column: str) -> str | None:
    """UX-019: the DECIMALS kind for one before/after value of an audit row (entity 'territory:FL',
    'class:98677', 'policy_fee', 'sl_tax.FL'; action 'update_factor' | 'update_class' | 'update_parameter').
    UX-027: only update_* rows carry numbers; activate/create_draft rows hold version labels and notes,
    which pass through unformatted (2026.1 stays 2026.1, never 2026.10)."""
    action = str(entry.get("action", ""))
    if not action.startswith("update_"):
        return None
    return value_kind(action.removeprefix("update_"), (entry.get("entity") or "",), column)


# UX-006: every on-screen timestamp in one named zone, the same one the web app shows.
DEFAULT_TZ = "America/New_York"


def display_tz() -> ZoneInfo:
    name = os.environ.get("DISPLAY_TZ") or DEFAULT_TZ
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")   # a misspelt DISPLAY_TZ shows UTC (labelled) rather than failing the page


def when(dt) -> str:
    """UX-006: '2026-10-22 21:55 EDT' in DISPLAY_TZ (default America/New_York); '' for None."""
    if dt is None:
        return ""
    if dt.tzinfo is None:   # timestamptz columns come back aware; be safe with anything else
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(display_tz()).strftime("%b %-d, %Y, %-I:%M %p %Z")  # UX-025: same shape as the desktop


templates.env.filters["num"] = num
templates.env.filters["when"] = when
templates.env.filters["audit_kind"] = audit_kind
templates.env.filters["uw_user"] = auth.decode_user

ACTOR_COOKIE = "rating_admin_user"

# Display names for factor variables, in the order the engine applies them.
FACTOR_TITLES = {
    "territory": "Territory",
    "ilf": "Increased limits",
    "deductible": "Deductible",
    "residential_pct": "Residential share",
    "subcontracted_pct": "Subcontracted share",
    "no_sub_coi": "Uninsured subcontractors",
    "height_ft": "Working height",
}


def sections(rows: dict) -> list[tuple[str, str]]:
    factor_names = list(dict.fromkeys(r["factor"] for r in rows["factors"]))
    ordered = [f for f in FACTOR_TITLES if f in factor_names] + [f for f in factor_names if f not in FACTOR_TITLES]
    return (
        [("classes", "Class base rates")]
        + [(f, FACTOR_TITLES.get(f, f)) for f in ordered]
        + [("parameters", "Mods & fees"), ("sl_tax", "Surplus lines tax")]
    )


def section_rows(rows: dict, section: str) -> list[dict]:
    """Rows of one variable as {key, label, cells: [{field, column, value, fmt}]}; `field` names the form
    input, `fmt` the number format (UX-019)."""
    if section == "classes":
        return [
            {"key": r["class_code"], "label": r["description"], "cells": [
                {"field": f"class|{r['class_code']}|{col}", "column": col, "value": r[col],
                 "fmt": value_kind("class", (r["class_code"],), col)}
                for col in ("base_rate", "min_premium")
            ]}
            for r in rows["classes"]
        ]
    if section in ("parameters", "sl_tax"):
        return [
            {"key": r["name"].removeprefix("sl_tax."), "label": r["label"], "cells": [
                {"field": f"parameter|{r['name']}|value", "column": "value", "value": r["value"],
                 "fmt": value_kind("parameter", (r["name"],), "value")}
            ]}
            for r in rows["parameters"] if r["name"].startswith("sl_tax.") == (section == "sl_tax")
        ]
    return [
        {"key": r["key"], "label": r["label"], "kind": r["kind"], "cells": [
            {"field": f"factor|{r['factor']}|{r['key']}|value", "column": "value", "value": r["value"],
             "fmt": "factor"}
        ]}
        for r in rows["factors"] if r["factor"] == section
    ]


def with_base(cells_rows: list[dict], base_rows: list[dict]) -> int:
    """Attach the base version's value to each cell; return how many cells differ."""
    base = {c["field"]: c["value"] for r in base_rows for c in r["cells"]}
    changed = 0
    for r in cells_rows:
        for c in r["cells"]:
            c["base"] = base.get(c["field"])
            c["changed"] = c["base"] is not None and c["base"] != c["value"]
            changed += c["changed"]
    return changed


COLUMN_TITLES = {"base_rate": "Rate per $1,000", "min_premium": "Min premium", "value": ""}


def live_diff(rows: dict, active_rows: dict) -> list[dict]:
    """UX-007: every value of this version that differs from the *active* version, in section order:
    what activating would change in production. Each item: section, key, label, column, active, draft, fmt."""
    diff = []
    for key, title in sections(rows):
        current = section_rows(rows, key)
        with_base(current, section_rows(active_rows, key))
        for r in current:
            for c in r["cells"]:
                if c["changed"]:
                    diff.append({"section": title, "key": r["key"], "label": r["label"],
                                 "column": COLUMN_TITLES.get(c["column"], c["column"]),
                                 "active": c["base"], "draft": c["value"], "fmt": c["fmt"]})
    return diff


def diff_summary(version: dict, active: dict | None, diff: list[dict], limit: int = 8) -> str:
    """UX-007: the confirm() text for Activate, carrying the same differences the card lists."""
    if active is None:
        return f"Activate {version['label']}? There is no active version; new ratings will use it immediately."
    if not diff:
        return (f"Activate {version['label']}? It has no differences from active {active['label']}, "
                "so new ratings will not change.")
    lines = [f"{d['section']} {d['key']}{' ' + d['column'] if d['column'] else ''}: "
             f"{num(d['active'], d['fmt'])} -> {num(d['draft'], d['fmt'])}" for d in diff[:limit]]
    if len(diff) > limit:
        lines.append(f"and {len(diff) - limit} more")
    n = len(diff)
    return (f"Activate {version['label']}? {n} value{'s' if n != 1 else ''} differ{'s' if n == 1 else ''}"
            f" from active {active['label']}:\n"
            + "\n".join(lines) + "\nNew ratings will use it immediately.")


def redirect(url: str, **params) -> RedirectResponse:
    query = urlencode({k: v for k, v in params.items() if v})
    return RedirectResponse(f"{url}?{query}" if query else url, status_code=303)


def signed_in_user(request: Request) -> str | None:
    """The UW Desktop user. The web app's /admin proxy sets the x-uw-user header from the login it
    checked, and proves it is the proxy with the service's bearer token (SEC-002): the header is
    believed from no one else."""
    return auth.acting_user(request)


def form_actor(request: Request, form) -> str:
    """Who to record in the audit trail: the signed-in user, else the typed name (standalone use)."""
    return signed_in_user(request) or str(form.get("actor", "")).strip() or "rating-admin"


def same_origin(request: Request) -> None:
    """Refuse a form post that another site made this browser send (CR-051). Browsers put Sec-Fetch-Site
    on every request and Origin on every POST; a request with neither (curl, the UW Desktop proxy, which
    forwards neither header and makes this check itself) carries no ambient browser credentials."""
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        raise HTTPException(403, "Cross-site request refused")
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin and (origin == "null" or urlsplit(origin).netloc != request.headers.get("host")):
        raise HTTPException(403, "Cross-site request refused")


def remember_actor(request: Request, response: RedirectResponse, actor: str) -> RedirectResponse:
    if not signed_in_user(request):  # the typed name is only remembered when there's no login
        response.set_cookie(ACTOR_COOKIE, actor, max_age=60 * 60 * 24 * 365, samesite="lax")
    return response


def next_label(versions: list[dict]) -> str:
    labels = {v["label"] for v in versions}
    year, _, minor = (versions[0]["label"] if versions else "2026.0").partition(".")
    n = int(minor) + 1 if minor.isdigit() else 1
    while f"{year}.{n}" in labels:
        n += 1
    return f"{year}.{n}"


@router.get("", response_class=HTMLResponse)
def versions_page(request: Request, msg: str = "", error: str = ""):
    versions = repository.list_versions()
    return templates.TemplateResponse(request, "versions.html", {
        "versions": versions,
        "next_label": next_label(versions),
        "active": next((v for v in versions if v["status"] == "active"), None),
        "audit": repository.audit_trail(limit=25),
        "actor": signed_in_user(request) or request.cookies.get(ACTOR_COOKIE, ""),
        "signed_in": signed_in_user(request) is not None,
        "msg": msg, "error": error,
    })


@router.post("/versions", dependencies=[Depends(same_origin)])
async def create_version(request: Request):
    form = await request.form()
    actor = form_actor(request, form)
    try:
        # psycopg is synchronous: keep it off the event loop in these async (form-reading) handlers.
        new_id = await run_in_threadpool(
            repository.create_draft, int(form["based_on"]), str(form["label"]).strip(), str(form.get("notes", "")), actor)
    except (LookupError, ValueError) as e:
        return redirect("/admin", error=str(e))
    return remember_actor(request, redirect(f"/admin/versions/{new_id}", msg="Draft created. Edit any variable, then activate."), actor)


def version_context(request: Request, version_id: int, section: str, msg: str = "", error: str = "",
                    posted: dict[str, str] | None = None, reason: str = "") -> dict:
    """Everything version.html needs. `posted` (field -> what the user typed) and `reason` re-fill the
    editor after a failed save (UX-001) instead of showing the saved values again."""
    version = repository.get_version(version_id)
    if version is None:
        raise HTTPException(404, "Rate version not found")
    rows = repository.version_rows(version_id)
    base_version = repository.get_version(version["based_on"]) if version["based_on"] else None
    active = next((v for v in repository.list_versions() if v["status"] == "active"), None)
    editable = version["status"] == "draft"
    # UX-007: a draft is compared with the *active* version (what activating would change), not with the
    # version it was copied from; a draft copied from a retired version would otherwise hide its reverts.
    # Active and retired versions keep showing what changed against the version they were copied from.
    compare = active if editable and active else base_version
    compare_rows = repository.version_rows(compare["id"]) if compare else None

    nav = []
    for key, title in sections(rows):
        changes = with_base(section_rows(rows, key), section_rows(compare_rows, key)) if compare_rows else 0
        nav.append({"key": key, "title": title, "changes": changes})
    if section not in {n["key"] for n in nav}:
        section = "classes"
    current = section_rows(rows, section)
    if compare_rows:
        with_base(current, section_rows(compare_rows, section))
    if posted:   # UX-001: show what was typed, flagged against the comparison version when it parses
        for r in current:
            for c in r["cells"]:
                if c["field"] in posted:
                    c["value"] = posted[c["field"]]
                    try:
                        c["changed"] = c.get("base") is not None and Decimal(posted[c["field"]].strip()) != c["base"]
                    except InvalidOperation:
                        c["changed"] = True
    diff = live_diff(rows, compare_rows) if editable and compare_rows and compare is active else []

    return {
        "version": version, "base_version": base_version, "active": active, "compare": compare,
        "editable": editable,
        "nav": nav, "section": section, "section_title": dict(sections(rows))[section],
        "rows": current,
        "columns": [c["column"] for c in current[0]["cells"]] if current else [],
        "live_diff": diff,
        "activate_confirm": diff_summary(version, active, diff),
        "reason": reason,
        "audit": repository.audit_trail(version_id),
        "actor": signed_in_user(request) or request.cookies.get(ACTOR_COOKIE, ""),
        "signed_in": signed_in_user(request) is not None,
        "msg": msg, "error": error,
    }


@router.get("/versions/{version_id}", response_class=HTMLResponse)
def version_page(request: Request, version_id: int, section: str = "classes", msg: str = "", error: str = ""):
    return templates.TemplateResponse(request, "version.html", version_context(request, version_id, section, msg, error))


@router.post("/versions/{version_id}/sections/{section}", dependencies=[Depends(same_origin)])
async def save_section(request: Request, version_id: int, section: str):
    form = await request.form()
    actor = form_actor(request, form)
    back = f"/admin/versions/{version_id}"
    reason = str(form.get("reason", ""))
    posted = {name: str(raw) for name, raw in form.items() if "|" in name}

    async def again(error: str):
        # UX-001: a failed save re-renders the editor with every typed value and the reason still in
        # place (a redirect with ?error= would reset each edited cell to its saved value).
        ctx = await run_in_threadpool(version_context, request, version_id, section, "", error, posted, reason)
        return templates.TemplateResponse(request, "version.html", ctx, status_code=422)

    edits: dict[tuple, repository.Edit] = {}
    try:
        for name, raw in posted.items():
            kind, *ident, column = name.split("|")
            if kind not in repository.EDITABLE:
                continue
            if len(ident) != len(repository.EDITABLE[kind][1]):  # e.g. "class|a|b|base_rate"
                return await again(f"Unrecognised field {name!r}")
            edit = edits.setdefault((kind, *ident), repository.Edit(kind, tuple(ident), {}))
            value = Decimal(raw.strip())
            if not value.is_finite():   # "Infinity"/"NaN" parse as Decimals but aren't rates
                raise InvalidOperation
            edit.values[column] = value
        changed = await run_in_threadpool(repository.apply_edits, version_id, list(edits.values()), actor, reason)
    except InvalidOperation:
        return await again("Every value must be a number")
    except (LookupError, ValueError, repository.VersionNotEditable) as e:
        return await again(str(e))
    msg = f"Saved {changed} change{'s' if changed != 1 else ''}" if changed else "Nothing changed"
    return remember_actor(request, redirect(back, section=section, msg=msg), actor)


@router.post("/versions/{version_id}/activate", dependencies=[Depends(same_origin)])
async def activate_version(request: Request, version_id: int):
    form = await request.form()
    actor = form_actor(request, form)
    try:
        await run_in_threadpool(repository.activate, version_id, actor, str(form.get("reason", "")))
    except (LookupError, ValueError, repository.VersionNotEditable) as e:
        return redirect(f"/admin/versions/{version_id}", error=str(e))
    return remember_actor(request, redirect(f"/admin/versions/{version_id}", msg="Activated. New ratings now use this version."), actor)
