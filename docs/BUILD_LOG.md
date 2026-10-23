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

## step-02: Synthetic submission generator
- **Prompt used:** "Generate about 8 realistic E&S contractors GL submissions in mixed formats (fillable ACORD-style 125/126 PDFs, a flattened scan-style PDF, broker emails, a supplemental questionnaire, a Word application, loss runs) plus a ground-truth JSON for each."
- **What was built:** `samples/cases.py` holds the ground-truth data for 8 risks. `samples/generate.py` renders it into broker-style documents under `samples/submissions/<case>/` and writes `samples/ground_truth/<case>.json`.
- **Files:** `samples/{cases.py,generate.py,README.md}`, `samples/submissions/**`, `samples/ground_truth/*.json`
- **Commit:** `step-02: ...`
- **Decisions:**
  - Canonical submission schema (used by ingestion, web, and rating):
    - `applicant{name,dba,street,city,state,zip,fein,entity_type,years_in_business,website}`
    - `producer{agency,contact,email,phone}`
    - `policy{effective_date,expiration_date,occurrence_limit,aggregate_limit,products_aggregate_limit,deductible}`
    - `operations{description,class_code,states[],gross_receipts,payroll,employees,subcontracted_pct,subcontractor_coi_required,residential_pct,new_construction_pct,max_height_ft,wrap_up_projects}`
    - `loss_history[{date,description,incurred,status}]`
    - `prior{carrier,premium}`
    - Dates are ISO, money is whole dollars, percentages are 0–100.
  - Fillable PDFs use ACORD-like AcroForm field names (`NamedInsured_FullName_A`, `GeneralLiability_Hazard_Exposure_A`, ...), so ingestion can map them deterministically.
  - Class codes are ISO-like but illustrative: 92215 electrical, 98677 residential roofing, 98482 commercial plumbing, 91342 residential carpentry, 98304 painting, 91583 GC/remodel, 91560 concrete, 97050 HVAC.
  - Generated files are committed so the demo doesn't depend on running the generator.
- **Dead ends / gotchas:**
  - ReportLab's appearance stream for the long multiline description field shows on one line in some viewers. The field value is complete, so extraction is unaffected.
  - Run the generator with `uv run --with ...`; it isn't part of any service's dependencies.
- **How to show it:** open `samples/submissions/01-lone-star-electric/*.pdf` (a fillable form) next to `03-peachtree-plumbing` (flattened) and `05-desert-bloom-painting` (sparse email).
