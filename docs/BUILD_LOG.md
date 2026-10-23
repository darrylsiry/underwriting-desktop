# Build log

One entry per step, in order. Claude sessions in `underwriting-desktop-live`
read this to replay the build quickly.

<!-- Template — copy for each new step
## step-NN: <short title>
- **Prompt used:** "<what was typed>"
- **What was built:** <1–3 sentences>
- **Files:** <paths>
- **Commit:** `step-NN: ...`
- **Decisions:** <stack/library/design choices and why>
- **Dead ends / gotchas:** <what to skip when replaying>
- **How to show it:** <command / URL / click path>
-->

## step-01: Monorepo skeleton with 3 services and 3 databases
- **Prompt used:** "Scaffold the monorepo from docs/PLAN.md: a Next.js web app, FastAPI rating and ingestion services, one Postgres with customer/policy/rating databases, docker compose, and a system status page that health-checks everything."
- **What was built:** Three runnable services plus Postgres in docker compose. The web home page and `/api/health` check both web-owned DBs and both services. Each DB owner applies its own `migrations/*.sql` at startup.
- **Files:** `docker-compose.yml`, `db/init/01-create-databases.sql`, `services/{rating,ingestion}/{Dockerfile,pyproject.toml,uv.lock,app/main.py}`, `services/rating/app/db.py`, `web/src/lib/{db,migrate,health,services}.ts`, `web/src/instrumentation.ts`, `web/src/app/page.tsx`, `web/src/app/api/health/route.ts`, `web/Dockerfile`, `scripts/cloud-sandbox-build.sh`
- **Commit:** `step-01: ...`
- **Decisions:**
  - Next.js 15 app router with `output: "standalone"` keeps the Docker image small.
  - Raw `pg` plus numbered SQL migrations instead of an ORM: one owner per DB, and the schema is easy to read.
  - The web app runs migrations from `instrumentation.ts` (on server start).
  - Python services use `uv` with a committed lockfile and psycopg 3 with a pool; the rating service migrates in its FastAPI lifespan.
  - Env vars: `CUSTOMER_DATABASE_URL`, `POLICY_DATABASE_URL`, `RATING_SERVICE_URL`, `INGESTION_SERVICE_URL`, `DATABASE_URL` (rating), `ANTHROPIC_API_KEY` (ingestion).
- **Dead ends / gotchas:**
  - In the Claude Code cloud sandbox, dockerd isn't running (start it with `dockerd &`).
  - Containers there can't use the HTTPS proxy, so `docker compose up --build` fails on pip/npm. `ghcr.io` blobs are also blocked, so don't `COPY --from=ghcr.io/astral-sh/uv`; install uv with pip.
  - Use `scripts/cloud-sandbox-build.sh`, which injects the proxy CA into temporary Dockerfile copies.
  - Stop the sandbox's own Postgres (`service postgresql stop`) so port 5432 is free.
- **How to show it:** `docker compose up --build`, open http://localhost:3000. Four green status cards.
