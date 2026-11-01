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

## Fix: "Rating service class list unavailable" after the services sat idle on Fly
- **Prompt used:** "The app is showing an error in rating, can you check it out?" (The warning appeared on SUB-0007 in intake review.)
- **Cause (from Fly logs):** rating auto-stopped at 18:16:38 after idling. At 18:21:47 an extraction asked it for `/classes`, Fly started the machine, and it was ready at 18:21:51. Ingestion's 3 s timeout had already expired, so Claude chose a class code without the rateable list. Ingestion itself took 6.3 s to wake for the same click.
- **What was built:**
  - `rateable_classes()` in ingestion waits up to 10 s and tries twice, enough for a cold start. It also keeps the last list it got and falls back to it if rating is unreachable; class codes change only when a rate version is activated.
  - The Submissions page calls `wakeServices()` via Next's `after()` once the page is sent. It pings rating's and ingestion's `/health` so Fly starts them while the underwriter is still reading the inbox.
  - 1 new ingestion test (fails once then succeeds; falls back to the cached list when rating is down).
- **Files:** `services/ingestion/app/main.py`, `services/ingestion/tests/test_ingestion.py`, `web/src/lib/services.ts`, `web/src/app/submissions/page.tsx`
- **Commit:** `fix: ...`
- **Decisions:** Fixed in code rather than with `min_machines_running = 1`, which would keep a machine running and billing all day. Raise it on demo day if the first click must be instant.
- **Gotcha:** any service-to-service call on Fly with auto-stop needs a timeout longer than a cold start (about 4–6 s here). The web status page's 3 s health timeout has the same issue; it only affects that page's colors, and the wake-up ping usually starts the services first anyway.

## step-15: The underwriter's desk (landing page)
- **Prompt used:** "Let's work on the landing page. It should be information relevant to the individual underwriter, like their book of business, what their next tasks/submissions should be, and a list of upcoming renewals, and anything else you think might be important."
- **What was built:**
  - `/` is now **"underwriterN's desk"** for the signed-in user. The old system-status page moved into a small panel at the bottom.
  - **Tiles:** in-force premium (policies in force), renewals due in 90 days (expiring premium), book loss ratio (open claims), new business bound in the UW Desktop, and quotes out with the hit ratio of *decided* quotes (bound, or expired unbound).
  - **Next up**, most urgent first:
    - intakes to review (with missing rating fields)
    - worksheets to rate or re-rate (stale rates or changed inputs)
    - referrals to clear
    - rated submissions ready to quote
    - issued quotes to chase for a bind order (days left on the quote)
    - open subjectivities on bound policies (next due date)
    - renewals to start (60 days or less, not started) or finish (in progress, 30 days or less)
    - new inbox items
  - **In-force premium by class:** one-hue horizontal bars with direct labels and a hover title.
  - **Upcoming renewals (120 days):** expiry with a days-left chip, insured and policy, class, states, producer, premium, 5-year losses (claims, incurred, loss ratio, open claims) and renewal status.
  - **Your recent activity:** your last 8 audit events.
  - Loading the page also calls `wakeServices()`, like the Submissions page.
  - **Seeded prior book:** `book_policies` (migration `policy/004`, generated by `scripts/generate-book.py`) holds 103 fictitious in-force policies across underwriter1–9, 10–12 each worth $0.5–1.3M, with 4–6 renewals inside 90 days, loss ratios from about 10% to 50%, and a few renewals already in progress.
- **Files:** `web/src/app/page.tsx`, `web/src/lib/dashboard.ts`, `web/migrations/policy/004_book_policies.sql`, `scripts/generate-book.py`
- **Commit:** `step-15: ...`
- **Decisions:**
  - **Ownership:** the underwriter who picked up a submission (`received_by`) owns it, and through it its quotes and policies. There's no separate assignment field yet. Quotes and policies live in the policy DB, so they're matched on `submission_id = ANY(<my submission ids>)` rather than with a cross-database join.
  - **Why a separate table for the prior book:** the UW Desktop has only bound a handful of policies, all expiring a year out, so there would be no book and no renewals to show. Seeding into `policies`/`quotes` would create rows with no workbench, quote PDF or submission, so every link from them would break. `book_policies` is honestly "imported from the prior system": its rows show "prior system", have no detail link, and count toward the book, renewals and loss ratio. UW Desktop policies appear alongside with links.
  - Seed dates are `CURRENT_DATE + n` **at migration time**, so a fresh deploy always has upcoming renewals. As days pass, the 5-day renewal becomes overdue and then drops off (expired policies leave the book). Regenerate with a new migration to refresh.
  - Chips always show the number of days; color only reinforces it: red at 14 days or less or overdue, amber at 45 or less.
- **Dead ends / gotchas:**
  - The first hit ratio showed 0% with one quote still open. An outstanding quote isn't a loss; count only decided quotes.
  - A never-rated worksheet was labelled "Re-rate (inputs changed)". It now says "Rate" until there's a first rating.
  - Local Postgres in the Claude cloud sandbox stops when the container restarts. If a page 500s with `ECONNREFUSED 5432`, run `service postgresql start` before debugging the code.
- **How to show it:** see DEMO_PLAYBOOK row 15.

- **Follow-up: the inbox stays on top of Next up.** The "N new submissions in the inbox" task is pinned first (`Task.pinned`; the sort puts pinned tasks ahead of the urgency order) and its row is lightly tinted (indigo wash with a left accent, label in indigo) so new work is never buried under renewals and bind chases. The caption now reads "Inbox first, then most urgent: overdue, then by due date".

- **Follow-up: action buttons at the top right.** "Save & rate" (workbench) and "Save corrections" (intake review) moved from a sticky bar floating at the bottom of the form into the page header, right-aligned next to the title and status. They sit outside their `<form>` and submit it through the `form="worksheet-form"` / `form="review-form"` attribute, so the server actions are unchanged. No page has a bottom action bar any more.

