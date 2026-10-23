from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app import db, repository
from app.engine import RatingError, RatingInput, RatingResult, rate


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.pool.open(wait=True)
    db.migrate()
    yield
    db.pool.close()


app = FastAPI(title="Rating Service", description="Contractors GL rating engine", lifespan=lifespan)


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
