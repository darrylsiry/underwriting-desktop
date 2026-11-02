from datetime import datetime
import uuid
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app import admin, auth, db, repository
from app.engine import RatingError, RatingInput, RatingResult, rate


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.pool.open(wait=True)
    db.migrate()
    yield
    db.pool.close()


app = FastAPI(title="Rating Service", description="Contractors GL rating engine", lifespan=lifespan)
app.include_router(admin.router)


@app.get("/health")
def health():
    with db.pool.connection() as conn:
        conn.execute("SELECT 1")
    try:
        active = repository.load_tables().version_label
    except LookupError:  # no active version yet: still healthy, nothing to rate with
        active = None
    return {"service": "rating", "status": "ok", "database": "ok", "active_rate_version": active}


class RateRequest(RatingInput):
    rate_version_id: int | None = None
    reference: str | None = None  # caller's ID, e.g. the submission or quote
    # Who asked is read from the x-uw-user header of a trusted caller (SEC-002), not from the body.
    rated_at: datetime | None = None  # when the rating happened, if not now (seeded history)


class RateResponse(RatingResult):
    rating_id: str


@app.post("/rate", response_model=RateResponse)
def rate_risk(req: RateRequest, request: Request):
    try:
        tables = repository.load_tables(req.rate_version_id)
        result = rate(tables, RatingInput(**req.model_dump(include=set(RatingInput.model_fields))))
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except RatingError as e:
        raise HTTPException(422, str(e)) from e
    rating_id = repository.log_rating(
        tables.version_id, req.reference, auth.acting_user(request) or "anonymous",
        req.model_dump(mode="json", exclude={"rated_at"}), result.model_dump(mode="json"), req.rated_at,
    )
    return RateResponse(rating_id=rating_id, **result.model_dump())


@app.get("/ratings/{rating_id}")
def get_rating(rating_id: uuid.UUID):
    row = repository.get_rating(str(rating_id))
    if row is None:
        raise HTTPException(404, "Rating not found")
    return row


class ClassInfo(BaseModel):
    class_code: str
    description: str


@app.get("/classes", response_model=list[ClassInfo])
def classes():
    """Class codes rateable under the active version (used by the UW desktop)."""
    tables = repository.load_tables()
    return [ClassInfo(class_code=k, description=v["description"]) for k, v in sorted(tables.classes.items())]


@app.get("/rate-versions")
def rate_versions():
    return repository.list_versions()


# --- Rate-table administration (the /admin UI uses the same repository calls) ---
# Changing rate tables needs the service's bearer token (SEC-002); the actor is the signed-in
# UW Desktop user the trusted caller names, never a name typed into the request body.

def actor_of(request: Request) -> str:
    return auth.acting_user(request) or "anonymous"


def admin_errors(fn, *args):
    try:
        return fn(*args)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except repository.VersionNotEditable as e:
        raise HTTPException(409, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@app.get("/rate-versions/{version_id}")
def rate_version(version_id: int):
    version = repository.get_version(version_id)
    if version is None:
        raise HTTPException(404, "Rate version not found")
    return version | repository.version_rows(version_id)


class NewDraft(BaseModel):
    # Letters, digits, dots, dashes, underscores: the label appears in page text and attributes (CR-044).
    label: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9._-]+$")
    based_on: int | None = Field(default=None, description="Version to copy; defaults to the active version")
    notes: str = ""


@app.post("/rate-versions", status_code=201, dependencies=[Depends(auth.require_admin)])
def create_draft(req: NewDraft, request: Request):
    base = req.based_on or repository.active_version_id()
    new_id = admin_errors(repository.create_draft, base, req.label, req.notes, actor_of(request))
    return repository.get_version(new_id)


class ClassEdit(BaseModel):
    kind: Literal["class"]
    class_code: str
    base_rate: Decimal | None = None
    min_premium: Decimal | None = None


class FactorEdit(BaseModel):
    kind: Literal["factor"]
    factor: str
    key: str
    value: Decimal


class ParameterEdit(BaseModel):
    kind: Literal["parameter"]
    name: str
    value: Decimal


class EditRequest(BaseModel):
    reason: str = Field(min_length=1)
    edits: list[Annotated[ClassEdit | FactorEdit | ParameterEdit, Field(discriminator="kind")]]


@app.post("/rate-versions/{version_id}/edits", dependencies=[Depends(auth.require_admin)])
def edit_draft(version_id: int, req: EditRequest, request: Request):
    """Change values in a draft. Each changed row is audited with before/after and the reason."""
    edits = []
    for e in req.edits:
        if isinstance(e, ClassEdit):
            values = {k: v for k, v in (("base_rate", e.base_rate), ("min_premium", e.min_premium)) if v is not None}
            edits.append(repository.Edit("class", (e.class_code,), values))
        elif isinstance(e, FactorEdit):
            edits.append(repository.Edit("factor", (e.factor, e.key), {"value": e.value}))
        else:
            edits.append(repository.Edit("parameter", (e.name,), {"value": e.value}))
    return {"changed": admin_errors(repository.apply_edits, version_id, edits, actor_of(request), req.reason)}


class Activation(BaseModel):
    reason: str = Field(min_length=1)


@app.post("/rate-versions/{version_id}/activate", dependencies=[Depends(auth.require_admin)])
def activate(version_id: int, req: Activation, request: Request):
    admin_errors(repository.activate, version_id, actor_of(request), req.reason)
    return repository.get_version(version_id)


_WALL = r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?$"   # a wall-clock timestamp, no zone (UX-044)
_TZ = r"^[A-Za-z_]+(/[A-Za-z_+\-0-9]+)*$"


def _zone(tz: str = Query("UTC", pattern=_TZ)) -> str:
    """A zone Postgres can use: an unknown name is the caller's error, not a 500 from AT TIME ZONE (CR-094)."""
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, OSError) as err:
        raise HTTPException(422, f"Unknown time zone: {tz}") from err
    return tz


@app.get("/rate-table-audit")
def rate_table_audit(version_id: int | None = None, limit: int = Query(200, ge=1, le=1000),
                     since: str | None = Query(None, pattern=_WALL), until: str | None = Query(None, pattern=_WALL),
                     tz: str = Depends(_zone)):
    """Rate-table changes, newest first; `since`/`until` are wall-clock bounds in `tz` (UX-044)."""
    return repository.audit_trail(version_id, limit, since, until, tz)


@app.get("/ratings")
def list_ratings(reference_prefix: str | None = None, limit: int = Query(200, ge=1, le=1000),
                 since: str | None = Query(None, pattern=_WALL), until: str | None = Query(None, pattern=_WALL),
                 tz: str = Depends(_zone)):
    """Rating calls, newest first: who rated what, on which rate version, for which reference (SUB-/Q-).
    `since`/`until` are wall-clock bounds in `tz` (UX-044)."""
    return repository.list_ratings(reference_prefix, limit, since, until, tz)