- **Follow-up: the five tiles open their lists.** Each KPI on the desk is a link to the list behind its number, filtered the way the tile is defined: **In-force premium** → `/book` (the underwriter's unexpired policies, prior-system and UW Desktop, sorted by expiration); **Renewals · 90 days** → `/book?due=90`; **Book loss ratio (incurred)** → `/book?view=losses` (the prior-system book by incurred, with premium, incurred, loss ratio and open claims); **New business** → `/policies?underwriter=<user>&in_force=1`; **Quotes out** → `/quotes?status=issued&underwriter=<user>`. The Upcoming renewals heading opens `/book?due=120`. The new `/book` page reuses `loadDashboard()` so its numbers are the tiles' numbers; Policies and Quotes gained `underwriter` (submissions received by) and `in_force` / `status` filters with a banner and a "show all" link. `DaysChip` moved to `components/ui.tsx`.

- **Follow-up: Sign out.** A "Sign out" link under "Signed in as …" opens `/signout`. HTTP Basic auth keeps no server session (the browser re-sends the login with every request), so the route answers **401 with the same `WWW-Authenticate` realm**: the browser drops the cached login and shows its sign-in box, which the user cancels (landing on the route's "You're signed out" page) or fills in as someone else. Without the password gate it clears the "working as" cookie and returns to the desk. Many people can be signed in at once, each with their own login, because every request is authenticated on its own; `scripts/fly-users.sh <name>…` adds logins to the live app.

- **Follow-up: an Admin drop-down.** Audit, Accounting and Rate tables moved out of the top nav into one **Admin** menu (`components/admin-menu.tsx`, a small client component: opens on click, closes on Escape, a click elsewhere or a route change, shows as current when one of its pages is open, each item with a one-line hint). The rate admin's mirrored desktop header (`services/rating/app/templates/base.html`) has the same menu as a native `<details>` (its pages are full loads, so nothing has to close it) and the Sign out link under "Signed in as".

## Fix: the Rate tables page kept the desktop's top nav
- **Prompt used:** "When I go to the rating page from the top nav, the nav disappears and I can only return elsewhere by clicking Back."
- **Cause:** `/admin` is the rating service's own server-rendered UI, proxied by the web app. Its templates had only a "Rating admin" header. Its "API docs" link (`/docs`) was also dead through the proxy, which forwards only `/admin`.
- **What was built:** the web proxy sends `x-uw-desktop: 1` and `x-uw-user: <signed-in user>` to the rating service. `base.html` then renders the desktop's top bar: brand → home, Customers, Submissions, Quotes, Policies, Audit, Rate tables (current), search, and "Signed in as". Opened directly (rating on :8001), it keeps its standalone header with API docs. 1 new rating test covers both headers and checks the name is HTML-escaped.
- **Files:** `services/rating/app/templates/base.html`, `services/rating/tests/test_rate_admin.py`, `web/src/app/admin/[[...path]]/route.ts`
- **Commit:** `fix: ...`
- **Decisions:** the headers only change what the page *displays*. The rating service is private on Fly and the proxy builds its outgoing headers from an allow-list, so a client can't inject them; they still aren't used for any authorization. The admin's own "Your name" field for the audit actor is unchanged (SEC-006, on hold).
- **Gotcha:** when one app proxies another's server-rendered UI, the inner pages need the outer navigation, or users get stranded. Keep the nav links in the inner template in sync with `web/src/app/layout.tsx`.

## Fix: the rate admin records the signed-in user (SEC-006, rating half)
- **Prompt used:** "Use the signed-in user for the rate admin actor too."
- **What was built:** inside the UW Desktop, the rate admin's three actions (create draft, save a variable's edits, activate) record the signed-in user from `x-uw-user`, which the web proxy sets from the checked login. A typed name in the form is ignored, the "Your name" boxes aren't rendered, and the name cookie isn't set. Opened standalone (`:8001`, local dev only), the typed name and its cookie still apply. 1 new rating test: a form `actor=mallory` sent with `x-uw-user: underwriter7` records `underwriter7`, with no name field and no cookie.
- **Files:** `services/rating/app/admin.py` (`signed_in_user`, `form_actor`), `services/rating/app/templates/{version,versions}.html`, `services/rating/tests/test_rate_admin.py`
- **Commit:** `fix: ...`
- **Trust:** the header is trusted because the rating service is reachable only through the web proxy on Fly (Flycast, no public IPs). The proxy builds its outgoing headers from an allow-list and sets `x-uw-user` from `currentUser()`, after middleware has checked the password. The JSON admin API (`/rate-versions`, not proxied) still takes `actor` in the body. With both apps' actors now coming from the login, SEC-006 is resolved for every path a signed-in user can reach.

## fix: web keeps rating and ingestion awake while it's awake
- **Prompt used:** "Have the web service start the rating service and the ingestion service the minute it wakes up (for example if someone logs in after they've all been asleep), so a user doesn't hit a long pause at ingestion or rating."
- **What was built:** `src/lib/keep-warm.ts`, started from `src/instrumentation.ts` before migrations. It pings rating's and ingestion's `/health` (`wakeServices()`) the moment the web process starts, then every 60 s while it runs. Fly starts web when someone signs in, so the other two are booting while the first page renders, and they don't auto-stop mid-session. When Fly stops the idle web machine, the pings stop and the services sleep a few minutes later. The two page-level `after(wakeServices)` calls (Home, Submissions) are gone; this one mechanism covers every page, including bookmarks.
- **Files:** `web/src/lib/keep-warm.ts`, `web/src/lib/keep-warm.test.ts`, `web/src/instrumentation.ts`, `web/src/lib/services.ts`, `web/src/app/{page,submissions/page}.tsx`
- **Commit:** `fix: ...`
- **Decisions:**
  - Pings start in `register()` *before* migrations, so the services boot in parallel with web's own start.
  - `KEEP_WARM_INTERVAL_MS` (default 60000; `0` turns it off). The timer is `unref()`ed so it never holds the process open. Failed pings are ignored, since `/api/health` already reports a down service.
  - Cost: rating and ingestion now run whenever web runs, instead of only between their own requests. Web still auto-stops a few minutes after its last request, because outgoing pings don't count as incoming traffic and Fly's `/api/live` checks bypass the proxy.
- **How to show it:** stop all three Fly machines (`fly machine stop -a uwdesk-rating …`), open the site, and within a few seconds `fly machine list -a uwdesk-rating` shows `started`, before any extraction or rating.
- **Verified on Fly (2026-10-30):** with all three machines stopped and settled, one unauthenticated hit on `/api/live` woke web in about 4.7 s, and **rating and ingestion were both `started` by t+5 s**, before any page asked for them.
- **Gotchas:**
  - In an earlier run, Fly refused to start ingestion for about 65 s ("machine can't start at the moment", `crash exit_code=0` with no boot output), then showed it as `migrating` to another host. That's a Fly host-capacity event; the next 60 s ping started it once the move finished.
  - Don't `fly machine stop` a machine that's already stopped while testing; it seemed to make that worse.
  - The GitHub Actions deploy for this change waited about 11 minutes for a runner before running; `fly deploy web …` from a laptop is the fallback.
- **Follow-up: quick retries.** `wakeServices()` now returns whether both services answered OK. When a ping fails (Fly refused a start, a timeout), keep-warm retries every 10 s, up to 6 times, before falling back to the 60 s cadence. A success resets it; while a retry is pending the interval tick skips, so pings never stack. Locally, with ingestion stopped, web pinged 4 times in about 35 s instead of once, then stopped retrying as soon as ingestion was back. This cuts the worst-case wait in events like the host migration above from about a minute to about 10 s after Fly allows the start.

## step-16: Renewal workflow (expiring policy → re-rate → compare → renewal quote with memo)
- **Prompt used:** "On the desk, the renewals in Next up and Upcoming renewals weren't clickable because there was no renewal workflow. Build one: click a policy up for renewal and see the current policy details; adjust the details and re-rate; a comparison screen of current vs renewing details and the rate; re-rate from the comparison and go back to the rating page; quote from the renewal page once rated; a quote plus a memo to the customer explaining the premium change, the changes in rating variables and any rating factor changes; and all of a policy's documents on the policy overview page."
- **What was built:**
  - **A renewal is a submission of kind `renewal`.** `Start renewal` on a policy page creates it (intake already accepted, insured linked or created by name) with a worksheet seeded from the expiring inputs and schedule, and stores a snapshot of the expiring policy (`submissions.renewal_of`: inputs, schedule, rate version, the expiring rating worksheet, premium, terms, losses). From there the normal workbench, referrals, quote, bind, PDFs and audit apply.
  - **Prior-system policies can be re-rated.** `book_policies` now carry `rating_inputs`, `schedule` and `rate_version` (migration `policy/005`, generated by `scripts/generate-book.py --renewal-columns`), and each premium is what the real rating engine produces for those inputs on rate version 2026.1. Starting a book renewal rates those inputs on that version through the API, so the expiring premium is reproduced factor by factor.
  - **Pages:** `/policies/book/[id]` (current policy, rating basis, 5-year losses, Start/Continue renewal, the renewal's quotes, memo and new policy); `/policies/[id]` reworked as the policy overview (coverage, subjectivities, Renewal card, and a **Documents** list: policy document, binder, every quote version, renewal memos, the submission's original documents, and the renewal's documents); `/submissions/[id]/renewal` (the comparison: rate comparison with the premium bridge, terms expiring vs renewing with "changed" marks, rating factors step by step marked "terms"/"rates"/"both", Re-rate, Adjust on the workbench, Issue renewal quote, the expiring policy's losses). The workbench shows a renewal banner and the expiring value under every input.
  - **Premium bridge.** For a renewal, Save & rate also rates the renewing inputs on the *expiring* rate version (`worksheets.bridge_rating`). Expiring → bridge is what the insured's terms, exposure and schedule did; bridge → renewing is what the rate tables did. `lib/renewal-compare.ts` (pure, tested) builds the comparison and the memo's sentences from it.
  - **Renewal memo.** Issuing a renewal quote also renders a memo to the insured (`quotes.memo_pdf`, served at `/quotes/[id]/memo`): premium table, the bridge, changes to operations and coverage, underwriting adjustments, rate changes (per factor, with the rate revision), renewing terms, next steps. The quote PDF says "Renewal of policy …". The stored comparison (`quotes.renewal_summary`) shows on the quote page.
  - **Binding a renewal** marks the expiring policy `renewed` (book or desktop) and records `policies.renewed_from` on the new policy; the new policy page shows "renewal of GL-…" and links back; the dashboard drops renewed policies from Upcoming renewals and links "Finish renewal" tasks to the comparison page.
- **Files:** `scripts/generate-book.py`, `web/migrations/policy/005_book_rating_inputs.sql`, `web/migrations/customer/004_renewals.sql`, `web/src/lib/{renewals,renewal-compare,renewal-compare.test,renewal-memo-pdf,rating-api}.ts`, `web/src/lib/{quotes,worksheets,policies,submissions,dashboard,audit,timeline,quote-pdf}.ts`, `web/src/app/policies/{actions.ts,[id]/page.tsx,book/[id]/page.tsx}`, `web/src/app/submissions/[id]/{renewal/page.tsx,renewal/actions.ts,issue-quote-form.tsx,workbench/page.tsx,page.tsx}`, `web/src/app/quotes/[id]/{memo/route.ts,page.tsx}`, `web/src/app/{audit/page.tsx,submissions/page.tsx}`, `web/src/components/ui.tsx`
- **Commit:** `step-16: ...`
- **Decisions:**
  - Modelling a renewal as a submission (rather than a parallel "renewal" module) reuses everything: the workbench is the "adjust and re-rate" screen, referral rules apply (the Florida plumbing renewal correctly reopens its uninsured-subs referral), quotes version and supersede, bind issues the binder and policy, the case history covers it all. The renewal-specific parts are the snapshot, the bridge rating, the comparison page and the memo.
  - The expiring premium for a prior-system policy is *reproduced* from stored inputs rather than copied, so the comparison is honest at the factor level. That required regenerating the seed's premiums with the engine (`--renewal-columns` reads the rating DB with the service's own `load_tables` and `rate`; migration 004 and its names/dates are unchanged, 005 updates inputs and premiums by policy number).
  - The bridge needs the expiring rate version to still be rateable. Active and retired versions are frozen, so pinning `rate_version_id` reproduces old premiums exactly; if the version is gone the comparison still works but says the split is unavailable.
  - Book policies have no FEIN, so their insured is found or created by name. Their loss history is aggregate only (claims, incurred, open), shown as such; no claim rows are invented.
  - Default renewal dates: effective = expiring expiration, +1 year. The first renewal subjectivity is "Signed renewal application or no-change confirmation".
  - Re-rate on the comparison page rates the worksheet *as saved* (`rerateWorksheet`) and returns to the workbench, as asked; "Adjust terms" goes to the workbench without rating.
- **Dead ends / gotchas:**
  - `node --test` can't resolve an extensionless `./worksheet` import; the pure comparison module imports `./worksheet.ts` explicitly (allowed by `allowImportingTsExtensions`; Next builds it fine).
  - `fly deploy`-style gotcha for the generator: it must run with the rating service's venv and `PYTHONPATH` pointing at the service (`app.engine`), e.g. in a `python:3.12-slim` container with `uv sync` and `DATABASE_URL` at the local rating DB.
  - In zsh, `echo ====X` fails (`=` expansion); don't use leading `=` separators in shell one-liners.
  - Seeded `in_progress` book policies had no renewal behind them; the page offers Start renewal until one exists.
