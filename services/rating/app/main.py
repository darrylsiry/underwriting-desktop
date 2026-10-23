from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app import admin, db, repository
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
    return {"service": "rating", "status": "ok", "database": "ok", "active_rate_version": repository.load_tables().version_label}


class RateRequest(RatingInput):
    rate_version_id: int | None = None
    reference: str | None = None  # caller's ID, e.g. the submission or quote
    requested_by: str = "anonymous"


class RateResponse(RatingResult):
    rating_id: str


@app.post("/rate", response_model=RateResponse)
def rate_risk(req: RateRequest):
    try:
        tables = repository.load_tables(req.rate_version_id)
        result = rate(tables, RatingInput(**req.model_dump(include=set(RatingInput.model_fields))))
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except RatingError as e:
        raise HTTPException(422, str(e)) from e
    rating_id = repository.log_rating(
        tables.version_id, req.reference, req.requested_by,
        req.model_dump(mode="json"), result.model_dump(mode="json"),
    )
    return RateResponse(rating_id=rating_id, **result.model_dump())


@app.get("/ratings/{rating_id}")
def get_rating(rating_id: str):
    row = repository.get_rating(rating_id)
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
    label: str = Field(min_length=1)
    based_on: int | None = Field(default=None, description="Version to copy; defaults to the active version")
    notes: str = ""
    actor: str = "anonymous"


@app.post("/rate-versions", status_code=201)
def create_draft(req: NewDraft):
    base = req.based_on or repository.active_version_id()
    new_id = admin_errors(repository.create_draft, base, req.label, req.notes, req.actor)
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
    actor: str = "anonymous"
    reason: str = Field(min_length=1)
    edits: list[Annotated[ClassEdit | FactorEdit | ParameterEdit, Field(discriminator="kind")]]


@app.post("/rate-versions/{version_id}/edits")
def edit_draft(version_id: int, req: EditRequest):
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
    return {"changed": admin_errors(repository.apply_edits, version_id, edits, req.actor, req.reason)}


class Activation(BaseModel):
    actor: str = "anonymous"
    reason: str = Field(min_length=1)


@app.post("/rate-versions/{version_id}/activate")
def activate(version_id: int, req: Activation):
    admin_errors(repository.activate, version_id, req.actor, req.reason)
    return repository.get_version(version_id)


@app.get("/rate-table-audit")
def rate_table_audit(version_id: int | None = None):
    return repository.audit_trail(version_id)
