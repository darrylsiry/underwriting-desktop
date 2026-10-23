# Demo playbook (presenter's crib sheet)

Run-of-show for the live session. Each step is a prompt to type into Claude
Code in the **live** repo. Claude there will pull the matching step from
`docs/BUILD_LOG.md` in this repo and port it.

## Before the session
- Start a Claude Code session on `underwriting-desktop-live` **with
  `underwriting-desktop` also attached** (both repos selected), so it can
  read this reference.
- Have the finished reference app running in another tab as the
  fallback if anything goes sideways.

## Steps
| # | Prompt to type | What they'll see |
|---|----------------|------------------|
| 01 | "Scaffold the monorepo from the plan: Next.js web app, FastAPI rating and ingestion services, one Postgres with customer/policy/rating DBs, docker compose, and a status page that health-checks everything." | Four services come up; status page shows all green |
| 02 | "Generate ~8 realistic contractors GL submissions in mixed formats (fillable ACORD-style PDFs, a flattened PDF, broker emails, a questionnaire, a Word app, loss runs) with ground-truth JSON for each." | A folder of broker-style documents that look real |
| 03 | "Build the rating service: versioned rate tables (class base rates, territory, limits, deductible, residential, subcontracting, height, schedule mod bounds, fees, surplus lines tax), POST /rate returning a step-by-step worksheet, log every call, with tests." | Tests pass; Swagger at :8001/docs rates a risk and shows the worksheet |
| 04 | "Add a rate-table admin UI to the rating service at /admin: copy the active version into a draft, edit values one rating variable at a time with a required reason, show what changed vs the base version, audit every change with before/after, and activate the draft to make it live. Same operations in the API, with tests." | Draft 2026.2, raise Florida's territory factor with a reason, see "was 1.25", activate, audit trail shows who/what/why |
| 05 | "Build the ingestion service: POST /extract takes all documents in a submission (PDF, email with attachments, Word), classifies each, reads fillable ACORD PDFs from form fields, sends the rest to Claude with a strict JSON schema, and returns the canonical submission JSON with per-field confidence, stated vs inferred, source and snippet. Add a scorer against the ground truth." | Upload a sparse broker email in Swagger and get a rateable submission with inferred class code and cited snippets; the scorer prints 250/251 correct |
| 06 | "In the web app, build a submission inbox: upload a broker submission's documents to the ingestion service and store them, then an intake review page that shows each field's confidence, stated/inferred badge and source snippet, highlights what needs attention, lets the underwriter correct fields with an audited before/after, and accept the intake once the rating fields are present." | Upload the sparse email, see flagged inferred fields with snippets, fix the FEIN, accept; the history shows the correction |
| 07 | "Add an underwriting workbench for accepted submissions: editable rating inputs seeded from the submission, schedule credits/debits by category with required written reasons, Save & rate through the rating service showing the premium worksheet, and deterministic referral rules (large open claim, loss frequency, uninsured subs, NY, height, roofing, authority limits) that must be cleared with a note before it's ready to quote. Audit everything." | Roofing risk lights up four referrals; a +18% schedule trips the authority rule; a manager clears one with a note; a clean risk shows "Ready to quote" |
| 08 | "When a worksheet is ready to quote, issue a quote: confirm dates and subjectivities (suggested from the file's warnings), re-rate through the rating API pinned to the rate version shown, save a numbered, versioned quote in the policy DB that supersedes earlier versions, and generate and store a one-page quote PDF. Add a Quotes list." | Click Issue quote and open a clean quote PDF; change the deductible, issue v2, and see v1 superseded in /quotes |

## Things to show off along the way
- Plan mode before a bigger change
- Claude running the app/tests and fixing its own errors
- Subagents for parallel work
- PR creation and review