- **How to show it:** as underwriter1, on the desk click **Red Rock Electrical** (14 days) → the expiring policy → **Start renewal** → on the workbench raise receipts to $6.2M, deductible to $10K, add a −5% safety credit → Save & rate → **Expiring vs renewing**: the bridge shows the terms impact and $0 from rates → **Issue renewal quote** → open the **Memo**. Then start **Palm Harbor Plumbing** (FL): with no changes, the premium rises 8%, all of it from rate revision 2026.2's Florida factor (1.25 → 1.35), and the memo says exactly that. Bind the renewal from the workbench and open the new policy: "renewal of GL-25-70001", every document in one list.

- **Follow-up: where issuing a renewal quote lands.** The first renewal quote, issued from the workbench or the comparison page, now lands on **Expiring vs renewing** (`/submissions/<id>/renewal`) with the quote and its memo in the Renewal quote card, so the underwriter reviews it against the expiring policy. A **revised** renewal quote (the "Issue revised renewal quote (vN)" button on either page) lands on **Quotes** with that version highlighted: `/quotes?highlight=<quote id>` shows a banner (quote, insured, total, "supersedes vN-1", links to the quote, its PDF, the memo and back to the comparison) and marks the row "just issued"; the superseded version sits right under it. New-business quotes still stay on the workbench. `issuedQuoteHref()` in `lib/quotes.ts` builds the link (a `"use server"` file may export only async functions, so the helper can't live in the actions file).

## step-17: Accounting (premium sub-ledger and the push to the general ledger)
- **Prompt used:** "Add an 'Accounting' page showing the financial outputs that go to the general ledger. When a policy is bound it books premium (cash basis for now, no earning patterns): show the transactions as they'd be booked, by accounting month (what was booked on what date, regardless of collection or earning), with the policy details an auditor needs and the debits and credits by GL account, filterable by the periods an accountant uses. Each sub-ledger transaction must link to the specific UW action. A button pushes the sub-ledger to the actual GL as Excel or CSV. Endorsements and cancellations (negative postings) come later; for now all postings are positive premium."
- **What was built:**
  - **Sub-ledger table** `gl_postings` (policy DB, migration `policy/006`): one journal (`JE-000001`…) per booked action, balanced lines with account code/name, debit, credit, the policy details (policy number, insured, period, quote, submission, underwriter, producer), the source action and its audit **correlation id**, the accounting period, and the export batch once pushed. Policies bound before the table existed are backfilled at their bind time with their bind's correlation id.
  - **Posting at bind:** `bindQuote` books the journal inside the same database transaction as the policy, so a bound policy can't exist without its journal. Chart of accounts: Dr 1200 Premiums receivable (total due); Cr 4100 Written premium, Cr 4200 Policy fee income, Cr 2300 Surplus lines tax payable. A `gl.posted` audit event shares the bind's correlation id.
  - **`/accounting`** (nav: Accounting, also in the rate admin's desktop header): period presets (this/last month, this/last quarter, year to date, last 12 months, all, custom range) and a transaction-type filter; tiles for written premium, fees, SL tax payable, booked to receivable (with debits = credits), journals by type; then one card per **accounting month** with subtotals, each journal as a header (posted time, type, policy link, insured, period, quote, submission, UW, producer, **UW action →**, pushed batch or "not yet pushed") and its account lines.
  - **Push to GL:** Export Excel (.xlsx) or CSV of the lines shown, one row per journal line with every policy field and absolute links to the UW action and the policy. The push stamps lines not pushed before with a batch id (`GLX-YYYYMMDD-NNN`), keeps earlier batches on lines pushed before, and is audited (`gl.exported`, entity `ledger`, which links back to `/accounting?batch=…`).
  - **UW action link:** `/audit?…&correlation=<id>` filters the case history to the events of that one action (the bind, its ledger posting, the quote status change).
  - No dependencies: `lib/csv.ts` (RFC 4180, BOM, formula-neutralizing) and `lib/xlsx.ts` (a minimal .xlsx writer: stored zip, inline strings, bold header, `#,##0.00` numbers, frozen header row), both tested. 55 web tests.
- **Files:** `web/migrations/policy/006_gl_postings.sql`, `web/src/lib/{gl-journal,gl-journal.test,ledger,csv,xlsx,export-formats.test}.ts`, `web/src/lib/{policies,audit,timeline-merge}.ts`, `web/src/app/accounting/{page.tsx,export/route.ts}`, `web/src/app/{audit/page.tsx,layout.tsx}`, `services/rating/app/templates/base.html`
- **Commit:** `step-17: ...`
- **Decisions:**
  - **Basis:** premium is booked in full at bind (a written basis). The request said "cash basis" but defined it as booked-on-date regardless of collection, so the page says what it does rather than naming a basis: "booked in full when a policy is bound; cash collection and earning are not tracked".
  - **Persisted sub-ledger, not derived on the fly:** journal numbers, posting times and batches need to be stable and immutable for audit, and endorsements and cancellations will add journals from other actions later.
  - **Books' time zone** is `America/New_York` (`GL_TIME_ZONE`): accounting periods, "today" for the presets and the display use it, so a bind at 11:30 pm Eastern on the 31st lands in that month, not the next (tested).
  - The export is a POST (it changes state: batch stamping), returns the file, and is audited with totals; re-exporting the same range is allowed and reports "0 newly marked".
  - Negative postings later: the schema allows negative debits/credits and the `endorsement`/`cancellation` types; `bindJournal` is the only poster today.
- **Dead ends / gotchas:**
  - The backfill numbers journals with `row_number()` and then `setval`; `nextval` inside a CTE wouldn't follow `ORDER BY`.
  - Window functions run after `WHERE`, so renumbering lines after dropping zero-amount lines works in one SELECT.
  - Excel needs both the "none" and "gray125" fills and a `cellStyleXfs` entry even in a minimal `styles.xml`; the writer includes them. Validated with `unzip -t` and Python's `zipfile` plus XML parsing (Excel itself wasn't opened).
  - Parallel shell calls share one working directory, and `next build` writes into the `.next` folder a running `next dev` uses: run them one at a time.
- **How to show it:** Accounting → All periods: the backfilled journals, each balanced. Bind any ready quote and come back: a new journal marked "not yet pushed". Click **UW action →** to land on exactly the bind's three audit events. **Export Excel**: the download, the journals now marked with the batch, and the `gl.exported` event in the audit trail (which links back to that batch's lines).
- **Follow-up: JSON export.** A third push format, "Export JSON": one document with the batch, who generated it and when, the filter, totals (journals, lines, debits, credits, written premium, fees, SL tax, receivable) and the journals nested with their policy details, source action (with the audit URL) and lines; numbers are numbers. Same batch stamping and `gl.exported` audit as the other formats. `lib/gl-export-json.ts` (pure, tested).

