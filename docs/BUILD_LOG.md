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

## step-08: Rate via API → persisted quote → quote PDF
- **Prompt used:** "When a worksheet is ready to quote, let the underwriter issue a quote: confirm the effective/expiration dates and subjectivities (suggested from the file's warnings), rate again through the rating API pinned to the rate version they saw, store a numbered, versioned quote in the policy DB (re-quoting supersedes the previous version) with the rating_id, inputs and terms, and generate a quote PDF stored with it. Add a Quotes list and audit events."
- **What was built:**
  - A Quote card on the workbench (above Indicative premium). It lists each version with status, total and PDF link. When ready it shows the issue form: effective, expiration (defaults to +1 year), and subjectivities one per line, prefilled from the latest version or from suggestions. Otherwise it explains what's blocking.
  - `/quotes` lists every version (superseded ones greyed out) with its PDF. `/quotes/[id]/pdf` serves the stored PDF inline as `Q-2026-0001-v2.pdf`. "Quotes" is in the nav.
  - Quote PDF, one page on Letter: masthead (quote number and version, issued date, valid-until date, underwriter), named insured and producer, policy period, limits and deductible, class and exposure, premium/fee/SL tax/total with the rate version, numbered subjectivities, forms and endorsements, the surplus lines notice, and an "illustrative, not an offer" footer.
  - 11 web unit tests (adds subjectivity suggestions and cleaning, dates, and the forms list).
- **Files:** `web/migrations/policy/002_quotes.sql`, `web/src/lib/{quotes,quote-pdf,quote-terms,quote-terms.test}.ts`, `web/src/app/quotes/{page.tsx,[id]/pdf/route.ts}`, `web/src/app/submissions/[id]/workbench/{page.tsx,actions.ts}`, `web/src/app/layout.tsx`, `web/{package.json,package-lock.json}`
- **Commit:** `step-08: ...`
- **Decisions:**
  - **Quotes live in the policy DB** and are frozen at issue: `rating_inputs`, `schedule`, the full `rating` response, money columns, `subjectivities`, `terms` (address, producer, limits, deductible, class, operations, forms), and the **PDF itself as `bytea`**. The PDF is the document of record and is never regenerated; v1 keeps its original PDF even after the layout changed.
  - Numbering: `Q-<year>-<seq>` stays the same across versions, and `version` increments. Issuing a new version sets the previous `issued` one to `superseded` in the same transaction. Status `bound` is reserved for step 09.
  - **Rated again through the API at issue**, with `rate_version_id` pinned to the worksheet's rating and `reference = "Q-2026-0001 v2"`, so the rating service's `rating_log` has a row per quote. If the total differs from what the worksheet showed, issuing stops ("Save & rate again"). It's also refused unless the worksheet is current and no referral is open (the server checks; the UI just hides the form).
  - Subjectivities are suggested from the flags: signed application always, then loss runs, class confirmation, subcontract wording, NY risk transfer, open-claim status, and missing street/ZIP/FEIN. The underwriter edits them as plain lines; list markers are stripped, but a leading number like "5 years" is kept.
  - Forms (illustrative names) follow the exposures: base CGL form plus Classification Limitation, Pollution, and Earth Movement; then Independent Contractors if subcontracting, Residential Limitation if any residential, Action Over/Labor Law if NY, and a Roofing endorsement for 98677.
  - PDF via **pdf-lib 1.17.1** (pure JS, standard Helvetica, no font files, so it works in the Next standalone image). A small `Writer` handles headings, label/value rows with right-aligned amounts, word wrap, and page breaks with a footer on every page.
  - Valid for 30 days. Audit: `quote.issued` on the quote and on the submission (so it shows in the workbench history), plus `quote.superseded` on the previous version.
- **Dead ends / gotchas:**
  - Standard PDF fonts only encode WinAnsi. `pdfSafe()` maps or replaces other characters (arrows, odd hyphens, emoji) so `drawText` never throws on broker-supplied text.
  - The trailing "Underwriter:" line pushed onto an otherwise empty page 2. It's now in the masthead.
  - `date` columns come back from node-postgres as JS `Date` (time zone shifts). Select them as `::text` for `YYYY-MM-DD`.
  - A first draft of the subjectivity cleaner stripped all leading digits ("5 years of loss runs" → "years of loss runs"). It now only strips real list markers, and a test covers it.
- **How to show it:** open the Desert Bloom workbench (Ready to quote) → the Quote card shows suggested subjectivities → **Issue quote** → click PDF. Change the deductible to $2,500 → Save & rate → **Issue revised quote (v2)** → `/quotes` shows v2 issued and v1 superseded, each with its own PDF. The roofing file says "Clear 3 open referrals to quote."

