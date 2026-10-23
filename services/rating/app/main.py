from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import db


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.pool.open(wait=True)
    db.migrate()
    yield
    db.pool.close()


app = FastAPI(title="Rating Service", lifespan=lifespan)


@app.get("/health")
def health():
    with db.pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"service": "rating", "status": "ok", "database": "ok"}
