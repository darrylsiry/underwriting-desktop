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

## step-05: Ingestion service — upload → classify → extract → submission JSON
- **Prompt used:** "Build the ingestion service: POST /ingest takes all the files for one submission, classifies each document, reads fillable ACORD-style PDFs deterministically from their form fields, sends everything else to Claude in one structured-output call, and merges it into the canonical submission JSON with a confidence, source quote, and method per field. Add an upload page, tests with a fake Claude, and an eval against the ground truth."
- **What was built:**
  - `POST /ingest` (multipart `files`, one submission per call) returns `submission` (canonical schema from step-02) plus `fields[]` (`value`, `confidence`, `method` = `form_field` / `claude` / `rule`, `document`, verbatim `source`, `alternatives` when documents disagree), `loss_history[]`, `documents[]` (type, confidence, reason), and review flags: `missing_for_rating`, `low_confidence` (< 0.8), `conflicts`, `warnings`.
  - Upload page at `:8002/` (one static HTML file, same look as the rating admin): drag-and-drop, document list with types, review flags, field table with confidence bars and source quotes, JSON toggle.
  - `eval_samples.py` scores all 8 samples against `samples/ground_truth` in parallel: **271/272 fields, 8/8 loss histories, ~20s** with `claude-opus-5-5` at effort `low`.
  - 23 tests with a fake Claude client (no key needed): classification, email attachments, deterministic ACORD extraction == ground truth, merge/conflict/dedupe, inferred expiration, refusal fallback, value coercion, API, key fallback.
- **Files:** `services/ingestion/app/{schema,documents,acord,claude_extract,pipeline,main}.py`, `services/ingestion/app/static/index.html`, `services/ingestion/{eval_samples.py,tests/test_pipeline.py,pyproject.toml,uv.lock}`, `docker-compose.yml`, `README.md`, `docs/PLAN.md`
- **Commit:** `step-05: ...`
- **Decisions:**
  - Pipeline: `documents.load` parses each upload (PDF via `pypdf`, `.docx` via `python-docx`, `.eml` via stdlib `email`; email attachments become their own documents with `parent`) → rule-based classifier on content signals (filled `NamedInsured_*` fields → `acord_application`; title words → `loss_run`, `supplemental_questionnaire`, `application`). Rules are free, instant, and explainable (`reason`); Claude can reclassify only `unknown` docs.
  - Fillable ACORD PDFs never go to Claude: the AcroForm map in `acord.py` gives confidence 1.0. **All other docs go to Claude in one request** (PDFs as base64 `document` blocks so scans also work, text/email/docx as text `document` blocks with a title), so it can read an email together with its attached loss run.
  - Claude call: `client.beta.messages.create`, `model=claude-opus-5-5`, `output_config={"effort": "low", "format": json_schema}`, plus `fallbacks="default"` with beta `server-side-fallback-2026-07-01` (a safety-classifier refusal reruns on the recommended fallback model). The schema has `path` as an enum of the 34 field paths and values as strings; Python `coerce()` turns them into canonical types (dates → ISO, `$1M` → 1000000, `45%` → 45, `Y`/`No` → bool, states → list). Override with `UW_INGEST_MODEL` / `UW_INGEST_EFFORT`. Effort `low` is ~5–20s per submission at 271/272; higher effort was not measured.
  - Confidence rubric is in the system prompt: ≥0.95 stated, 0.8–0.94 needs interpretation, 0.5–0.79 inferences (source starts `Inferred: …`). The class table is included so Claude can map a description to a code. It mirrors `services/rating/migrations/002_*` (keep in sync).
  - Merge: highest confidence wins per field; disagreeing values are kept as `alternatives` and listed in `conflicts`. Loss rows dedupe on (date, incurred). Missing expiration = effective + 1 year (`method: rule`, 0.7).
  - Stateless: no DB. Step 06 stores the result in the customer DB.
  - If the Claude call fails (no key, refusal, max_tokens, network), the response still has the deterministic fields plus a `warnings` entry.
- **Dead ends / gotchas:**
  - **API key name:** the Claude Code cloud sandbox reserves `ANTHROPIC_API_KEY` and doesn't pass it into sessions, so the key is stored as `UW_ANTHROPIC_API_KEY`. The service reads `UW_ANTHROPIC_API_KEY` first, then falls back to `ANTHROPIC_API_KEY` (`claude_extract.api_key()`), and passes it to `anthropic.Anthropic(api_key=...)` explicitly. `docker-compose.yml` maps `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-${UW_ANTHROPIC_API_KEY:-}}` so compose works with either name.
  - On `claude-opus-5-5`, don't send `thinking: {type: "disabled"}` or forced `tool_choice` (both 400). Use `output_config.format` for JSON instead of a forced tool.
  - Treat `state` like `str` when blanking (`""`, not `None`): the ground truth uses `""` for a missing state.
  - Only scale `K`/`M` suffixes for money fields, or "12 months" becomes 12,000,000 employees.
  - The one eval miss is 04 `wrap_up_projects`: the email never mentions wrap-ups, so blank is correct; the ground truth assumed `false`.
  - Tests read `samples/` from the repo, so run them from a checkout (not inside the Docker image).
- **How to show it:** open http://localhost:8002. Drop `samples/submissions/05-desert-bloom-painting/*.eml`: about 10s later the sparse email becomes a submission, with "Check (confidence < 80%)" flagging state, class code 98304, states, residential % 100 and expiration, each with Claude's "Inferred: …" reason. Then drop both `06-empire-builders-gc` PDFs: ACORD fields show `form_field` at 100%, questionnaire fields show `claude` with verbatim quotes, and the $410K open Labor Law 240 claim appears in loss history. Optionally run `uv run --project services/ingestion python services/ingestion/eval_samples.py` for the 271/272 score.
