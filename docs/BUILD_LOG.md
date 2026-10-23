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

## step-04: Rating admin UI with versioned, audited rate edits
- **Prompt used:** "Add a rate-table admin UI to the rating service at /admin: copy the active version into a draft, edit values one rating variable at a time (class rates, territory, ILF, deductible, ...) with a required reason, show what changed vs the base version, audit every change with before/after, and activate the draft to make it live. Add the same operations to the JSON API, with tests."
- **What was built:**
  - Server-rendered admin UI at http://localhost:8001/admin: version list, "new draft from" form, a per-variable editor with "was X" highlights and a changed-count per variable, an activate form, and a change history.
  - JSON API: `GET /rate-versions/{id}`, `POST /rate-versions` (draft), `POST /rate-versions/{id}/edits` (batch of class/factor/parameter edits), `POST /rate-versions/{id}/activate`, `GET /rate-table-audit`.
  - Migration `003` adds `rate_versions.based_on` and the append-only `rate_table_audit` table.
  - 10 new tests (22 total).
- **Files:** `services/rating/migrations/003_rate_table_audit.sql`, `services/rating/app/{repository,main,admin}.py`, `services/rating/app/templates/{base,versions,version,_audit}.html`, `services/rating/tests/{conftest,test_api,test_rate_admin}.py`, `services/rating/{pyproject.toml,uv.lock}`
- **Commit:** `step-04: ...`
- **Decisions:**
  - The admin UI lives **in the rating service** (FastAPI + Jinja2, plain HTML forms, no JS build), per the plan: the service that owns the rate tables owns their admin. Both the UI and the API call the same repository functions.
  - Only drafts are editable; active and retired versions are frozen (409). Activation retires the old active version in the same transaction, so `POST /rate` never sees a half-edited table. Drafts can be rated before go-live by passing `rate_version_id`.
  - One reason per save covers all values changed in that variable; each changed row gets its own audit row (`entity` like `territory:FL`, before/after as strings). Unchanged values are skipped, not audited.
  - "Who" is a free-text name remembered in a cookie (no auth yet; the demo can't depend on accounts).
  - Values must be > 0. Editing adds no new keys (no new states or classes); that would be a later step.
- **Dead ends / gotchas:**
  - The API test fixture moved to `tests/conftest.py` with session scope: psycopg's pool can't be reopened, so two module-scoped fixtures each starting the app fails.
  - `test_rate_admin.py` activates 2026.2, so it must sort after `test_api.py` (which expects 2026.1 active).
  - FastAPI serializes raw `Decimal`s in dict responses as JSON numbers (`1.35`), while audit before/after are stored as strings.
  - ILF keys contain `/`; form field names use `|` as the separator (`factor|ilf|1000000/2000000|value`).
  - Locally without uv, relock inside a container: `docker run --rm -v "$PWD":/app -w /app python:3.12-slim sh -c "pip install uv==0.11.32 && uv lock"`.
- **How to show it:** http://localhost:8001/admin → Create draft (2026.2) → Territory → change FL 1.25 → 1.35, give a reason, Save (the row shows "was 1.25", nav shows "1 changed") → Activate → the versions page shows 2026.1 retired and the audit trail. Then `POST /rate` for a Florida risk at :8001/docs shows 1.35 in the worksheet.

## step-05: Ingestion service (classify → extract → submission JSON with confidence)
- **Prompt used:** "Build the ingestion service: POST /extract takes every document in one submission (PDF, EML with attachments, DOCX), classifies each one, reads fillable ACORD-style PDFs from their form fields, sends everything else to Claude in one call with a strict JSON schema, and merges the results into the canonical submission JSON with per-field confidence, stated-vs-inferred basis, source document, and a quoted snippet. Add a scorer against samples/ground_truth and offline tests."
- **What was built:**
  - `POST /extract` (multipart `files`, optional `use_claude=false`) returns `submission` (the step-02 schema), `fields` (per-field value, confidence, method, basis, source document, snippet), `conflicts`, `missing_for_rating`, `documents` (type and method for each), `notes` (underwriting flags from Claude), `warnings`, and `claude` (model and token usage).
  - `python -m app.score /samples [-v] [--case 04] [--no-claude]` scores the pipeline against the ground truth. **Result: 250/251 fields correct, 0 wrong, 0 extra, every loss row matched**, about 2.5 minutes and about $0.50 for all 8 cases on Claude Opus 5.5.
  - 26 offline tests (no API calls).
- **Files:** `services/ingestion/app/{main,schema,documents,acord,claude,pipeline,score}.py`, `services/ingestion/tests/{conftest,test_ingestion}.py`, `services/ingestion/{pyproject.toml,uv.lock}`, `docker-compose.yml`
- **Commit:** `step-05: ...`
- **Decisions:**
  - **Classification is deterministic**: file type, ACORD field-name prefixes, and first-page title text ("LOSS RUN", "SUPPLEMENTAL QUESTIONNAIRE", "INSURANCE APPLICATION"). It's free and explainable, and it's enough for broker documents. Emails are unpacked: body plus each attachment, with `parent` recorded.
  - **Fillable ACORD PDFs never go to Claude.** A field map reads them at confidence 1.0 and the snippet is `FieldName = raw value`. The three fillable cases match the ground truth exactly with no API key.
  - **One Claude call per submission** covering every non-form document, so it can connect "loss runs attached" with the loss run. PDFs are sent as `document` blocks (Claude reads the page), and email and Word text as text `document` blocks titled with filename, type, and parent.
  - Values already read from form fields are passed to Claude as context. Without them, its notes wrongly called the FEIN and losses "missing".
  - Structured outputs (`output_config.format` JSON schema with `path` and `source_document` enums) guarantee parseable output. `value` is always a string that Python normalizes per field type ("$2.3M" → 2300000, "12/01/2026" → ISO, "Y" → true), and bad values become warnings.
  - `basis: stated|inferred` plus confidence bands in the prompt. Class codes come from the rating service's `/classes` (Claude can only pick codes we can rate). Expiration = effective + 1 year and "residential repaints" → 100% are allowed as inferences.
  - Merge order: form field > stated > inferred > confidence. Disagreements go in `conflicts` (case-insensitive). Loss rows are deduplicated by (date, incurred), preferring the loss run's wording.
  - Model `claude-opus-5-5` (override with `EXTRACTION_MODEL`), effort `medium`, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) so a classifier false positive doesn't block intake; a refusal or API error becomes a warning, not a 500.
  - Without `ANTHROPIC_API_KEY` the service still works: form fields only, plus a warning listing the unread documents.
