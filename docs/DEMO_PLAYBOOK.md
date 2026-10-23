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

## Things to show off along the way
- Plan mode before a bigger change
- Claude running the app/tests and fixing its own errors
- Subagents for parallel work
- PR creation and review
