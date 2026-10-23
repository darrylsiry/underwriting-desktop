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

## step-03: Rating engine with versioned rate tables
- **Prompt used:** "Build the rating service: versioned rate tables in the rating DB (class base rates per $1,000 receipts, territory, ILF, deductible, residential, subcontracting, height, uninsured-sub load, schedule/experience mod bounds, policy fee, surplus lines tax by state), a POST /rate endpoint that returns a step-by-step worksheet and logs every call, and tests."
- **What was built:**
  - A pure `rate(tables, input)` function plus a DB-backed API: `POST /rate`, `GET /ratings/{id}`, `GET /classes`, `GET /rate-versions`.
  - Every call is stored in `rating_log` with its request, result, rate version, reference, and requester.
  - 12 tests: engine unit tests plus API tests against a throwaway `rating_test` DB.
- **Files:** `services/rating/migrations/{001_schema,002_seed_rates_2026_1}.sql`, `services/rating/app/{engine,repository,main}.py`, `services/rating/tests/{test_engine,test_api}.py`
- **Commit:** `step-03: ...`
- **Decisions:**
  - Formula: `base_rate × receipts/1000 × territory(worst state) × ILF(occ/agg) × deductible × residential × subcontracting × [no-sub-COI 1.25] × height × experience mod × schedule mod`, floored at the class minimum. Total = premium + $250 fee + surplus lines tax (home state) on both.
  - Factors live in one `factors` table with `kind` `exact` (territory, ILF) or `band` (largest lower bound ≤ input).
  - Scalar settings live in `parameters`; tax keys are `sl_tax.<STATE>`.
  - `Decimal` throughout, rounded to whole dollars.
  - Exactly one `active` version (partial unique index). Requests can pin `rate_version_id`, and quotes will store it.
  - Unrateable input (unknown class, state, or limit; mod out of bounds) returns 422 with a readable message.
- **Dead ends / gotchas:** none significant. Hand-check expected premiums carefully in tests (49,738.26 rounds to 49,738).
- **How to show it:** http://localhost:8001/docs (Swagger), then POST /rate with the Lone Star Electric example from `tests/test_api.py`. All 8 sample risks rate between about $6K and $400K total.

## step-04: Rating admin UI — versioned, audited rate-table edits
- **Prompt used:** "Add a rate-table admin UI to the rating service at /admin: clone the active version into a draft, edit each rating variable's table (class rates, every factor, fees/taxes/mod bounds) with changes highlighted against the source version, preview the premium impact on the 8 sample risks, and activate the draft. Audit every change with who/what/before/after."
- **What was built:**
  - Admin JSON API under `/admin/api` (create draft, replace one variable's table, impact preview, activate, audit trail) and a single-page UI at `/admin`, both served by the rating service.
  - Only drafts are editable. Activating one retires the current active version in the same transaction. Every change writes a `rate_table_audit` row with actor (`X-User` header), summary (`TX: 1.1 → 1.21`), and before/after rows.
  - The impact preview rates a fixed "benchmark book" (the 8 sample risks) on the draft vs. the active version, without writing to `rating_log`.
  - 4 new API tests (16 total).
- **Files:** `services/rating/migrations/003_admin_audit.sql`, `services/rating/app/{admin.py,benchmark_risks.json,static/admin.html}`, `services/rating/app/main.py` (router), `services/rating/tests/{conftest.py,test_admin.py}`, `services/rating/tests/test_api.py` (fixture moved to conftest)
- **Commit:** `step-04: ...`
- **Decisions:**
  - The UI is one static HTML file with vanilla JS, served by FastAPI. No build step, no new dependencies, and it stays clearly "a second UI on a separate service".
  - Edits are **per variable**: `PUT /admin/api/versions/{id}/factors/{factor}` (or `/classes`, `/parameters`) replaces that whole table. This matches the tabbed UI, keeps adding/removing bands simple, and gives one audit row per save. Saving an unchanged table is a no-op (no audit row).
  - Numbers are compared canonically (`1.60` == `"1.6"`), so the summaries and no-op detection don't trip over formatting.
  - `rate_versions.based_on` records the clone source. The UI highlights changed cells (with "was …"), added rows, and removed rows against it, and puts a dot on changed tabs.
  - Validation: factors > 0; band keys must be numeric; schedule/experience mod bounds must stay present and bracket 1.0; duplicate keys rejected; labels unique. Removing a class is allowed, and the impact preview then shows the affected risk as unrateable.
  - `benchmark_risks.json` was generated once from `samples/ground_truth/*.json` (nulls dropped so engine defaults apply), because the rating service's Docker context can't see `samples/`.
  - Drafts can already be rated with `POST /rate {"rate_version_id": N}`, so quotes can be test-priced before activation.
- **Dead ends / gotchas:**
  - The DB `client` fixture had to move to `tests/conftest.py` with session scope. Importing a module-scoped fixture into a second test file reopens the closed global pool (`PoolClosed`).
  - `test_admin` activates 2026.2, and the step-03 tests expect 2026.1. A fixture flips 2026.1 back to active after that test.
  - Don't re-render the table on every input `change` event, because it steals focus when you tab between cells. Highlights refresh on save.
- **How to show it:** open http://localhost:8001/admin. Click **+ New draft** (label `2026.2`, note "Texas +10%"). Open the **Territory** tab, change TX 1.1 → 1.21 and NY 1.6 → 1.68, then **Save**: the cells turn yellow with "was 1.1". Click **Preview impact**: Lone Star Electric +10.0%, Empire Builders +5.0%, book +2.8%. Click **Activate**: 2026.1 is retired, and the change history shows each step with who made it.