- **Dead ends / gotchas:**
  - `uv lock` resolved **anthropic 2.1.0**. Check the API against the installed package (`inspect.signature(client.beta.messages.create)`) rather than 1.x memory. `fallbacks` and `output_config` are on `client.beta.messages.create`.
  - Ground truth includes facts the documents only imply (class code, expiration date in emails). Score "stated" and "inferred" values the same, but expect a blank where nothing supports a value. The only miss: the carpentry email never mentions wrap-up projects.
  - Use `docx` `iter_inner_content()` to keep headings next to their tables; `doc.paragraphs` + `doc.tables` loses the order.
  - Default a path from `__file__` lazily: `Path(...).parents[3]` raises inside a container even when `SAMPLES_DIR` is set.
  - Compose mounts `./samples` read-only into ingestion at `/samples` for the scorer and demo uploads, and sets `RATING_SERVICE_URL`.
- **How to show it:** http://localhost:8002/docs → `POST /extract` → upload `samples/submissions/05-desert-bloom-painting/*.eml` (a sparse email). Point out the inferred class code 98304 with its snippet, `missing_for_rating: []`, and the notes. Then upload case 06 (ACORD + questionnaire): form fields at 1.0, questionnaire fields from Claude, and notes flagging the open $410K Labor Law 240 claim. Finish with `docker compose exec ingestion python -m app.score /samples` for the 250/251 table.