## step-18: GL API and MCP server (the sub-ledger for other systems and for agents)
- **Prompt used:** "In addition to the existing formats: 1. an API that lets other apps request GL data with the expected parameters (timeframes etc.), authorized with the user ids and passwords we set up (not how production would do it); clicking the button shows the API documentation, and a valid call returns valid JSON. 2. An MCP server that lets an agent interact with the app and receive valid data; the MCP button shows the MCP spec, and it has to be operational for the demo."
- **What was built:**
  - **REST API under `/api/gl`** (JSON unless a file is asked for): `GET /api/gl` (front door: links, `authenticated_as`), `GET /api/gl/postings` (journals with lines for `period=` preset or `from`/`to`, `type`, `batch`; `format=json|csv|xlsx`, the files being the same ones the push produces), `GET /api/gl/summary` (totals overall and per accounting month), `GET /api/gl/journals/{journal_no}` (one journal plus the audit events of the bind behind it), `GET /api/gl/periods`, `GET /api/gl/batches` (every push, with what the file held and which lines it stamped), `GET /api/gl/accounts` (chart of accounts and the posting rule), `POST /api/gl/exports` (the push: stamps a batch and audits, exactly like the button), `GET /api/gl/openapi.json` (OpenAPI 3.1 with this instance as the server). Reads never stamp anything. Errors are `{ error: { code, message, details? } }` with 400/401/404.
  - **Auth:** the existing HTTP Basic gate (`middleware.ts`) covers `/api/*`; API paths now get a JSON 401 body (still with `WWW-Authenticate`) instead of the browser's plain one, and `currentUser()` makes every document say who called (`generated_by`) and audits pushes under that name. Locally the gate is off and the docs say so.
  - **API button** on Accounting → `/accounting/api`: docs rendered from the same OpenAPI object (base URL, auth with curl/JavaScript/Python examples that never show a password, conventions, the presets resolved for today, every endpoint with parameters, responses and a **Try it ↗** link that works because the browser already holds the login, a live sample of `/api/gl/periods`, and the schemas).
  - **MCP server at `/api/mcp`** (Streamable HTTP, stateless JSON responses, implemented directly in `lib/mcp.ts`: JSON-RPC 2.0 `initialize`, `ping`, `tools/list`, `tools/call` with `structuredContent`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`; notifications answer 202; batches are accepted; a plain `GET` returns the server description, `GET` with an SSE `Accept` and `DELETE` answer 405; an `Origin` that isn't this host answers 403). Tools: `gl_summary`, `gl_journals`, `gl_journal`, `gl_periods`, `gl_batches`, `gl_accounts` (read-only, annotated) and `gl_push` (writes; the instructions tell the model to call it only when asked). Resources: `uwdesk://gl/accounts`, `uwdesk://gl/periods`, `uwdesk://gl/openapi.json`.
  - **MCP button** → `/accounting/mcp`: endpoint, transport, protocol versions, auth; how to connect from Claude Code (`claude mcp add --transport http …`), Claude Desktop/Cursor via `mcp-remote`, the MCP Inspector, and raw curl; a **live session** (a client component posts `initialize`, `notifications/initialized`, `tools/list` and `tools/call gl_summary` from the browser and shows each JSON-RPC exchange, then lets you call any tool with your own arguments); the initialize result, every tool with its `inputSchema` and an example call, the resources.
  - **Shared layers:** `lib/gl-query.ts` (one parser for period/from/to/type/batch/format with error reporting, used by the page's export, the API and the MCP tools), `lib/gl-service.ts` (the documents both API and MCP return, so an agent and a GL system see the Accounting page's numbers), `lib/ledger.ts` (`getJournal`, `listPeriods`, `listBatches`; `renderLedger` split out of `exportLedger` so reads can render a file without stamping), `lib/gl-export-json.ts` (`ledgerDocument`/`journalEntry`, `batch` nullable for reads), `lib/gl-openapi.ts` (the spec, built from `PERIOD_PRESETS`/`TRANSACTION_LABEL`/`EXPORT_FORMATS` so enums can't drift), `requestOrigin()` in `lib/http.ts`, `auditByCorrelation()` in `lib/audit.ts`. 66 web tests (dispatcher, transport, argument validation, query parsing, OpenAPI sanity).
- **Files:** `web/src/lib/{gl-query,gl-service,gl-http,gl-openapi,gl-openapi.test,gl-mcp,mcp,mcp.test}.ts`, `web/src/lib/{ledger,gl-journal,gl-export-json,gl-export-json.test,http,audit}.ts`, `web/src/middleware.ts`, `web/src/app/api/gl/{route.ts,postings,summary,journals/[journal_no],periods,batches,accounts,exports,openapi.json}/route.ts`, `web/src/app/api/mcp/route.ts`, `web/src/app/accounting/{page.tsx,export/route.ts,api/page.tsx,mcp/page.tsx,mcp/mcp-console.tsx}`, `web/src/components/docs.tsx`, `.claude/launch.json`
- **Commit:** `step-18: ...`
- **Decisions:**
  - **Auth as asked:** the underwriter logins over HTTP Basic, because the middleware already does it and every call is then traceable to a person. Both docs pages say that production would use client credentials / OAuth (for MCP, the authorization spec). Examples use `curl -u underwriter1` (prompts for the password) and `$(printf 'underwriter1:PASSWORD' | base64)` placeholders: no password ever appears on a page.
  - **MCP without the SDK:** the protocol surface a stateless read-mostly server needs is small (about 120 lines of dispatch and transport), it keeps the demo dependency-free, and node:test can drive it with fake tools. Stateless JSON responses (no session ids, no SSE stream) are valid Streamable HTTP and enough for Claude Code, `mcp-remote` and the Inspector. The `MCP-Protocol-Version` header is accepted leniently so a client never gets locked out over a version string.
  - **One service module for both surfaces:** the REST documents and the MCP tool results are the same objects, built from the same `listPostings`/`groupJournals`/`ledgerTotals` as the page.
  - **Tool shape for an agent:** `gl_summary` for numbers, `gl_journals` for detail, `gl_journal` to explain one line back to the underwriting action (it folds in the audit events), reference tools for periods/batches/accounts, and one write tool with `readOnlyHint: false`, `idempotentHint: false` and instructions that say when to use it.
  - **Reads render files too** (`format=csv|xlsx` on `GET /api/gl/postings`), without stamping: a GL system can re-pull a batch's file by `batch=` any time; only `POST /api/gl/exports` and `gl_push` open a batch.
  - **Docs from the spec:** the docs page walks the OpenAPI object (plus an `x-try` query per GET), so adding an endpoint to the spec documents it.
- **Dead ends / gotchas:**
  - Port 3000 on this Mac belongs to another, week-old Next 16 app; the dev server runs on 3100 (`.claude/launch.json` starts it with `preview_start`).
  - A zsh test helper that built headers with `${2:+-H "Origin: $2"}` word-split the quotes, and Node answered the malformed header with a bare 400 and no body. It looked like a server bug; a plain `curl -H "Origin: …"` showed 403/200 as designed.
  - `next build` while `next dev` runs corrupts the dev server's `.next`: stop the preview first, build, then test the production server on another port with `BASIC_AUTH_USERS=… npx next start -p 3101`.
  - A folder named `openapi.json` is a fine route segment in the app router (`/api/gl/openapi.json`).
  - Journals backfilled in step-17 have no `gl.posted` audit event (that event started with step-17), so `gl_journal` shows two or three events for them and four for newer binds.
- **How to show it:** Accounting → **API**. Click **Try: GET /api/gl ↗**: the browser already holds the login, so the JSON comes back with `authenticated_as`. Scroll to `GET /api/gl/postings` → **Try it**; change `period=` in the address bar to `ytd` or add `format=csv`. From a terminal: `curl -u underwriter1 "https://uwdesk-web.fly.dev/api/gl/summary?period=this_month"` (it prompts for the password). Accounting → **MCP**: the live session has already run the handshake and a `gl_summary` call; pick `gl_journal`, **Call**, and read the policy and audit events in the result. Then in Claude Code: `claude mcp add --transport http uwdesk-gl https://uwdesk-web.fly.dev/api/mcp --header "Authorization: Basic $(printf 'underwriter1:PASSWORD' | base64)"` and ask "How much premium did we write this month, and which journals make it up?"

## step-19: A year of bound policies (seeded history through the real pipeline)
- **Prompt used:** "Please create 50 new policies that were bound by various underwriters with effective dates going back to January 1 2026, so that they are already booked in the GL and in the renewal register."
- **What was built:**
  - **`SEED_HISTORY=<n>`**: at startup, after migrations, the web app seeds that many bound policies in the background (`lib/seed-history.ts`, hooked in `instrumentation.ts`). Each one goes through the **real pipeline** at back-dated times: submission received → intake accepted (insured created) → worksheet opened and rated by the rating service → referrals cleared with a written note where a rule fires → quote issued (PDF) → bound (binder and policy PDFs, GL journal, audit events). So the desk, Policies, Quotes, the renewal register, Accounting and the audit trail all show a book written since January, with every link working.
  - **As-of time through the pipeline:** `storeSubmission`, `acceptSubmission`, `openWorksheet`, `saveAndRate`, `clearReferral`, `issueQuote` and `bindQuote` take an optional trailing `at` (default now) that sets `received_at`/`reviewed_at`/`created_at`/`updated_at`/`issued_at`/`bound_at`, the quote number's year, `valid_until`, subjectivity due dates, the GL posting time and accounting period, and `occurred_at` on every audit event (`AuditEvent.occurredAt`). The rating service's `/rate` accepts `rated_at` and dates its log entry with it (`services/rating`, tested), so the case history's "Rating engine" entries line up with the desktop's.
  - **The risks:** deterministic (seeded RNG) fictitious insureds across the eight rated classes and ten territories (NY left out: it always refers), class-appropriate receipts, residential and subcontracting shares, heights, limits ($1M/$2M, some $1M/$3M), deductibles, experience mods on some files, a schedule credit or debit with a reason on a third, 0–2 losses, producers with contacts, prior carrier and premium. Roofing and work-at-height files carry a referral that the underwriter clears with a manager-approval note. Effective dates spread evenly from 2026-01-01 to a couple of weeks out; each file is bound 0–21 days before its effective date (never before January 1 or in the future), quoted 1–10 days before that, rated and accepted a few days earlier. Underwriters: the configured logins (`BASIC_AUTH_USERS`) when there are at least two, else underwriter1–9 like the prior-system book, round-robin.
  - **Idempotent:** an insured whose FEIN already exists is skipped, so the variable can stay set; a second run reports "50 already present".
  - The desk's activity feed now orders by `occurred_at` (it ordered by id, which put seeded March events above this morning's).
  - Locally: 50 policies, 53 journals Jan–Oct 2026 all balanced, 10 referrals cleared, 2 open subjectivities, 10 policies expiring inside the 120-day renewal window; about a minute to run.
- **Files:** `web/src/lib/seed-history.ts`, `web/src/instrumentation.ts`, `web/src/lib/{audit,submissions,worksheets,quotes,policies,dashboard}.ts`, `services/rating/app/{main,repository}.py`, `services/rating/tests/test_api.py`
- **Commit:** `step-19: ...`
- **Decisions:**
  - **Through the pipeline, not SQL inserts:** direct inserts would need every table's shape and still have no PDFs, no audit trail and no rating log; calling the real functions keeps all of that consistent and exercises the code. Only the clock is injected.
  - **An `at` parameter, not post-hoc SQL:** one optional argument per function, defaulting to now, is cheaper and safer than rewriting timestamps across nine tables afterwards (and the rating log lives in another service's database).
  - **Startup trigger via an env var:** it runs the same way locally (`SEED_HISTORY=50 npm run dev`) and on Fly (`fly secrets set SEED_HISTORY=50 -a uwdesk-web`, which restarts the app) with no proxies or database passwords on anyone's machine. It waits for the rating service (keep-warm is already waking it) and logs each policy.
  - **Rated on the rates in force now** (2026.2 locally, 2026.1 on Fly): every rate version was created on 2026-10-23, so there is no "version that was active in March" to pin to, and `issueQuote` refuses stale versions anyway.
  - **Sequence numbers aren't chronological:** quote, policy and journal numbers continue from today's sequences (a January policy may be GL-26-00004 while GL-26-00001 was bound in October); dates, not numbers, order every page. Quotes issued in December 2025 for January policies are numbered Q-2025-.
- **Dead ends / gotchas:**
  - Until `rated_at` existed, the rating service dated seeded ratings at seed time, so the Audit page opened on 100 "rating.calculated" rows from today. Locally the seeded log entries were back-dated with SQL from the quotes' `issued_at` and the worksheets' `updated_at`; Fly seeds fresh after the deploy.
  - Rating tests in a `python:3.12-slim` container skip the database tests unless `TEST_DATABASE_ADMIN_URL=postgresql://uw:uw@host.docker.internal:5432/postgres` (the default `localhost` is the container).
  - Two `next dev` processes share `.next`: stop the preview before a seeding run, or seed with the production server (`next build && SEED_HISTORY=50 next start -p 3101`).
  - zsh runs `$VAR "..."` as a command name (no word splitting): wrap `docker exec … psql` in a shell function. An unquoted heredoc turns backticks in a docstring into command substitution.
  - `SubmissionData` is an intersection type that object literals don't satisfy; build the object and cast.
- **How to show it:** before the demo, `SEED_HISTORY=50 npm run dev -- --port 3100` (or on Fly `fly secrets set SEED_HISTORY=50 -a uwdesk-web`, then `fly logs -a uwdesk-web | grep seed-history`), about a minute. Then: the desk (in-force premium and new business up, renewals due in January), **Policies** (50 more, bound January to October by nine underwriters, each with binder and policy PDFs), **Accounting → Year to date** (journals in every month, all "not yet pushed": push a quarter), **Upcoming renewals** (seeded policies expiring in January and February 2027 with Start renewal), and one seeded policy's **case history** (received in March, accepted, rated, quoted, bound in April, all by the same underwriter, with the rating-engine entries on the same days).

## step-20: The inbox refills itself (generated broker submissions)
- **Prompt used:** "If the submissions inbox ever goes below 5 outstanding submissions, create 10 new submissions."
- **What was built:**
  - **Top-up in `listInbox()`** (`lib/inbox.ts`): whenever fewer than `INBOX_MIN_OUTSTANDING` (5) drop-folder submissions are waiting, `INBOX_TOP_UP` (10) new ones are generated into the drop folder before the list is returned. The Submissions page, the desk's "N new submissions in the inbox" task and the Extract route all go through it, so the inbox is never found empty. One top-up runs at a time; a failure (an unwritable folder) is logged and not retried for ten minutes; `INBOX_AUTO_TOP_UP=0` turns it off.
  - **Generated submissions** (`lib/inbox-generate.ts`): fictitious risks from the shared `lib/synthetic-risk.ts` vocabulary (the same classes, places, producers and trades as the prior-system book and the seeded history), rendered with pdf-lib as the documents a broker sends, in the curated samples' mix: an ACORD-style 125/126 application (fillable, with the exact field names ingestion's `acord.py` reads, or flattened so Claude has to read it), a loss run, a cover email (`.eml`, multipart with the loss run attached, or a sparse "quick one for you" note with half the facts), and a supplemental questionnaire. About a third of them are built to trip a referral rule (New York, limits above authority, subs without certificates, receipts above authority, loss frequency, height, roofing) so intake and workbench demos have something to clear.
  - Folders are named `YYYYMMDD-HHMM-<insured-slug>`, sort to the top of the inbox as newest, and are titled by the insured's name (`folderTitle` drops the stamp). Locally they land in `samples/submissions/` and are git-ignored; in the image the drop folder is now owned by `node` so the app can write to it.
  - `lib/synthetic-risk.ts` is the one place the demo's fictitious contractors come from; `seed-history.ts` uses it too (its referral mix is "clearable"; the inbox's is "any").