## step-09: Bind → binder PDF and policy document PDF
- **Prompt used:** "Let the underwriter bind the latest issued quote from the workbench: tick the subjectivities already received (the rest stay open, due in 30 days), refuse superseded, bound or expired quotes, then create a policy in the policy DB on the quoted terms with a policy number and binder number, mark the quote bound, and generate and store a one-page binder and a policy document (declarations, classification schedule, premium, forms schedule, abridged conditions). Add a Policies list and audit events, and share the PDF layout code with the quote."
- **What was built:**
  - Workbench Quote card: for the latest issued quote, a **Bind** box with a checkbox per subjectivity and a "Bind · $X" button (or the reason it can't be bound). "Revise quote" moved under a toggle. After binding the card becomes **Policy**: a "Bound · GL-26-00001" panel with binder and policy PDF links and the open subjectivities with due dates. The status chip reads Ready to quote → Quoted · Q-… → Bound · GL-….
  - `/policies` list (policy and source quote, period, total, "2 open, due …" or "all received", who bound it, Binder · Policy links). `/policies/[id]/binder` and `/policies/[id]/policy` serve the stored PDFs. "Policies" is in the nav.
  - **Binder** (1 page): binder number, bound date and by whom, "policy … to follow", binder period (until the policy is issued or 30 days), limits, class/basis, premium, subjectivities with **Received / OPEN - due date**, terms referencing the quote version and rate version, the authorized representative, and the SL notice.
  - **Policy** (2 pages): declarations (policy period, limits, classification schedule with basis and premium, premium summary, forms forming part of the policy, SL notice), then abridged common conditions (cancellation, subjectivities, changes, premium audit, subcontractors, representations) and a countersignature.
  - `lib/pdf-writer.ts`: the layout code from step 08 (`Writer`, `pdfSafe`, colors, money/date helpers) plus shared blocks (`createDocument`, `masthead`, `parties`, `premiumBlock`, `surplusLinesNotice`). Quote, binder, and policy all use it; the quote PDF is byte-for-byte the same size as before the refactor.
  - 15 web unit tests (adds bind blockers, subjectivity status/due dates, and numbering).
- **Files:** `web/migrations/policy/003_policies.sql`, `web/src/lib/{pdf-writer,policy-pdf,policies,bind-rules,bind-rules.test}.ts`, `web/src/lib/{quote-pdf,quotes}.ts`, `web/src/app/policies/{page.tsx,[id]/[kind]/route.ts}`, `web/src/app/submissions/[id]/workbench/{page.tsx,actions.ts}`, `web/src/app/layout.tsx`
- **Commit:** `step-09: ...`
- **Decisions:**
  - **Binding accepts the quote as issued.** It does no re-rating: the premium, terms, forms and rate version come from the quote row. The policy row copies the money columns and keeps `quote_id` (unique, so one policy per quote).
  - Numbers: `GL-<yy>-<seq>` and `BND-<yy>-<seq>` share one sequence (the binder number matches the policy number). The year comes from the effective date.
  - Subjectivities on the policy are `[{text, status: received|open, due_date}]`; open ones are due 30 days after binding. The binder states the consequence ("may amend or cancel coverage").
  - Concurrency: `SELECT … FOR UPDATE` on the quote inside the bind transaction, and blockers are re-checked under the lock, so a double click can't bind twice. The quote becomes `bound` in the same transaction.
  - Blockers (`bindBlockers`, pure): superseded, already bound, past `valid_until`, or a policy period that has already ended. `issueQuote` now also refuses to re-quote a bound submission ("changes now need a policy endorsement").
  - Audit: `quote.bound` (before/after status), `policy.bound` on the policy (with binder number and subjectivities), and on the submission (shows in the workbench history). They share a correlation ID.
  - Binder and policy PDFs are generated once at binding and stored (`binder_pdf`, `policy_pdf`), like quotes.
- **Dead ends / gotchas:**
  - Moving the `pdfSafe` regex between files: its character class contains literal non-ASCII characters (en dash, curly quotes, bullet), so copy the bytes rather than retyping.
  - The browser driver's checkbox clicks both reported the same screen point; verify with `input.checked` before submitting rather than trusting the click log.
- **How to show it:** open the Desert Bloom workbench (Quoted) → in **Bind Q-2026-0001 v…**, tick "Signed and dated application" and "Confirmation of operations and class code" → **Bind** → the card shows **Bound · GL-26-00001** and the two open subjectivities due in 30 days. Open the Binder PDF (Received / OPEN - due …), then the Policy PDF (declarations plus conditions page). `/policies` lists it with "2 open, due …"; `/quotes` shows the bound version and earlier versions superseded.

## step-10: Search and inspect customers, submissions, quotes and policies
- **Prompt used:** "Add a search box to the header that searches insureds (name, FEIN), submissions (reference, applicant, broker, class code), quotes (number with version, insured, submission ref) and policies (policy or binder number, insured) across both databases, with exact references jumping straight to the record. Add a Customers list and a customer page with their submissions, quotes, policies and written premium, plus detail pages for a quote (terms, rating worksheet, internal underwriting basis, subjectivities, versions) and a policy (coverage, subjectivity status, documents). Link everything to everything."
- **What was built:**
  - Header search box (`GET /search?q=`) and a `/search` page with four result panels and counts.
    - A full reference (`SUB-0001`, `Q-2026-0001 v2`, `GL-26-00001`, `BND-26-00001`) that matches one record **redirects straight to it** (add `&all=1` to see the list).
  - `/insureds` list (FEIN, state, submissions, policies, written premium, open subjectivities) and `/insureds/[id]` (stat tiles, then policies, quotes with versions and statuses, and submissions with workbench links).
  - `/quotes/[id]`: terms (period, limits, deductible, class, receipts, states, forms), the rating worksheet with the rating_id and rate version, the **underwriting basis (internal)** (rating inputs and each schedule credit/debit with its written reason), premium, subjectivities, and all versions of that quote number.
  - `/policies/[id]`: coverage and premium, each subjectivity received or open with its due date, policy and binder PDFs, and links to the source quote version, workbench and customer.
  - Cross-links: quote and policy numbers in lists, the workbench Quote card, the policy panel, and the review page ("customer record") now open the detail pages. "Customers" is in the nav.
  - `components/ui.tsx` (Section, Pill, Empty, RowLink, money, when) for the new pages.
  - 18 web unit tests (adds query parsing: reference detection and LIKE escaping).
- **Files:** `web/src/lib/{search,search-terms,search-terms.test,insureds}.ts`, `web/src/lib/{quotes,policies}.ts`, `web/src/components/ui.tsx`, `web/src/app/{search,insureds,insureds/[id],quotes/[id],policies/[id]}/page.tsx`, `web/src/app/{layout.tsx,quotes/page.tsx,policies/page.tsx}`, `web/src/app/submissions/[id]/{page.tsx,workbench/page.tsx}`
- **Commit:** `step-10: ...`
- **Decisions:**
  - **No search index.** Four parallel `ILIKE '%term%'` queries, two per database, each limited to 25 rows. That's plenty at demo scale and keeps step 10 dependency-free; a `pg_trgm` GIN index is the upgrade path.
  - `parseQuery` (pure): trims to 100 characters, needs at least 2, escapes `%`, `_`, `\` so input is never a wildcard, and recognizes reference shapes (SUB-, Q-yyyy-n [vN], GL-yy-n, BND-yy-n, FEIN `NN-NNNNNNN`, 5-digit class). Exact matches sort first in SQL (`ORDER BY (upper(ref) = upper($2)) DESC`).
  - Submissions also match by broker agency (`data->'producer'->>'agency'`), exact FEIN, or exact class code from the reviewed JSON.
  - Customers aggregate across databases in app code: submission counts from customer and policy counts / written premium / open subjectivities from policy (`jsonb_array_elements` count), joined by `insured_id`. "Written premium" is premium without fee and tax, on both the list and detail pages.
  - The quote page shows the schedule rationales as **internal** (they're not on the broker-facing PDF).
- **Dead ends / gotchas:**
  - React fragments inside `.map` need `<Fragment key=…>`, because `<>` can't take a key. ESLint didn't flag it.
  - The header got crowded once search was added. It now uses `flex-wrap`, a narrower search input below `lg`, and the "Working as" label is `sr-only` (still read by screen readers) until `xl`.
  - The first version showed written premium including fee and tax on the customer page but premium-only on the list. Pick one definition.
- **How to show it:** type "copper" in the header (finds Desert Bloom through its broker) → open the customer from `/insureds` → click the bound quote → scroll to the rating worksheet and the internal basis with the "−5% Safety program" reason → then type `BND-26-00001` in search and land on the policy with its open subjectivities.

## Fixes from the first code review (CR-001 … CR-016)
`docs/CODE_REVIEW.md` (from the read-only code-auditor) found 13 bugs plus three suggestions. All the bugs and the bug-like suggestion CR-016 are fixed, one commit each (`git log --grep CR-0`). When replaying steps in the live repo, build these in from the start:
- **jsonb reorders object keys, everywhere.** Never compare `JSON.stringify` of a value read back from jsonb with a freshly built one; use a fixed-order key (`scheduleKey`, `inputsHash`). (CR-001)
- **Header values must be Latin-1.** Use `contentDisposition()` (ASCII fallback plus RFC 5987 `filename*`) for any user-supplied filename. (CR-002)
- **No blocking work in `async def`.** In FastAPI, run psycopg calls, PDF parsing, and the synchronous Anthropic client through `run_in_threadpool` (or use plain `def` handlers). Otherwise `/health` hangs for the whole extraction. (CR-003, CR-009)
- **A rating is current only on the active rate version.** `readiness()` takes the active version from rating `/health`; `issueQuote` refuses stale rates. (CR-004)
- **A referral clearance records the flag detail it cleared** and stops counting when that detail changes. (CR-005)
- **Read-modify-write in one transaction** with `SELECT … FOR UPDATE` and a status predicate on the UPDATE. The review form also carries a data fingerprint, so a stale form is refused instead of reverting someone else's edits (a gap the report didn't name). (CR-006)
- Validate every id path segment before it reaches a uuid cast; type FastAPI ids as `uuid.UUID`. Make redirects from Referer same-host and local-path only. (CR-007, CR-008, CR-016)
- Name the target columns in `INSERT … SELECT`. Dedupe loss rows across documents, never within one. Compose healthchecks: ingestion and web wait for a healthy rating service. Cap `/extract` uploads. (CR-010 … CR-013, CR-016)
- Not done: CR-014 (broader test suites; each fix above added its own regression test) and CR-015 (a shared `schema.json` contract test between Python and TypeScript).

## step-11: Unified audit trail viewer
- **Prompt used:** "Build one audit timeline across services: UW Desktop events (policy.audit_events), rate-table changes and every rating call (from the rating service API). Filter by text, source, record type, person and date; group events from one click by correlation id; show before → after per field; and add a case view for one submission (its quotes, policies, insured and rating calls), linked from the workbench, review, quote and policy pages."
- **What was built:**
  - `/audit` (nav: **Audit**): filter bar (search, source, record, who, from/to), counts per source, and a newest-first list of cards. Each card shows time, a source badge (UW Desktop / Rate admin / Rating engine), actor, action, a link to the record (SUB-…, Q-… vN, GL-…, insured, or the rate version's admin page), the summary, and a field table with **before (struck through) → after**. Events from one click share a card ("One action by … · N events").
  - **Case view** `/audit?submission=<id>`: the submission, all its quote versions, its policy and insured, plus rating calls referencing `SUB-…` or its quote numbers. Linked as "Case history" from the workbench, review, quote and policy pages.
  - Rating service: `GET /ratings?reference_prefix=&limit=` (rating calls with rate version label, class, premium, total) and a `limit` on `GET /rate-table-audit`. 26 rating tests.
  - `lib/timeline-merge.ts` (pure, 7 tests): normalizes the three sources into one `TimelineEvent`, merges newest first, computes field-level `changes`, groups by correlation, applies filters, and formats values for display.
- **Files:** `services/rating/app/{main,repository}.py`, `services/rating/tests/test_api.py`, `web/src/lib/{timeline,timeline-merge,timeline-merge.test}.ts`, `web/src/app/audit/page.tsx`, `web/src/app/{layout.tsx,quotes/[id]/page.tsx,policies/[id]/page.tsx}`, `web/src/app/submissions/[id]/{page.tsx,workbench/page.tsx}`
- **Commit:** `step-11: ...`
- **Decisions:**
  - **The web app reads the rating service's audit data over its API**, not its database. Each service owns its database (PLAN.md), so the viewer works however the rating service stores things. If rating is unreachable the page still loads with UW Desktop events and a warning.
  - Merged in app code (at most 500 per source, filtered in memory) rather than a cross-database view. Fine at demo scale; a real system would ship events to one store (an outbox or log pipeline) and query that.
  - Case scope: desktop events where `(entity_type, entity_id)` is in {submission, its quotes, policies, insured} via `unnest`; rating calls by reference prefix (`SUB-0003`, `Q-2026-0001`, so all versions).
  - **Grouping across services:** rating calls carry no correlation id, so an uncorrelated event that sits between two events of the same action, within 5 s, joins that action. Save & rate then reads as schedule changed → engine rated → worksheet rated, as one card.
  - Display: schedules as "safety -5%", subjectivities as "text: open (due …)", other objects as compact JSON (cut at 140 chars).
- **Dead ends / gotchas:**
  - The first version showed one Save & rate as three cards, because the engine call in the middle broke the correlation run. Hence the sandwich rule (tested).
  - psycopg: a literal `%` in SQL with named parameters must be doubled (`LIKE %(p)s || '%%'`).
  - Events recorded before the CR-001 fix still include false `schedule_changed` rows; the audit is append-only, so they stay.
- **How to show it:** open the roofing workbench → **Case history →**. The top card is the last Save & rate as one action (schedule +18% → +20%, the engine call, the rating), then referral clearances with who and why. Filter Source = Rate admin to see the Florida territory change (1.25 → 1.35) with its reason and activation. Search "bound" in Desert Bloom's case history to see quote v3 bound as GL-26-00001, with subjectivities received/open.

## Tooling: recurring, read-only UX review (`/ux-audit`)
- **Prompt used:** "Create a design/UX agent that examines this application entirely from a usability standpoint. It should not share any memory with other agents in this repo, only care about optimizing the UX/UI, and make specific recommendations I can consider, each explaining why the improvement benefits the user, with before/after mockups where possible. It should run every 24 hours, maintain a list of outstanding items, and recognize changes that were made."
- **What was built:**
  - `.claude/agents/ux-reviewer.md`: a read-only subagent (Read, Grep, Glob, Bash for reading and local `GET`s only) that walks four personas (underwriter, manager, rate-table admin, broker reading the PDFs) through every screen, template, document and flow. It rates findings P1 Blocker → P4 Polish with an S/M/L effort, and every P1/P2 carries **Who / when**, **What the user experiences**, **Why it matters** (the benefit, from the user's side), a concrete **Recommendation** with copy, an inline ASCII **before/after**, and **Verify**. Up to six findings per run also get a self-contained HTML mockup (Before and After side by side) in `docs/ux-mockups/UX-NNN.html`.
  - Findings carry stable `UX-NNN` IDs. Each run re-verifies the previous report: unchanged items stay `Open` with their first-seen date, partly addressed ones become `Improved`, fixed ones move to **Resolved since last run** (with the commit), and screens changed since the previous run are judged fresh for regressions. An **Outstanding items** table at the top is the backlog. A human can mark a finding `Declined` with a reason; the reviewer leaves those alone.
  - `.claude/commands/ux-audit.md`: the orchestrator. Checks `scripts/ux-review-fingerprint.sh` (UI paths only, so backend-only commits do not trigger a review), spawns the reviewer, splits the mockup appendix into files, writes `docs/UX_REVIEW.md`, removes mockups for resolved items, records the fingerprint. `/ux-audit force` bypasses the skip.
  - Scheduled task `ux-review-underwriting-desktop` (daily, 07:30 local, Auto mode) runs the same steps from a fresh session with no memory.
- **Files:** `.claude/agents/ux-reviewer.md`, `.claude/commands/ux-audit.md`, `scripts/ux-review-fingerprint.sh`, `.gitignore`, `docs/UX_REVIEW.md`, `docs/ux-mockups/`
- **Decisions:**
  - **Isolation by construction, not by promise.** The reviewer's only inputs are UI source, the three planning docs, the running app (read-only GETs) and its own previous report. It is told not to read `~/.claude/`, other reports (`CODE_REVIEW.md`, `SECURITY_REVIEW.md`) or `.env`, so it cannot be anchored by other agents' concerns.
  - **Recommendations, not a to-do list.** Unlike the code and security reports, the UX report is explicitly for a human to choose from; coding agents build only chosen items and keep the ID in the commit message.
  - Mockups are emitted by the reviewer inside the report (fenced `html file=docs/ux-mockups/UX-NNN.html` blocks) and split out by the orchestrator, because the reviewer itself may not write files. Only New or materially changed findings get a new mockup, so runs stay short.
  - The reviewer never starts the stack; it reviews rendered HTML only when `localhost:3000` already answers, and says which in Coverage notes.
- **Dead ends / gotchas:**
  - A UI-only fingerprint needs `git ls-tree -r HEAD -- <paths>` plus `git diff HEAD` plus untracked files; `git rev-parse HEAD` alone would re-trigger on every backend commit.
- **How to show it:** run `/ux-audit`, open `docs/UX_REVIEW.md` and one `docs/ux-mockups/UX-00N.html` in a browser; make one of the recommended changes, run `/ux-audit force`, and the item moves to Resolved.

## step-12: Fly.io deploy (fly.toml per service, secrets, private networking)
- **Prompt used:** "Make the stack deployable to Fly.io: a fly.toml per service, one Managed Postgres cluster with the customer/policy/rating databases attached as secrets, rating and ingestion private on Flycast with no public IPs, web public behind a password gate with the rate admin proxied through it, and an idempotent deploy script. Harden the containers (non-root, no .env in images) and bind local compose ports to localhost. Verify everything locally; don't deploy without approval."
- **What was built:**
  - `services/rating/fly.toml`, `services/ingestion/fly.toml`, `web/fly.toml` (all pass `fly config validate`). Private services have `force_https = false` (Flycast is plain HTTP inside the private network) and auto-stop/start. Web forces HTTPS and its health check is `/api/live`.
  - `scripts/fly-deploy.sh` (`FLY_PREFIX`, `FLY_REGION=iad`, `FLY_ORG=personal`, `FLY_PG_PLAN=Basic`), idempotent:
    1. Creates apps → `fly mpg create` → `fly mpg databases create` ×3.
    2. `fly mpg attach --database … --variable-name …` sets `DATABASE_URL` (rating) and `CUSTOMER_/POLICY_DATABASE_URL` (web).
    3. Secrets go through `fly secrets import` on stdin (never argv): `ANTHROPIC_API_KEY` from `.env`, plus a generated Basic auth password saved to `.fly-credentials` (mode 600, git-ignored, never printed).
    4. `fly deploy --no-public-ips` for rating and ingestion plus `fly ips allocate-v6 --private`, then web.
  - Web: `src/middleware.ts` (Node runtime) requires HTTP Basic auth on everything except `/api/live` and static assets when `BASIC_AUTH_PASSWORD` is set. It's a no-op locally. `src/lib/basic-auth.ts` uses a constant-time compare (tested). `/api/live` is the liveness check. `src/app/admin/[[...path]]` proxies the rating admin UI (GET/POST, `redirect: "manual"`, forwards content-type, cookie, location, set-cookie), so the "Rate tables" link is `/admin` everywhere. Security headers come from `next.config.ts`. `currentUser()` defaults to the Basic auth user.
  - Containers run as non-root (`app` in Python, `node` in web); every build context ignores `.env*`. Compose binds every port to `127.0.0.1`.
- **Files:** `services/{rating,ingestion}/{fly.toml,Dockerfile,.dockerignore}`, `web/{fly.toml,Dockerfile,.dockerignore,next.config.ts}`, `web/src/{middleware.ts,lib/basic-auth.ts,lib/basic-auth.test.ts,app/api/live/route.ts,app/admin/[[...path]]/route.ts}`, `web/src/{app/layout.tsx,app/audit/page.tsx,lib/user.ts}`, `scripts/fly-deploy.sh`, `docker-compose.yml`, `.gitignore`, `README.md`
- **Commit:** `step-12: ...`
- **Decisions:**
  - **Managed Postgres (`fly mpg`)**, not the unsupported legacy `fly postgres`. flyctl 0.4.x warns that unmanaged Postgres isn't supported. Each service still owns one logical database in the shared cluster, per PLAN.md.
  - **Flycast, not `.internal`, for service-to-service calls.** It goes through Fly's proxy, so idle machines can stop and start on the next request, and apps keep binding `0.0.0.0` (`.internal` would need `::` and always-on machines).
  - **Only web is public.** The security review's top finding (no authentication, SEC-001) would mean anyone on the internet could spend the Anthropic key or edit rates. A shared Basic auth password is the minimum for a demo deployment; per-user login is the next step. The rate admin moved behind web via the proxy instead of exposing rating (SEC-002).
  - Security review items addressed here: SEC-001 (partly: a shared gate, not per-user identity), SEC-002, SEC-003, SEC-010 (in Fly: generated database credentials; `uw/uw` is local only now on localhost), SEC-011, SEC-012, SEC-015. Still open: SEC-004 (prompt hardening against instructions in documents), SEC-005, SEC-006 (actor is still free text behind the gate), SEC-007 to SEC-009, SEC-013, SEC-014 (fixed with CR-007), SEC-016 to SEC-019.
  - `auto_stop_machines = "stop"` with `min_machines_running = 0` keeps costs near zero between demos; the first request after idle takes a few seconds.
- **Dead ends / gotchas:**
  - `fly mpg list --json` prints a plain message, not `[]`, when there are no clusters; the script parses defensively.
  - Next.js middleware defaults to the edge runtime, where `node:crypto` isn't available and env is less predictable. `runtime: "nodejs"` (stable in 15.5) fixes both.
  - Use `/api/live` for the Fly check: `/api/health` returns 503 whenever a dependency is down, which would make Fly hold or roll back a web deploy for a rating outage.
  - Containers reaching the host's Postgres via `host.docker.internal` still work with compose ports bound to `127.0.0.1` on Docker Desktop.
- **How to show it:** `scripts/fly-deploy.sh`, then open `https://<prefix>-web.fly.dev`. The browser asks for the credentials in `.fly-credentials`; the status page shows four green cards. Point out in `fly ips list -a <prefix>-rating` that rating has only a private address, and that `/admin` works through web.
- **Not deployed yet:** verified locally (configs validated, images built and run as non-root, gate, proxy and headers tested with curl). The first real `scripts/fly-deploy.sh` run still needs the owner's go-ahead because it creates billed resources.
- **Deployed 2026-10-23:** `uwdesk-web` (public, https://uwdesk-web.fly.dev, Basic auth), `uwdesk-rating` and `uwdesk-ingestion` (private_v6 Flycast only), `uwdesk-db` (Managed Postgres, Basic plan, iad). Verified live:
  - `/api/live` returns 200 without auth; pages and `/admin` return 401 without credentials and 200 with them.
  - `/api/health` is all green: both databases are connected over Managed Postgres (the attached URLs worked with node-postgres and psycopg as-is), and rating (rates 2026.1) and ingestion are reachable over Flycast.
  - A real extraction of case 05 through a `fly proxy` tunnel took 20.7 s, inferred class 98304, and had nothing missing for rating and no warnings.
- **Deploy gotchas:**
  - `fly deploy <dir> --config <path>` resolves the config path relative to `<dir>`, so pass it absolute.
  - `fly mpg create` and `fly mpg attach` print the full connection string, password included. The script now sends their output to /dev/null; rotate the password if it was shown (`fly mpg users rotate-password` prints the new one and does not update app secrets).
  - `fly proxy <port> -a <app>` targets `<app>.internal` (IPv6), which an app bound to 0.0.0.0 doesn't answer. Tunnel to the Flycast address: `fly proxy 18002:80 <app>.flycast -a <app>`.

## step-13: Submission inbox from the broker drop folder, plus 10 more sample submissions
- **Prompt used:** "Build a submission inbox on the submissions page that shows submissions in the folder that haven't been extracted or rated yet, so the workflow can begin by selecting one from the inbox instead of uploading a file. And create an additional 10 submissions similar to the originals but unique in their specifics."
- **What was built:**
  - **Inbox on /submissions:** one row per sub-folder of the drop folder that has no submission yet. Each row shows a title from the folder name, the documents with their type (PDF, Email, Word), and an **Extract →** button. Extract sends the folder's files down the same path as an upload (`receiveSubmission` → ingestion `/extract` → store → audit), then opens intake review. The upload form is still there, collapsed under "Or upload documents yourself".
  - **Picked-up folders leave the inbox:** `submissions.inbox_folder` (migration `customer/003`) records the source folder. The inbox hides folders that have a row, and a partial unique index means a second click or a stale tab can't create a duplicate. The action checks first so no Claude call is wasted, and the index is the backstop. The `submission.received` audit event names the folder.
  - **10 new cases (09–18)** in `samples/cases.py`: concrete, painting, plumbing, roofing, electrical, HVAC, GC, carpentry and flatwork across TX, SC/GA, NJ/NY, WA, CO/WY, NV, FL, NY and GA/SC. They use every format (fillable and flattened ACORD-style, emails with and without attachments, sparse email, questionnaire, Word), have 0–3 losses including open ones, and limits from $500K/$1M to $2M/$4M. All rate on 2026.1, from $6.6K (Silver State HVAC) to $676K (Biscayne Bay Builders) total.
  - Extraction eval on the new cases (`python -m app.score`, real Claude): **313/313 fields, 10/10 loss histories**.
- **Files:** `web/src/lib/{inbox.ts,inbox-files.ts,inbox-files.test.ts,submissions.ts}`, `web/src/app/submissions/{page.tsx,inbox-list.tsx,actions.ts}`, `web/migrations/customer/003_submission_inbox.sql`, `web/Dockerfile`, `web/inbox/.gitkeep`, `.gitignore`, `docker-compose.yml`, `scripts/fly-deploy.sh`, `samples/{cases.py,generate.py,README.md}`, `samples/submissions/09-*…18-*`, `samples/ground_truth/09-*…18-*.json`
- **Commit:** `step-13: ...`
- **Decisions:**
  - **Where the drop folder lives:** `SUBMISSION_INBOX_DIR`, else `../samples/submissions` when it exists (`npm run dev` from `web/`), else `./inbox` (the Docker image).
    - Compose mounts `./samples/submissions:/inbox:ro`.
    - On Fly there is no shared disk, so `scripts/fly-deploy.sh` copies `samples/submissions` into `web/inbox/` (git-ignored except `.gitkeep`) right before `fly deploy web`, and the Dockerfile copies it into the image.
    - A real drop folder (S3, an email inbox) would replace `readInbox`/`loadFolder` only.
  - "Not extracted yet" means no submission row for the folder. Once a folder is extracted it moves to Received, and rating happens later in the existing workbench flow. To put a folder back in the inbox, delete its submission row.
  - Folder and file names are validated (`isSafeName`: no `..`, slashes, dotfiles), and `loadFolder` checks the folder sits directly under the drop folder. The server action takes a folder name from the client, so it must not be able to read anything else. There's a 25 MB cap, the same as an upload.
  - Pure filesystem helpers live in `inbox-files.ts` (no `@/` imports), so `node --test` covers them. The DB-aware listing is in `inbox.ts`.
  - `generate.py` now takes case prefixes (`generate.py 09 10`) and rebuilds only those. The PDFs embed today's date, so a full run would rewrite cases 01–08 for no reason. Email, questionnaire and Word templates are now data-driven (claim counts and open claims, new-construction share, COIs or not, wrap-ups, scaffolding only above 40 ft) instead of wording written for one case.
- **Dead ends / gotchas:**
  - **Claude's notes caught a template bug:** the Word app said "40 ft (ground level flatwork)" for an electrician, a phrase hard-coded for case 07. It now appears only at ≤ 10 ft. Read the underwriting notes on new samples; they're a free consistency check.
  - Ground truth must only expect what the documents say or clearly imply. The email template has no website line, so case 16 can't expect one. "Restaurants, retail and offices" does imply 0% residential, matching case 05's inferred 100%.
  - In `next dev`, the first compile of a route force-reloads every open tab. A "stale tab" test passes only after the review route has been compiled once. Production has no such reload.
  - `pkill -f "next dev"` inside a shell command line kills that shell too (the pattern matches its own command). Use `pgrep` and skip `$$`.
- **How to show it:** open /submissions to see "Inbox · 18 new". Click **Extract →** on Mile High Electric (a Word application): the button reads "Reading documents…", and about 25 s later the intake review opens with every field filled and cited. Go back: the inbox shows 17 and SUB-0001 is under Received. For a fast one, Extract Rio Bravo Concrete (fillable ACORD; only the loss run goes to Claude).

## Fix: read the API key as `UW_ANTHROPIC_API_KEY` too
- **Prompt used:** "Port the key fallback: the ingestion service should read UW_ANTHROPIC_API_KEY, falling back to ANTHROPIC_API_KEY."
- **What was built:** `claude.api_key()` returns `UW_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`. `enabled()` and the Anthropic client both use it. `docker-compose.yml` maps either name into the container's `ANTHROPIC_API_KEY`. 1 new test.
- **Files:** `services/ingestion/app/claude.py`, `services/ingestion/tests/{conftest.py,test_ingestion.py}`, `docker-compose.yml`
- **Commit:** `fix: ...`
- **Decisions:** Fly and `.env` keep the standard `ANTHROPIC_API_KEY` name. Only the cloud sandbox needs the alternate one.
- **Dead ends / gotchas:**
  - The Claude Code cloud sandbox reserves the name `ANTHROPIC_API_KEY` and doesn't pass it into sessions. Store the key as `UW_ANTHROPIC_API_KEY` there, or the service silently runs form-fields-only.
  - Pass `api_key=` to `anthropic.Anthropic()` explicitly, because the SDK only reads the standard name on its own.

## Tooling: deploy to Fly.io from GitHub Actions on every push to main
- **Prompt used:** "Set up a GitHub Action that deploys to Fly when main changes."
- **What was built:** `.github/workflows/fly-deploy.yml` runs `scripts/fly-deploy.sh` on a GitHub runner when a push to `main` touches `services/`, `web/`, `samples/submissions/`, the deploy script or the workflow. It can also be started by hand (Actions → Deploy to Fly.io → Run workflow). Docs-only merges don't deploy.
- **Files:** `.github/workflows/fly-deploy.yml`, `scripts/fly-deploy.sh`
- **Commit:** `tooling: ...`
- **Decisions:**
  - The workflow reuses the deploy script rather than duplicating its steps, so the inbox copy, `--no-public-ips` and the idempotent checks stay in one place.
  - One repository secret, `FLY_API_TOKEN`. It must be an **org** token (`fly tokens create org`): the script lists apps and the Managed Postgres cluster and deploys three apps, which a per-app deploy token can't do.
  - `concurrency: fly-deploy` queues overlapping pushes instead of racing two deploys. It runs in the `production` environment, so GitHub shows a deployment history and approvals can be added later.
  - On CI the script refuses to generate a Basic auth password. A password made on a throwaway runner would be lost. Create it once from a laptop run, which saves `.fly-credentials`.
- **Dead ends / gotchas:**
  - Don't deploy from a Claude Code cloud sandbox. Its egress proxy blocks Fly's Depot builder (`api.depot.dev`), and the Fly remote builder needs WireGuard or builder DNS, which the sandbox lacks. The workaround on 2026-10-23 was to build locally with base images from `mirror.gcr.io` (Docker Hub returned 429), pass the sandbox CA only as a build-only bind mount so it never lands in the image, and run `fly deploy --image … --local-only`. Merging to `main` now deploys from GitHub instead.
  - Deploying an auto-stopped app leaves its machines stopped. They start on the next request.

## Users: one login per underwriter (underwriter1–underwriter9)
- **Prompt used:** "Create 8 additional users named underwriter2 through underwriter9, and rename the current user underwriter1."
- **What was built:**
  - The password gate accepts several logins from `BASIC_AUTH_USERS` (`name:password,name:password`; a password may contain `:` but not `,`). The old single `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` pair still works when `BASIC_AUTH_USERS` is unset.
  - **Who you are comes from your login.** After checking the password, `middleware.ts` passes the username to the app in the `x-uw-signed-in-user` request header, after deleting any copy the client sent. `currentUser()` reads it, so the audit trail, "Received by", ratings, quotes and binds record the person who actually signed in. The header shows "Signed in as underwriter3" instead of the free-text "Working as" box.
  - Locally (no logins configured) nothing changes: the "Working as" box and its cookie still choose the name, now defaulting to `underwriter1`.
  - `scripts/fly-users.sh name …` adds logins. It generates passwords into `.fly-credentials` (git-ignored, mode 600, `name=password` lines) and sets `BASIC_AUTH_USERS` from the whole file. `fly-deploy.sh` now creates `underwriter1` that way on a fresh setup.
- **Files:** `web/src/lib/{basic-auth.ts,basic-auth.test.ts,user.ts}`, `web/src/middleware.ts`, `web/src/app/layout.tsx`, `web/src/app/submissions/actions.ts`, `scripts/{fly-users.sh,fly-deploy.sh}`, `README.md`
- **Commit:** `users: ...`
- **Decisions:**
  - Basic auth rather than a login page and sessions: it was already the gate, it needs no session store, and every browser handles it. To switch users, use a private window (browsers cache Basic credentials per site).
  - `authenticate()` checks the presented credentials against every user with constant-time compares, so response time doesn't reveal which usernames exist.
  - Existing audit rows keep the name they were written with (`underwriter`). Audit history isn't rewritten.
  - `fly-users.sh` never removes the legacy `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` secrets. A web release older than this change with those removed would run with *no* password. Unset them by hand once this release is live.
- **Dead ends / gotchas:**
  - The trusted identity header must be deleted from every incoming request, including when no logins are configured. Otherwise a client could send it and pick their own name.
  - Next's standalone server shows up as `next-server` in the process list, not `node server.js`. A test server left running on the port made a new build look like it ignored auth (every request 200). Check `prod.log` for `EADDRINUSE` before trusting results.
- **Still open (security review, on hold):** the rate admin's own "actor" field is free text (SEC-006); it doesn't use the signed-in user yet.

## step-14: Live activity stream while a submission is extracted
- **Prompt used:** "On the submissions page, can we show a verbose activity stream while the submission is being extracted, so the user can see what is going on? This is really for the purposes of demo."
- **What was built:**
  - **Ingestion `POST /extract/stream`:** same input as `/extract`, but it streams newline-delimited JSON as it works. Event types: `step` (stage plus message: class list loaded, files received, each document's type and whether Claude or form fields will read it, form fields read, documents sent to Claude, Claude writing, Claude's token counts, merge result), `field` (path, value, confidence, stated/inferred, form or Claude), `loss`, `thinking` (Claude's reasoning summary), `warning`, then one `result` (the `/extract` body) or `error`. Every event has `t`, seconds since the request started.
  - **The Claude call now streams** (`client.beta.messages.stream`) with `thinking: {type: "adaptive", display: "summarized"}`. Fields and losses are picked out of the partial JSON with a regex as they're written. Both `/extract` and the stream use the same code; `on_event` is just `None` for the plain endpoint.
  - **Web route `POST /submissions/inbox/[folder]/extract`:** checks that the folder is still in the inbox, relays ingestion's events to the browser as they arrive (re-timed from the click), stores the submission, and ends with `stored` (id and reference).
  - **Activity panel** (`activity-panel.tsx`): a dark modal with a running timer and counters (fields from forms vs Claude, losses). Each event is a row; consecutive `thinking` deltas merge into one italic paragraph. While Claude is quiet it shows "Claude is reading the documents and reasoning about them…". When done it shows "Saved as SUB-…" and opens intake review after 2.5 s (or click "Open"). Cancel aborts the request, which aborts the ingestion call.
  - The inbox's Extract button now uses this route. The old `extractFromInbox` server action is gone. Upload still uses the plain path.
- **Files:** `services/ingestion/app/{main.py,pipeline.py,claude.py}`, `services/ingestion/tests/test_ingestion.py`, `web/src/app/submissions/{activity-panel.tsx,inbox-list.tsx,actions.ts}`, `web/src/app/submissions/inbox/[folder]/extract/route.ts`, `web/src/lib/submissions.ts` (`receiveSubmission` split into `filesForm` + `storeSubmission`)
- **Commit:** `step-14: ...`
- **Decisions:**
  - NDJSON over a `fetch` body reader, not SSE or WebSockets. It's one POST, works through Next route handlers and the Fly proxy, and needs no extra libraries. Responses send `Cache-Control: no-cache, no-transform` (so compression doesn't buffer) and `X-Accel-Buffering: no`.
  - On the ingestion side, the pipeline runs in a thread and pushes events onto a `queue.Queue`. A sync generator drains it, and Starlette iterates sync generators in its threadpool, so nothing blocks the event loop.
  - Summarized thinking costs nothing extra: the model thinks either way, and `display` only controls whether the summary is returned. Re-scored cases 03, 07 and 15 after the switch to streaming: all still 100%.
  - Live field parsing only accepts a `confidence` followed by its comma. The number streams in pieces, so `0` may still become `0.97`.
- **Dead ends / gotchas:**
  - The first version showed many fields at **0%** confidence: the regex matched `"confidence":0` before `.97` had arrived. Fixed by requiring the comma, with a unit test.
  - Format only money with thousands separators. A generic "4+ digit number" rule turned ZIP 29407 into "29,407" and class code 98304 into "98,304".
  - **This container has no `ss`.** `kill $(ss … :8002 …)` silently killed nothing, the new server failed with "address already in use", and testing hit the old code. Check the server log for `Errno 98` after every restart. Find processes with `pgrep -f`, and for Next standalone match `next-server` plus the working directory.
  - Claude's reasoning summary arrives in bursts after a quiet spell of several seconds, so the panel needs the "reading and reasoning" line and a running timer, or it looks stuck.
- **How to show it:** see DEMO_PLAYBOOK row 14. Case 12 (form plus questionnaire) shows the contrast best. Case 10 (email plus attached loss run) is all Claude.