## step-06: UW Desktop submission inbox and intake review
- **Prompt used:** "In the web app, build a submission inbox: upload a broker submission's documents, send them to the ingestion service, and store the submission, its original files, and the extraction in the customer DB. Add an intake review page that shows every field with its confidence, stated/inferred badge, source document and snippet, highlights what needs attention, lets the underwriter correct fields (validated, each correction audited with before/after), and accept the intake once the rating-required fields are present, creating the insured. Audit events go to an append-only table in the policy DB."
- **What was built:**
  - `/submissions` inbox: an upload form ("Reading documents…" while ingestion runs) and a table with reference, applicant, class, states, receipts, review flags ("2 missing", "5 to check", "looks complete"), status, and received time.
  - `/submissions/[id]` review:
    - The fields grouped by section, each with a confidence pill ("100% form", "85% Claude"), an "inferred" tag, an attention reason, and the quoted snippet with its source document and type. A colored left border marks red = required for rating, amber = check, indigo = corrected.
    - Loss history (open claims in red).
    - Side panels for accept, documents (original files, PDFs open inline), Claude's underwriting notes, document conflicts, and history.
  - `/submissions/[id]/documents/[docId]` serves the original uploads.
  - Header: nav (Submissions, Rate tables → rating `/admin`) and a "Working as" name stored in a cookie, which the audit trail records.
- **Files:** `web/migrations/customer/001_submissions.sql`, `web/migrations/policy/001_audit_events.sql`, `web/src/lib/{submission,submissions,audit,user}.ts`, `web/src/app/submissions/{page,upload-form,status-badge,actions}.tsx|ts`, `web/src/app/submissions/[id]/page.tsx`, `web/src/app/submissions/[id]/documents/[docId]/route.ts`, `web/src/app/{layout,page}.tsx`, `web/next.config.ts`
- **Commit:** `step-06: ...`
- **Decisions:**
  - `submissions.extraction` stores the full `/extract` response and is never edited; `submissions.data` is the reviewed copy. `corrected_fields` lists the paths the underwriter changed, so the UI can show "extracted value: X" next to a correction. Original files are stored as `bytea` in `submission_documents`.
  - References are `SUB-0001` from a sequence. Accepting needs the six rating-required fields and a named insured. It finds the insured by FEIN or creates one, sets `status = accepted`, and makes the page read-only (step 07 edits rating inputs on the workbench).
  - `audit_events` (policy DB, per the plan) is generic: actor, action (`submission.received`, `submission.field_corrected`, `insured.created`, `submission.accepted`), entity, summary, before/after JSON, and a correlation ID shared by the events from one click. Step 11 builds the unified viewer on it.
  - Server actions plus plain forms; redirects carry `?msg=`/`?error=`. The upload form is the only client component (`useActionState`/`useFormStatus` for the pending state).
  - The TypeScript field list (`SECTIONS`) mirrors ingestion's `FIELDS`, with display types (money, pct) and input parsing/validation (`fromInput`): 2-letter states, numbers, 0–100 percentages, yes/no, YYYY-MM-DD.
  - "Needs attention" means: empty and required for rating, documents disagree, inferred, or confidence < 0.9.
- **Dead ends / gotchas:**
  - Next.js server actions reject request bodies over 1 MB by default. Set `experimental.serverActions.bodySizeLimit: "25mb"` or multi-PDF uploads fail.
  - The page files can only export the page (Next.js 15 type check). Shared components like `StatusBadge` go in their own module.
  - Grids with `1fr` columns grow to fit `truncate`d one-line snippets (min-content width) and push the page sideways. Use `minmax(0,1fr)`.
  - `await` inside a JSX prop trips `jsx-ast-utils` in ESLint. Assign it to a variable first.
  - Locally: `npm --prefix web ci`, then `npx next dev --port 3100` in `web/` against the compose DB/services (port 3000 may be taken). The env defaults point at localhost.
  - Browser automation can't use a native file picker. For testing, serve `samples/submissions` with CORS and set `input.files` from a `DataTransfer` in page script.
- **How to show it:** http://localhost:3000 → Open the submission inbox → upload `samples/submissions/05-desert-bloom-painting/*.eml` → after about 20 s the review page shows inferred class 98304, low-confidence flags, and Claude's notes. Type a FEIN and entity type "from the broker's call" → Save corrections (marked "Corrected by underwriter") → Accept intake → the History panel shows each correction with before → after. Then upload case 01's two PDFs: everything is "100% form" and the inbox says "looks complete".