- **Files:** `web/src/lib/{inbox,inbox-files,inbox-generate,inbox-generate.test,inbox-files.test,synthetic-risk,seed-history}.ts`, `web/Dockerfile`, `.gitignore`
- **Commit:** `step-20: ...`
- **Decisions:**
  - **Generate in the app, in TypeScript, on demand:** the Python sample generator needs reportlab and python-docx and a Python runtime the web image doesn't have, and a pre-rendered pool in the repo would be megabytes of PDFs that still run out. pdf-lib is already a dependency (quotes, binders), so the application, loss run and questionnaire are drawn with it and the email is written by hand; the Word application format is the one the generator doesn't produce.
  - **Trigger on listing, not on a schedule:** the count only drops when something is picked up or the machine restarts with a fresh image, and both are followed by a page that lists the inbox. No cron, no background worker, and the refill is visible on the very next render.
  - **Same field names as the curated samples**, so a generated fillable application extracts at 100% confidence from form fields exactly like the samples, and a flattened one goes through Claude like a scan.
  - **Deterministic per minute:** the stamp seeds the generator, names already in the folder are avoided, and a folder that already exists is skipped.
- **Dead ends / gotchas:**
  - pdf-lib: `addToPage` before `setFontSize`/`setText` on a new text field, or it throws "No /DA entry" (the widget creates the appearance string the font size lives in). Standard fonts only draw WinAnsi characters: strip dashes and quotes outside ASCII.
  - Pure modules that node:test imports must import each other with explicit `.ts` extensions (`./inbox-files.ts`), or Node can't resolve them; Next is fine either way.
  - The local ingestion container was a week old and lacked `/extract/stream`, so the first extraction of a generated submission answered 404. `docker compose up -d --build ingestion` fixed it; nothing to do with the generator.
  - `folderTitle` upper-cases "inc" like the other acronyms, so a title can read "Lone Star Millwork INC"; cosmetic.
  - Moving the shared vocabulary changed the order random numbers are drawn in, so a re-run of `SEED_HISTORY` produces different (new) insureds than the ones already seeded; the FEIN check only protects against re-running the same version.
- **How to show it:** extract submissions until the inbox shows 4 (or park some sample folders): the next visit to Submissions says "Inbox · 14 new" with ten stamped folders on top, each with its documents listed. Extract one: a fillable application reads instantly at 100% from form fields, the loss run goes through Claude, and intake review opens on a brand-new insured. Pick a sparse email: intake shows the gaps; a New York or $2M-limits case: the workbench shows the referral to clear.

