"""Rate-table admin UI (server-rendered HTML at /admin).

Pick a variable, edit its values in a draft version, give a reason, save.
Each changed value is audited. Activating the draft makes it the version
`POST /rate` uses.
"""
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app import repository

router = APIRouter(prefix="/admin", include_in_schema=False)
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


def num(value) -> str:
    """Show numbers without trailing zeros (9.4000 -> 9.4); pass anything else through."""
    if value is None:
        return ""
    try:
        return f"{Decimal(value).normalize():f}"
    except (InvalidOperation, TypeError, ValueError):
        return str(value)


templates.env.filters["num"] = num

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
    """Rows of one variable as {key, label, cells: [{field, column, value}]}; `field` names the form input."""
    if section == "classes":
        return [
            {"key": r["class_code"], "label": r["description"], "cells": [
                {"field": f"class|{r['class_code']}|{col}", "column": col, "value": r[col]}
                for col in ("base_rate", "min_premium")
            ]}
            for r in rows["classes"]
        ]
    if section in ("parameters", "sl_tax"):
        return [
            {"key": r["name"].removeprefix("sl_tax."), "label": r["label"], "cells": [
                {"field": f"parameter|{r['name']}|value", "column": "value", "value": r["value"]}
            ]}
            for r in rows["parameters"] if r["name"].startswith("sl_tax.") == (section == "sl_tax")
        ]
    return [
        {"key": r["key"], "label": r["label"], "kind": r["kind"], "cells": [
            {"field": f"factor|{r['factor']}|{r['key']}|value", "column": "value", "value": r["value"]}
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


def redirect(url: str, **params) -> RedirectResponse:
    query = urlencode({k: v for k, v in params.items() if v})
    return RedirectResponse(f"{url}?{query}" if query else url, status_code=303)


def remember_actor(response: RedirectResponse, actor: str) -> RedirectResponse:
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
        "actor": request.cookies.get(ACTOR_COOKIE, ""),
        "msg": msg, "error": error,
    })


@router.post("/versions")
async def create_version(request: Request):
    form = await request.form()
    actor = str(form.get("actor", "")).strip() or "rating-admin"
    try:
        new_id = repository.create_draft(int(form["based_on"]), str(form["label"]).strip(), str(form.get("notes", "")), actor)
    except (LookupError, ValueError) as e:
        return redirect("/admin", error=str(e))
    return remember_actor(redirect(f"/admin/versions/{new_id}", msg="Draft created. Edit any variable, then activate."), actor)


@router.get("/versions/{version_id}", response_class=HTMLResponse)
def version_page(request: Request, version_id: int, section: str = "classes", msg: str = "", error: str = ""):
    version = repository.get_version(version_id)
    if version is None:
        raise HTTPException(404, "Rate version not found")
    rows = repository.version_rows(version_id)
    base_version = repository.get_version(version["based_on"]) if version["based_on"] else None
    base_rows = repository.version_rows(base_version["id"]) if base_version else None

    nav = []
    for key, title in sections(rows):
        changes = with_base(section_rows(rows, key), section_rows(base_rows, key)) if base_rows else 0
        nav.append({"key": key, "title": title, "changes": changes})
    if section not in {n["key"] for n in nav}:
        section = "classes"
    current = section_rows(rows, section)
    if base_rows:
        with_base(current, section_rows(base_rows, section))

    return templates.TemplateResponse(request, "version.html", {
        "version": version, "base_version": base_version,
        "editable": version["status"] == "draft",
        "nav": nav, "section": section, "section_title": dict(sections(rows))[section],
        "rows": current,
        "columns": [c["column"] for c in current[0]["cells"]] if current else [],
        "audit": repository.audit_trail(version_id),
        "actor": request.cookies.get(ACTOR_COOKIE, ""),
        "msg": msg, "error": error,
    })


@router.post("/versions/{version_id}/sections/{section}")
async def save_section(request: Request, version_id: int, section: str):
    form = await request.form()
    actor = str(form.get("actor", "")).strip() or "rating-admin"
    back = f"/admin/versions/{version_id}"
    edits: dict[tuple, repository.Edit] = {}
    try:
        for name, raw in form.items():
            kind, *ident, column = name.split("|") if "|" in name else ("", "")
            if kind not in repository.EDITABLE:
                continue
            edit = edits.setdefault((kind, *ident), repository.Edit(kind, tuple(ident), {}))
            edit.values[column] = Decimal(str(raw).strip())
        changed = repository.apply_edits(version_id, list(edits.values()), actor, str(form.get("reason", "")))
    except InvalidOperation:
        return redirect(back, section=section, error="Every value must be a number")
    except (LookupError, ValueError, repository.VersionNotEditable) as e:
        return redirect(back, section=section, error=str(e))
    msg = f"Saved {changed} change{'s' if changed != 1 else ''}" if changed else "Nothing changed"
    return remember_actor(redirect(back, section=section, msg=msg), actor)


@router.post("/versions/{version_id}/activate")
async def activate_version(request: Request, version_id: int):
    form = await request.form()
    actor = str(form.get("actor", "")).strip() or "rating-admin"
    try:
        repository.activate(version_id, actor, str(form.get("reason", "")))
    except (LookupError, ValueError, repository.VersionNotEditable) as e:
        return redirect(f"/admin/versions/{version_id}", error=str(e))
    return remember_actor(redirect(f"/admin/versions/{version_id}", msg="Activated. New ratings now use this version."), actor)