## step-07: Underwriting workbench (rating inputs, schedule mods, referrals)
- **Prompt used:** "Add an underwriting workbench for accepted submissions: a worksheet seeded from the reviewed submission with editable rating inputs, schedule credits/debits by category (±10% each, a written reason required), and an experience mod. Save & rate calls the rating service and shows the indicative premium with its worksheet. Add deterministic referral rules (large open claim, loss frequency, uninsured subs, NY Labor Law, height, roofing, receipts/limits/schedule authority, plus warnings for new ventures, inferred class, missing loss runs), each clearable with a written note. Audit every change; show Ready to quote when the rating is current and no referral is open."
- **What was built:**
  - `/submissions/[id]/workbench`:
    - Left: a rating inputs form and a schedule rating table (credits green, debits red, total and mod in the header).
    - Right: an indicative premium card (total, premium, fee, SL tax, the rating service's step-by-step worksheet, and a stale-rating warning), a referrals panel (refer/warn badges, evidence, a "Clear" form with a note, then "cleared" with who and why), and the worksheet history.
  - A status chip: Not rated / N referrals open / Ready to quote. Links from the accepted review page ("Open underwriting workbench →") and from the inbox ("Workbench →").
  - Referral rules as a pure function, plus the first web unit tests (7, using Node's built-in `node --test`; `npm test`).
- **Files:** `web/migrations/customer/002_worksheets.sql`, `web/src/lib/{worksheet,worksheets,referrals,referrals.test}.ts`, `web/src/app/submissions/[id]/workbench/{page.tsx,actions.ts}`, `web/src/app/submissions/{page.tsx,[id]/page.tsx,actions.ts}`, `web/{package.json,tsconfig.json}`
- **Commit:** `step-07: ...`
- **Decisions:**
  - One `worksheets` row per submission (customer DB): `rating_inputs` (the rating service's `RatingInput`), `schedule` (`[{category, pct, rationale}]`), `referral_clearances` (code → `{by, at, note}`), `last_rating` (the `POST /rate` response), and `rated_inputs_hash`. It's created when the workbench is first opened. Inputs are seeded from the reviewed submission; unknowns get neutral defaults (deductible 0, COIs yes, mod 1.0).
  - Schedule rating uses six IRPM-style categories, ±10% each, with a reason of at least 10 characters for any non-zero entry. Schedule mod = 1 + total/100 (rating still enforces 0.75–1.25). More than ±15% total trips a `SCHEDULE_AUTHORITY` referral.
  - Rules live in `lib/referrals.ts` as a pure function with thresholds in `LIMITS`. They are recalculated on every render, so changing an input changes the flags immediately. "refer" blocks Ready to quote until cleared; "warn" is informational. A clearance is keyed by rule code and stays after later edits.
  - The rating call sends `reference` (SUB-000N) and `requested_by`, so the rating service's own `rating_log` ties back to the submission. If rating fails (422 such as "Experience mod 2 is outside 0.80–1.50"), the inputs stay saved, `last_rating` is cleared, and the message is shown.
  - Audit events: `worksheet.opened`, `worksheet.input_changed` (before/after per field), `worksheet.schedule_changed` (before/after arrays), `worksheet.rated` (rating_id, premium, total, mod), `referral.cleared` (the flag and the clearance). Events from one save share a correlation ID.
  - The "Working as" form now returns to the current page (Referer path) instead of the inbox.
- **Dead ends / gotchas:**
  - **jsonb reorders object keys.** A `JSON.stringify(inputs)` fingerprint saved and compared after a round trip never matches, so every rating looked stale. Fingerprint values in a fixed key order (`INPUT_DEFS`). A regression test covers it.
  - node-postgres sends JS arrays as Postgres arrays, not JSON. `JSON.stringify` arrays bound for `jsonb` columns (`schedule`); objects are fine.
  - `node --test` runs `.ts` directly on Node 23.6+ (type stripping), but imports need explicit `.ts` extensions and the imported modules may only use `import type` from files that don't. `tsconfig` needs `allowImportingTsExtensions`. Use `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` to quiet the warning.
- **How to show it:** accept SUB-0003 (upload `samples/submissions/02-gulf-coast-roofing/*.pdf`) → Open underwriting workbench → Save & rate shows about $190K premium and four flags. Add debits +10% loss experience and +8% subcontractor controls with reasons → Save & rate: total +18%, a fourth "Schedule mod above authority" referral, and the worksheet shows × 1.18. Switch "Working as" to a manager and clear the roofing referral with a note. Then open the Desert Bloom (SUB-0001) workbench: a −5% safety credit and $1,000 deductible give $5,777 and **Ready to quote**.