## step-21: AI Assistant (ask the app anything, answered from its data with links)
- **Prompt used:** "Add a top nav item called 'AI Assistant' that enables the user to ask any question of the app and have an answer. The assistant should have access to all information in the app regardless of user (everyone is an admin), be powered by the same Claude API, and answers should always link to data in the app where relevant."
- **What was built:**
  - **`/assistant`** (nav: AI Assistant, also in the rate admin's mirrored header): a chat page. Each question is answered by Claude through the app's own **read-only tools**; while it works, the page shows every tool call live (name, arguments, duration), then the answer as rendered Markdown with the records as links into the app. Follow-ups carry the conversation's text; the model re-queries, so every answer rests on current data. Starter questions cover the inbox, this month's premium, renewals, a quote's pricing, open referrals, GL pushes and who wrote the most.
  - **Tools** (`lib/assistant-tools.ts`): `search_app` (names and identifiers across insureds, submissions, quotes, policies, binders), `list_submissions` / `get_submission` (the whole file: applicant, operations, losses, intake warnings, worksheet with the factor-by-factor rating, referrals open or cleared, quotes, policy, renewal basis), `list_quotes` / `get_quote` (terms, rating steps, schedule, subjectivities, renewal premium bridge), `list_policies` / `get_policy` (also prior-system policies; a desktop policy comes with its GL journal), `book_summary` (the desk's numbers for one underwriter or the whole operation with a per-underwriter breakdown), `renewals_due`, the six read-only GL tools shared with the MCP server (`gl_summary`, `gl_journals`, `gl_journal`, `gl_periods`, `gl_batches`, `gl_accounts`), `audit_search` (the cross-service timeline with filters), `rate_versions`, `inbox`, `get_insured`, `underwriters`. Every result carries `url` fields; the system prompt makes linking them a rule. Nothing is filtered by user and nothing writes.
  - **The loop** (`lib/assistant.ts`): the official `@anthropic-ai/sdk`, `claude-opus-5-5` (override with `ASSISTANT_MODEL`), adaptive thinking at `effort: medium`, the server-side refusal fallback (`fallbacks: "default"`), a cached system prompt, up to 12 rounds of parallel tool calls, tool errors returned as `is_error` results rather than thrown, and `refusal` / `max_tokens` / `pause_turn` handled. `POST /assistant/ask` streams the loop's events as NDJSON (the same pattern as the inbox extraction panel).
  - **Markdown** (`lib/markdown.ts` + `components/markdown.tsx`): a small dependency-free reader for the answers (headings, lists, pipe tables, code, quotes, bold, italics, inline code, links; relative links stay in the app).
  - Config: `ANTHROPIC_API_KEY` on the web app (locally in `web/.env`, copied from the root `.env` the ingestion service uses; on Fly a secret on `uwdesk-web`). Without it the page says so and the route answers with an error event.
  - 73 web tests (new: the tool-use loop with a fake API, including the tool result wiring, an unknown tool and a refusal; the Markdown reader).
- **Files:** `web/src/lib/{assistant,assistant.test,assistant-tools,markdown,markdown.test}.ts`, `web/src/components/markdown.tsx`, `web/src/app/assistant/{page.tsx,chat.tsx,ask/route.ts}`, `web/src/app/layout.tsx`, `web/src/lib/gl-mcp.ts` (exports its tools), `services/rating/app/templates/base.html`, `web/package.json` (+ `@anthropic-ai/sdk`)
- **Commit:** `step-21: ...`
- **Decisions:**
  - **Tools over the app's own functions, not SQL for the model:** the assistant calls the same library code the pages use (dashboard, readiness, quotes, ledger documents, timeline), so its numbers are the pages' numbers and every result already knows its URL. Direct SQL would have been more flexible and far less trustworthy.
  - **Read-only on purpose:** `gl_push` and every action stay out of reach; when asked to do something, the assistant explains where to do it and links the page.
  - **The web app calls the Claude API itself** (the key becomes a web secret too) rather than routing through the ingestion service: the data access lives in the web app, and one network hop fewer in a demo.
  - **Progress as tool-call events rather than token streaming:** the audience sees what the assistant looked at (which is the point of the demo) and the answer arrives whole and rendered; the loop stays a plain non-streaming `messages.create`.
  - **Opus 5.5 at medium effort** answers a two-tool question in about 20 s locally; `ASSISTANT_MODEL=claude-sonnet-5-5` is the faster, cheaper setting if that matters more than depth.
  - **Text-only conversation memory:** earlier turns go back as plain text, not as tool blocks, which keeps requests small and makes every answer re-check the data.
- **Dead ends / gotchas:**
  - A module node:test loads can't import the database layer: `assistant.ts` imports the tool module as a type only and `import()`s it on demand, and the tests inject fake tools and a fake `create`.
  - The SDK's `fallbacks: "default"` scalar needs the `server-side-fallback-2026-07-01` beta header (the array form uses a different one); the request is sent through `client.beta.messages.create`.
  - The Markdown reader merged a numbered list that followed bullets into one list until it was told a marker change starts a new list.
  - First real answer flagged two genuine oddities in the seeded data (a policy bound under the login "underwriter", and a renewal booked a month before its effective date); the assistant is a decent data auditor.
- **Follow-up: "what should I work on next" knows about the inbox.** Asked that, the assistant said the desk was empty while the inbox held several unextracted submissions: `list_submissions` only knows submissions that have been extracted, and nothing explained that an inbox item is work for whoever picks it up. Now a `work_queue` tool returns the whole pipeline's open work in one call (the inbox, oldest first and marked unassigned, plus every underwriter's desk tasks with days left and overdue flags, for one person or the team), and the system prompt spells out the workflow order and that an empty personal queue never means nothing to do while the inbox has submissions.
- **Follow-up: ask from the desk.** Under the desk's title there is an open text box ("AI Assistant - Ask Me Anything"); submitting it opens `/assistant?q=<text>`, which asks the question on arrival and then cleans the URL so a refresh doesn't ask again.
- **How to show it:** AI Assistant → click "How much premium did we write this month, and which policies make it up?": the tool calls appear as they run (`gl_summary`, `gl_journals`), then the answer with a linked table and the asker's own share. Then type "Why is Q-2026-0004 priced the way it is?" (search → quote → rating steps, with the renewal bridge) and "Who changed the rate tables?" (audit_search). Click any link: it is the real record.

## step-22: A sign-in page instead of the browser's password prompt
- **Prompt used:** "The sign-in landing page is an ugly pop-up. I'd rather it be a styled landing page with the fields on the page, not a pop-up."
- **What was built:**
  - **`/signin`**: a page of the app's own (wordmark, User ID and Password fields, one button, an error line, a "you're signed out" note), shown without the header chrome. Signing in sets a **signed, expiring session cookie** (`uw_session`, HMAC-SHA256 over the user and expiry, HttpOnly, SameSite=Lax, Secure on https, 7 days) and returns to the page the person was heading for (`?next=`, local paths only). The same logins as before (`BASIC_AUTH_USERS`), checked in constant time.
  - **Middleware** accepts either the session cookie or an HTTP Basic header. A browser navigation without either is redirected to `/signin?next=…`; `/api/*` callers still get the JSON 401 with the Basic challenge their clients understand; a page's own fetch (the assistant, the inbox panel) after a session ends gets a JSON 401 without a challenge, so the browser never shows its prompt again.
  - **Sign out** now clears the cookie and shows the sign-in page ("You're signed out"). `/signin` and `/signout` are outside the gate.
  - The signing key is `SESSION_SECRET` when set, else derived from the configured logins, so the deployment needs no new secret and changing the passwords signs everyone out.
  - 75 web tests (new: session sign/verify/tamper/expiry, `checkPassword`).
- **Files:** `web/src/lib/{session,session.test,basic-auth,basic-auth.test}.ts`, `web/src/middleware.ts`, `web/src/app/signin/{page.tsx,actions.ts}`, `web/src/app/signout/route.ts`, `web/src/app/layout.tsx`
- **Commit:** `step-22: ...`
- **Decisions:**
  - **Cookie for people, Basic for systems:** the REST API and the MCP endpoint are documented as HTTP Basic and other tools expect the challenge, so that stays; the browser gets a session instead. Both paths set the same signed-in-user header, so nothing downstream changed.
  - **A server action for the form:** it sets the cookie and redirects in one place, with no API route to protect; the page is a server component.
  - **Redirect only for navigations:** a 302 to an HTML page is the wrong answer to a fetch, so the middleware looks at the method and `Accept` to tell a person from a page's own request.
  - **No header on the sign-in page:** the layout hides the chrome whenever the gate is on and nobody is signed in, which is exactly the sign-in page.
- **Dead ends / gotchas:**
  - `/signout` was inside the gate at first, so a stale session clicking Sign out was bounced to sign in with `next=/signout` and signed straight out again; it is excluded from the matcher now, as `/signin` is.
  - A gated build on plain http needs the cookie without `Secure`; it is set from the request's scheme (`requestOrigin`), not from `NODE_ENV`.
  - Server actions can't be driven with curl; the form was exercised in the browser, the rest (redirect, 401s, sign-out, a forged cookie) with curl.
- **How to show it:** open the live site signed out: the sign-in page; sign in and land where you were going; **Sign out** under your name returns to it with the confirmation. `curl -u underwriter1 …/api/gl` still works for other systems.

## step-23: Pre-demo fix batch from the code review (12 findings)
- **Prompt used:** "Review docs/CODE_REVIEW.md and tell me what you think about the recommendations" → "Yes, fix the pre-demo batch as one step commit: CR-051, CR-065, CR-044, CR-073, CR-041, CR-037, CR-054, CR-062, CR-055, CR-030, CR-047 and CR-027, with build log and playbook entries."
- **What was built:** the dozen review items most likely to bite in a live demo, picked over the report's own severity order:
  - **Cross-site form posts refused (CR-051, CR-065):** one `sameOrigin()` in `web/src/lib/http.ts` (refuses when `Sec-Fetch-Site` is cross-site, or `Origin`/`Referer` names another host; a request with neither header, i.e. curl or another system, passes). Applied to the `/admin` proxy for POST, the inbox extract route, the Accounting export and `POST /api/gl/exports`. The rating admin makes the same check itself (`same_origin` dependency on its three POST routes), so it is safe standalone too.
  - **Rate-version label (CR-044):** the Activate confirmation reads its text from a `data-confirm` attribute instead of inlining the label in JavaScript; labels are constrained to `[A-Za-z0-9._-]{1,32}` in the API model and in `create_draft` (so the admin form gets a readable error, not a draft).
  - **Inbox top-up under compose (CR-073):** the drop folder is mounted writable; a failed top-up now shows an amber line on the Submissions page (`inboxWarning()`) instead of only a server log line.
  - **Rating calls (CR-041, CR-037):** one `rateOn()` client in `rating-api.ts` reads the body as text first, so an HTML 502 from a starting machine is "Rating service error 502: …" rather than a SyntaxError; `issueQuote` and the worksheet use it. A failed rating only discards the last rating when the service refused the inputs (4xx); a service that is down leaves it in place, marked not current. Every web call to rating waits 15 s (was 3–5 s), longer than a Fly cold start.
  - **Deploy script (CR-054):** `env_value()` reads `ANTHROPIC_API_KEY` from `.env` the way compose does (quotes, `# comment`, CR and whitespace stripped) and refuses a value that doesn't start with `sk-ant-`.
  - **Referral rules (CR-062, CR-055, CR-030):** "No loss runs" fires whenever no loss run is on file, sized to tenure ("all 2 years in business" under five years, else "5 years"), and the quote subjectivity is worded the same way. "Class code inferred" only fires while the worksheet still carries the inferred class. A claim is open unless its status is recognizably closed (`isOpenLoss`: "O", "OPEN-LIT", "Reopened", "Pending" all refer; "C", "CWP", "Closed - paid" don't), used by the rule, the review page and the renewal snapshot; ingestion normalizes statuses to `Open`/`Closed` at the source (`normalize_status`).
  - **Small things (CR-047, CR-027):** the "Working as" form keeps the page's query string (minus `msg`/`error`); the app has styled `error.tsx` and `not-found.tsx` pages.
  - Tests: 79 web (new: `sameOrigin`, return-path query, loss-status, tenure, inferred-class cases), 35 rating (new: cross-site 403s, label constraints, confirmation markup), 49 ingestion (new: status normalization).
- **Files:** `web/src/lib/{http,http.test,rating-api,worksheets,quotes,health,timeline,inbox,referrals,referrals.test,quote-terms,quote-terms.test,renewals}.ts`, `web/src/app/{error,not-found}.tsx`, `web/src/app/admin/[[...path]]/route.ts`, `web/src/app/submissions/inbox/[folder]/extract/route.ts`, `web/src/app/accounting/export/route.ts`, `web/src/app/api/gl/exports/route.ts`, `web/src/app/submissions/page.tsx`, `web/src/app/submissions/[id]/page.tsx`, `services/rating/app/{admin,main,repository}.py`, `services/rating/app/templates/version.html`, `services/rating/tests/test_rate_admin.py`, `services/ingestion/app/schema.py`, `services/ingestion/tests/test_ingestion.py`, `docker-compose.yml`, `scripts/fly-deploy.sh`
- **Commit:** `step-23: ...`
- **Decisions:**
  - **Origin check, not CSRF tokens:** every browser sends `Origin` on a POST and `Sec-Fetch-Site` on everything, so a header check protects the plain route handlers without threading a token through forms and the proxy. Server Actions already get this from Next.
  - **The review's order was not the demo's order.** Two Highs and the compose mount were taken; the lost-update guards (CR-017, CR-052) were left, since they protect two underwriters editing one file at once, which the demo never does.
  - **Kept the raw status when unknown:** `normalize_status` maps what it recognizes and leaves the rest as written, so nothing is invented; the web rule then treats anything not recognizably closed as open, which is the conservative reading for a referral.
  - **Rating timeouts rather than `min_machines_running = 1`:** keep-warm already starts the machines in most cases, and 15 s covers the rest without paying for an always-on machine.
- **Dead ends / gotchas:**
  - `quote-terms.ts` now imports a value from `referrals.ts`; between the pure modules that `node --test` loads the import needs the `.ts` extension (as `renewal-compare.ts` and `gl-query.ts` already do), or node can't resolve it.
  - The rating admin test with a trailing-space label would have created a draft (the form strips before validating); the parametrized bad labels avoid that case.
  - Python suites run on this Mac only in a container: `docker run --rm -v "$PWD/services/rating:/app" -w /app --network underwriting-desktop_default -e TEST_DATABASE_ADMIN_URL=postgresql://uw:uw@db:5432/postgres python:3.12-slim /app/.venv/bin/python -m pytest -q`, and for ingestion mount the repo root (`-v "$PWD:/repo" -w /repo/services/ingestion`, `uv sync --frozen --all-groups`) so `tests/conftest.py` finds `samples/`.
- **How to show it:** `curl -X POST -H 'Origin: https://evil.example' -d reason=x https://<web>/admin/versions/1/activate` → 403 while the Rate tables page still activates; extract inbox folders until fewer than five remain under `docker compose` and watch ten appear; open a submission with no loss run and unknown tenure: the "No loss runs" warning and its subjectivity are there; `/quotes/<junk uuid>` shows the styled not-found page.

## step-24: The sign-in report (who signed in, from where, daily)
- **Prompt used:** "Create a repeatable report that shows me who has logged in over the last 24 hours and all time along with any metadata that we capture on log in (IP, geography, etc.). I want to be able to run this report daily."
- **What was built:** nothing was recorded at sign-in before this step (the sign-in action only set the cookie), so the step is two halves: the log, then the report over it.
  - **The log:** `policy.login_events`, one row per attempt on the sign-in page (success or failure, with the user named only when the login exists) and one row per login, client address and hour for HTTP Basic callers of the GL API and the MCP endpoint. Each row keeps the client address (`Fly-Client-IP` on Fly, which a client can't forge; else the first `X-Forwarded-For` hop), user agent, `Accept-Language`, the Fly edge region, and a geo lookup of the address (country, region, city, timezone, ISP, ASN) from ipwho.is, keyless. The lookup runs after the response (`after()` from `next/server`), so signing in never waits on it; rows it missed are retried, ten at a time, whenever the report runs. Private and local addresses are marked as such instead of looked up.
  - **The report:** `/audit/logins` (Admin → Sign-ins, and a link from the Audit trail): four tiles, who signed in over the window (24h, 48h or 7 days) and all time with first/last seen, every address and every location they've used, every attempt with result, address, location, network, edge, browser and language, and the configured logins that have never signed in. `GET /api/reports/logins?format=json|md|csv&hours=24` serves the same report behind the API's Basic login. `scripts/login-report.sh` fetches the Markdown (or `--csv`, `--json`) from the Fly site with the login in `.fly-credentials` (or `UW_URL`/`UW_LOGIN`), prints it and files it under `reports/logins/<date>.md` (git-ignored: it holds addresses).
  - Tests: 83 web (new: header parsing, private ranges, place and browser labels, the report's window/all-time split, per-user totals and never-signed-in logins, the Markdown).
- **Files:** `web/migrations/policy/007_login_events.sql`, `web/src/lib/{login-meta,login-meta.test,login-events}.ts`, `web/src/app/signin/actions.ts`, `web/src/lib/gl-http.ts`, `web/src/app/api/mcp/route.ts`, `web/src/app/audit/logins/page.tsx`, `web/src/app/api/reports/logins/route.ts`, `web/src/app/audit/page.tsx`, `web/src/app/layout.tsx`, `scripts/login-report.sh`, `.claude/launch.json` (a `web-signin` preview with the gate on), `.gitignore`
- **Commit:** `step-24: ...`
- **Decisions:**
  - **Its own table, not `audit_events`:** the audit trail is about records (entity type and id are required); a sign-in has none, and the report wants columns (address, geo) the audit rows don't carry.
  - **Look up geography at sign-in, not at report time, but after the response:** the report should be instant and complete; the sign-in should never wait on a third-party service. `after()` gives both, and the report's retry covers the gaps.
  - **ipwho.is** because it needs no key or account (rule 5); the address is the only thing sent. ipapi.co rate-limited the first test call.
  - **API logins once an hour per login and address, not per request:** the GL API sends the login on every call; the report should say "this client was here", not drown in one row per request. The dedupe map lives on `globalThis` (as the DB pools do) because `next dev` re-instantiates modules between requests; a browser session calling the Try-it links is not counted as an API login (no `Authorization: Basic`).
  - **No seeded sign-ins:** the seeded book has made-up policies, but made-up addresses and locations in a sign-in report would be a fabricated audit record. The report starts empty and fills as people sign in.
  - **The report is produced by the app, not by a query against the database,** because the Fly database is reachable only from the app; the script therefore works the same against Fly and a local run.
- **Dead ends / gotchas:**
  - A module-level `Map` for the hourly dedupe wrote a second row for the same login 16 s later under `next dev`: module state does not survive between requests there. `globalThis` does.
  - Locally the gate is off, so there is nothing to sign in to: the `web-signin` launch config starts the app on port 3101 with two demo logins (`BASIC_AUTH_USERS` inline). `next dev` sets `X-Forwarded-For: ::1`, which the report shows as a private address.
  - To exercise the geo path locally, send a public address yourself: `curl -u underwriter2:demo-pass-2 -H 'X-Forwarded-For: 8.8.8.8' localhost:3101/api/gl` lands as an `api` row placed in San Jose by Google LLC (on Fly, `Fly-Client-IP` wins over anything the client sends).
- **How to show it:** sign in on the live site, open **Admin → Sign-ins**: your row with address, city, ISP, browser and the Fly edge; one wrong password first, so a failed attempt shows too. Then `scripts/login-report.sh` in the terminal: the same report as Markdown, saved under `reports/logins/`; `--csv` for the spreadsheet. `curl -u underwriter1:… https://<web>/api/reports/logins` for the data.

## Fix: whole-word claim statuses (CR-077) and a same-origin check on the assistant (CR-079)
- **Prompt used:** "Retest everything thoroughly now that you have applied fixes and produce a new report with findings."
- **What was built:** the re-audit after step-23 found one regression in it and one route the batch had missed. `normalize_status` in ingestion matched any status starting with "c" as closed (`"Claim open"`, `"Contested"` → `Closed`); both patterns now require whole words, the open pattern is tested first (`"Closed - reopened"` stays closed), and unrecognized text is kept as written, which the web tier treats as open. `POST /assistant/ask` (step 21) now refuses cross-site requests with `sameOrigin()` and non-JSON bodies with 415, like every other expensive route handler. Tests: 55 ingestion (six new status cases), 79 web.
- **Files:** `services/ingestion/app/schema.py`, `services/ingestion/tests/test_ingestion.py`, `web/src/app/assistant/ask/route.ts`, `web/src/lib/referrals.test.ts`
- **Commit:** `fix: CR-077 …, CR-079 …`
- **Dead ends / gotchas:** `re.match(r"^(c|closed)")` is a prefix match, not a word match; the TypeScript twin had `\b` from the start, which is why the web tests never caught it. Re-verification after a fix batch is worth the run: the auditor caught this within the hour.
- **How to show it:** upload a loss run whose status column says `Claim open` for a $150K claim: the workbench refers it. `curl -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"question":"hi"}' <web>/assistant/ask` → 403.

## Fix: the assistant's key reaches the web app (CR-078) and sign-out is a same-origin POST (CR-081)
- **Prompt used:** "Yes, fix both" (CR-078 and CR-081 from the re-audit, before deciding on a push).
- **What was built:**
  - **CR-078:** under `docker compose up` and after `fly-deploy.sh` the web app never had `ANTHROPIC_API_KEY`, so the desk's "Ask Me Anything" box answered "The assistant needs ANTHROPIC_API_KEY" while ingestion extracted with the same key. Compose now passes the key (and `ASSISTANT_MODEL`) to `web` exactly as it does to `ingestion`; the deploy script sets the same secret on `<prefix>-web`; `assistant.ts` reads `UW_ANTHROPIC_API_KEY || ANTHROPIC_API_KEY` (the cloud-sandbox name ingestion already honours) and hands it to the SDK explicitly. `.env.example` and the README say the one key serves both.
  - **CR-081:** `/signout` was a GET outside the gate, so a cross-site `<img src>` or a link in a broker email could end an underwriter's session. It is now `POST` (refused with 403 unless `sameOrigin()`), the "Sign out" in both headers (the web app's and the rate admin's mirrored one) is a one-button form styled as the old link, and a GET shows a small confirmation page with that button instead of signing anyone out.
- **Files:** `docker-compose.yml`, `scripts/fly-deploy.sh`, `.env.example`, `README.md`, `web/src/lib/assistant.ts`, `web/src/app/signout/route.ts`, `web/src/app/layout.tsx`, `services/rating/app/templates/base.html`
- **Commit:** `fix: CR-078 …, CR-081 …`
- **Decisions:** a plain `<form method="post">` rather than a Server Action for sign-out, so the rating admin's server-rendered header (which has no React) can post the same thing; the route keeps the `sameOrigin()` header check the other route handlers use.
- **Dead ends / gotchas:**
  - Clicking the new button in a container built from the image sent the browser to `http://0.0.0.0:3000/signin`: in the standalone image `req.url` is the server's own `HOSTNAME:PORT`, not the address the browser used, and the route had built its redirect from it since step 22 (the GET had the same bug; the middleware's own redirects were already relative). The route now sends a relative `Location`.
  - `header.desktop form { margin-left: auto }` in the admin template also matched the new sign-out form and pushed it to the far right; a `.who form { margin: 0 }` rule (more specific) keeps it under the name.
- **How to show it:** with the key in `.env`, `docker compose up --build` and ask the desk a question: an answer, not the configuration message. `curl -X POST -H 'Origin: https://evil.example' <web>/signout` → 403; `curl <web>/signout` → the confirmation page, cookie untouched; the header button still signs out.

## UX batch: 23 recommendations from `docs/UX_REVIEW.md` (UX-001 … UX-025, except UX-020)
- **Prompt used:** "Push everything except UX-020 and tell me in detail what that recommendation is." (Everything = the 24 outstanding items in the Oct 31 UX review.)
- **What was built:** three commits, one per area, each naming its IDs (`git log --grep UX-0`):
  - **Workbench and intake forms** (`198c6ca`): the review, worksheet and issue-quote forms validate in the browser first (`inputMode`, `pattern`, `type=date`, number bounds) and, on a server rejection, come back as typed with the message under the field (`useActionState`; a shared `action-form.tsx` provider that also drives the sticky-header Save button outside the `<form>`). One review form with **Save corrections** and **Save & accept intake**. Clear / Issue / Bind are disabled with "Save & rate your changes first" while the worksheet is dirty. The Quote card names worksheet drift against the latest issued quote (fields and both totals), promotes Issue vN and demotes Bind; the header chip is now a pair (commercial `Quoted · Q-… v2` / `Bound · GL-…` that persists, plus a worksheet chip) shared with the renewal page. Rating inputs show `$` / `%` / `ft` with separators, right-aligned. Pending labels on every submit, full snippets, clearance times, sticky title row with "Unsaved changes", Re-rate returns to the comparison.
  - **Rate admin** (`107fcf1`): a failed section save re-renders (422) with the posted cells and a required reason; the Activate card lists what differs from the *active* version, warns about a retired base and about unsaved edits (button disabled until saved); timestamps in `DISPLAY_TZ` with the zone name; pending labels; width/font/pills match the desktop; factors and rates with two decimals. 63 rating tests (was 35).
  - **Lists, nav, accounting, policies, PDFs** (`7a45afa`): Stage column, count line and `?stage=` filters on the Received table (`lib/stage.ts`); one display zone for every timestamp (`lib/time.ts`, `when`/`whenDate`), audit day filters bucketed in it; plain-language extraction errors with **Try again** (`lib/service-errors.ts`); active nav state (`nav-link.tsx`) and per-page titles via `title.template`; `slate-500` instead of `slate-400` for content text (the dark extraction console keeps its palette); header rows and link styling, insured names link to the customer; policy Coverage shows limits/deductible/class/states/forms; the quote PDF names the version it supersedes and the rate version moved to the footer; pushing to the GL goes through a server action that 303s to a banner with the batch, the stamped lines and the download (`auto-download.tsx`); Start renewal shows days to expiry and confirms; "just issued" is emerald; on-screen dates read `Dec 1, 2026`.
  - **Regression fixes** (`e673fd4`), found by re-running the reviewer against the live app: the admin's `font` shorthand referenced a CSS variable that only exists in the desktop document (invalid at computed-value time, so the whole admin fell back to the browser serif); the admin audit formatted version labels as factors (`2026.10 → 2026.20`); the fuller snippets turned a fillable-ACORD intake into 32 two-line field-name quotes (now one provenance line per form-field read); labels repeated the unit the input now shows; the "Unsaved changes" hint and the Clear/Issue/Bind guard read different dirty states.
  - The 18:14 re-review confirmed all five fixed and left 8 items (UX-020, 025, 030, 031, 033, 034, 036 and UX-035, a seam in the long-snippet expander). UX-035 is fixed in the commit after that run; the next daily run will mark it.
- **Files:** see the commits; new shared pieces are `web/src/lib/{time,stage,service-errors,gl-query}.ts`, `web/src/components/{submit-button,dirty-hint,nav-link,auto-download}.tsx`, `web/src/app/submissions/[id]/{action-form,status-chips}.tsx`, `web/src/app/submissions/[id]/workbench/worksheet-input.tsx`, `web/src/app/policies/start-renewal-form.tsx`, `web/src/app/accounting/actions.ts`.
- **Decisions:**
  - **Three parallel builders with disjoint file ownership** (workbench area / rating service / the rest), then a single codemod for the contrast change, because UX-012 touched 23 files that all three would otherwise have edited.
  - `SubmitButton` relies on `useFormStatus`, which only reports pending for server-action forms, so the accounting Export buttons post through a server action; the old `export/route.ts` still exists and 303s for anything else that posts to it.
  - **UX-020 left open on purpose** (developer detail behind human labels); see the UX review for the full recommendation.
- **Dead ends / gotchas:**
  - `toLocaleString` with `dateStyle`/`timeStyle` **plus** `timeZoneName` throws `RangeError: Invalid option : option` in V8. Use component options (`month, day, year, hour, minute, timeZoneName`). The first build of `lib/time.ts` took every page down with this; `time.test.ts` now pins it.
  - Node's strip-only TypeScript (`node --test` on `.ts`) rejects parameter properties (`constructor(readonly x)`) and needs explicit `.ts` import extensions in test files.
  - A unit-test module that imports `app.db` before `conftest.py` sets `DATABASE_URL` hits the live rating DB; `conftest.py` now sets it at import time.
  - The dark extraction console (`activity-panel.tsx`) legitimately uses `text-slate-400` on `bg-slate-950`; a blanket codemod lowers its contrast. Exclude it.
- **How to show it:** open a quoted workbench, type letters into Deductible → the browser refuses the submit; type `150` into Residential % → the page comes back with the error under the field and every other edit intact, Bind greyed out with "Save & rate your changes first". Change the deductible for real and Save & rate → the Quote card says what differs from v2 and offers **Issue revised quote (v3)**. `/submissions` → Stage column and filters. `/accounting` → Export Excel → the green "Pushed batch …" banner. `/admin/versions/3` → the Activate card lists what would change in production.

## UX batch 2: the remaining polish items (UX-025, 030, 031, 033, 034, 036) and UX-020 declined
- **Prompt used:** "retire UX-020 since I like the detail for the purposes of demo" then "complete the other recommendations".
- **What was built:** one commit naming the six IDs (`git log --grep UX-034`): admin timestamps in the desktop's format (`Oct 22, 2026, 9:55 PM EDT`), the renewal Terms period and ISO values in audit diffs through `whenDate`/`when`; two decimals on worksheet factors, the engine's base-rate detail and the quote page's underwriting basis (now `inputText`); a `plural()` helper on the desk and a bridge rating labelled `(expiring rates)` so the audit summary stops reading `on 2026.1 on 2026.1`; the workbench header drops the `accepted` badge, the done chip is tinted, quote statuses are `<Pill>`s; a shared `components/stage-chip.tsx` plus `submissionStagesById()` so search results and the customer page show the inbox's Stage vocabulary (`Bound GL-26-00051`) with a next step that follows it (Review / Workbench / Policy); the Referrals card title counts `open · cleared · warn` from `clearanceStatus`.
- **UX-020 declined.** The report's status line carries the reason (the model, token counts, action codes and folder stamps are wanted on screen for the demo); the reviewer leaves Declined items alone.
- **Files:** `services/rating/app/{admin,engine}.py`, `services/rating/tests/*`, `web/src/components/stage-chip.tsx` (new), `web/src/lib/{dashboard,renewal-compare,timeline-merge,worksheets}.ts`, `web/src/app/{search,insureds/[id],quotes/[id],submissions}/page.tsx`, `web/src/app/submissions/[id]/{status-chips.tsx,workbench/page.tsx,renewal/page.tsx}`
- **Decisions:** the customer page's "Policy →" for a bound file goes through `/search?q=<policy number>`, which already redirects an exact reference straight to the record, instead of adding a policy id to the customer query. Stored rating details keep the `$22.0000` text they were rated with; only new ratings show `$22.00`.
- **Gotchas:** `strftime("%-d")` / `%-I` (no zero padding) is fine on macOS and Linux but not Windows; the admin runs in a Linux container.
- **How to show it:** `/search?q=roof` → each file shows its stage, not `accepted`; open a customer → Stage column with `Policy →` for bound files; the roofing workbench → `Referrals · 3 open · 1 cleared` matches the `3 referrals open` chip; `/admin` → times read like the desktop's.

## UX batch 3: the five items the fresh-eyes review raised (UX-037 … UX-041)
- **Prompt used:** "Build the five".
- **What was built:** one commit naming the five IDs. A bound file's workbench is frozen: no Save & rate, inputs in a disabled fieldset, an emerald line naming the policy, who bound it and when, and where changes go (endorsement, or the renewal from the policy page); the premium card reads "Premium as bound"; `saveAndRateAction` refuses when a policy exists so a stale tab cannot re-rate. `workbench/bind-form.tsx` asks before Bind with the quote, the amount and how many subjectivities stay open (the Activate and Start renewal pattern). Schedule percent and reason inputs, each Clear note and every admin rate cell have an `aria-label` built from their row. `Stage` carries `href` to the policy, so `/submissions` and the customer page link `Policy →` straight to `/policies/<id>` (the search redirect is gone). `lib/text.ts` holds `plural()`; the receive, accept and GL-push summaries use it, and the bind, renewal-start and subjectivity summaries use `whenDate()`.
- **Files:** `web/src/app/submissions/[id]/workbench/{page.tsx,actions.ts,bind-form.tsx}`, `web/src/app/{submissions,insureds/[id]}/page.tsx`, `web/src/lib/{stage,dashboard,text,submissions,ledger,policies,renewals,timeline-merge}.ts`, `services/rating/app/templates/version.html`
- **Decisions:** the frozen worksheet keeps the inputs visible (greyed) rather than swapping to a read-only table, so the bound rating stays legible in the layout the underwriter knows. Stored summaries keep their old text; only new events change.
- **How to show it:** open Desert Bloom's bound workbench → "Worksheet frozen at bind", greyed inputs, "Premium as bound"; `/submissions?stage=bound` → every row says `Policy →`; on a quoted workbench click Bind → the dialog names the quote, the amount and the open subjectivities, and Cancel does nothing.
