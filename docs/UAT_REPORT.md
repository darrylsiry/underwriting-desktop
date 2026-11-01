# UAT report: Underwriting Desktop

Run: 2026-10-31, 21:55–22:01 EDT · code 9afd8c7 (same as origin/main) · live site https://uwdesk-web.fly.dev

## Verdict
The app works end to end. The sandbox ran every writing flow on a disposable copy, and the live site passed every page, download, API and MCP read check with the `uat` login. All 125 tests passed with no failures and no retries. One sandbox test was skipped by design, and there are two coverage gaps, listed under Coverage.

## Summary
| Pass | What it covers | Passed | Failed | Skipped | Result |
|------|----------------|--------|--------|---------|--------|
| Sandbox flows | every function end to end, writes included, on a disposable copy | 59 | 0 | 1 | PASS (53.0 s) |
| Canary | the read-only suite on the sandbox, data compared before and after | 33 | 0 | 0 | PASS (1.2 min), no table changed |
| Production | every page, download, API and MCP read on the live site, writes blocked | 33 | 0 | 0 | PASS (1.9 min), 0 flaky / 0 retries |

The harness exited 0 ("Overall: PASS"). The sandbox was built from 9afd8c7 with no uncommitted changes under web/ or services/. It was removed afterwards (containers and database volume).

## Production safety
- **Writes the guard stopped on the live site: 6.** All six came from the deliberate dry-run tests in `04-dry-run.spec.ts`, which click each write button to prove it is wired up:
  - Save & rate: POST `/submissions/b18c642c…/workbench` (server action)
  - Bind, after its confirmation: POST to the same workbench (server action)
  - Extract from the inbox: POST `/submissions/inbox/06-empire-builders-gc/extract`
  - Push to the GL: POST `/accounting?period=all` (server action)
  - Create a rate-table draft: POST `/admin/versions`
  - Sign out: POST `/signout`

  The crawl made no blocked requests, so no page tried to write just by being opened. The canary pass blocked the same six on the sandbox.
- **Canary:** no table changed except `policy.login_events`, which went from 6 to 8 rows. Those are the expected HTTP Basic "api" sign-in rows. `inbox.folders` did not change.
- **Login used on production:** `uat`, read by the harness from `.fly-credentials`. No `underwriter1`–`9` login was used.

## Failures
None. No test failed in any pass, and none needed a retry on production, so there was nothing to classify or recheck.

Two observations. Neither is a failure:

### UAT-O1 Opening a never-worked workbench writes (known design, worked around)
- **Where:** `/submissions/:id/workbench` (and `/renewal`) for an accepted submission that has never been rated.
- **What happens:** loading the page calls `openWorksheet(...)` at `web/src/app/submissions/[id]/workbench/page.tsx:55`. That creates the worksheet and a `worksheet.opened` audit event, so this GET writes.
- **Effect on this run:** the crawl deliberately skips these pages (`uat/tests/readonly/03-crawl.spec.ts:24-29, 60`). On production it skipped 2: `/submissions/a427c252-2980-4c4d-a024-aa24a9f7cfc2/workbench` and `/submissions/59eb2295-34e6-4190-b191-60285fdaf92d/workbench`. So the read-only pass does not cover the first-open render of a workbench. The sandbox flows do cover it ("open the workbench: not rated until Save & rate").
- **Suggestion (optional):** if the owner wants GETs to be pure, create the worksheet on first Save & rate instead of on page load. Then the crawl could open every workbench.

### UAT-O2 The referral-clearing step cleared nothing (coverage gap, Test drift)
- **Where:** `uat/tests/sandbox/20-workbench.spec.ts:43-49`, "clear every referral with a note, then the file is ready to quote".
- **Evidence:** the test recorded `referrals cleared: 0`. The submission it picked up from the inbox triggered no referrals, so the test passed without clicking Clear even once. The other `clearReferrals` calls (lines 71 and 142, and `40-renewal.spec.ts:27`) don't record a count, so this run doesn't show that clearing a referral was exercised at all.
- **Suggested fix:** pick a sample submission known to refer, or force a referral first (for example a large schedule credit, or a class or limit that is known to refer). Then add `expect(n).toBeGreaterThan(0)` at line 46.

## Coverage
- **Production crawl:** 47 pages across 38 page shapes, all HTTP 200 with a heading and no page errors. 10 files fetched, all valid `application/pdf`:
  - 2 quote PDFs and 2 renewal memos
  - 2 binders and 2 policy documents
  - 2 submission source documents
- **Canary crawl:** 50 pages across 38 page shapes. 7 PDFs: quote, memo, binders and policies.
- **Page shapes visited:**
  - Desk, customers and customer detail
  - Submissions (with stage filters), submission detail, workbench, renewal comparison
  - Quotes (with filters) and quote detail; policies (with filters) and policy detail; prior-system book policy
  - In-force book (renewals due 90 and 120 days, loss view); search
  - AI assistant, blank and with a question
  - Audit trail: paged `before=` view, case history by submission and correlation
  - Sign-ins (48 h and 168 h)
  - Accounting: periods and batches, API docs, MCP console
  - Rate admin: versions list, version detail and its sections
- **Speed:** the only slow page was the assistant with a question (`/assistant?q=What should I work on next?`): 11.3 s on production, 10.5 s on the sandbox. This is a live Claude call. The other pages loaded in 0.7–1.9 s on production.
- **Claude key:** extraction (8.8 s) and assistant (8.5 s) times in the sandbox suggest real Claude calls, not the fallback. The harness doesn't report which path ran, so this is an inference.
- **Not covered:**
  - Audit paging (Older → / ← Newer) was skipped in the sandbox because it has fewer than 500 desk events. On production the crawl opened an `/audit?before=` page, which covers the paged view read-only.
  - Never-worked workbenches on production (UAT-O1).
  - Actually clearing a referral (UAT-O2).
  - On production, every write is checked as a dry run only: the button is wired up and stopped. That is by design.

## Functions checked
| Area | Function | Sandbox | Production |
|------|----------|---------|------------|
| Sign-in | wrong password refused, user ID kept; return to requested page; sign out (GET only asks); sign-in shows in Admin → Sign-ins | Pass | Signed-out checks pass (redirect to sign-in, API 401 with JSON and Basic challenge, wrong Basic password refused); sign-out dry run stopped |
| Intake | extract from inbox (console runs, opens review); picked-up file leaves inbox; correct, save, accept; source docs open; upload two files into one submission; no-insured accept refused with values kept; empty upload refused; stage filters | Pass | Extract dry run stopped; submission pages and source PDFs pass |
| Workbench | open unrated; field error kept under the field; Save & rate with schedule credit; credit without reason refused; clear referrals (0 present, UAT-O2) | Pass | Workbench pages render; Save & rate dry run stopped |
| Quote | issue numbered quote with PDF; change terms, drift named, v2 supersedes v1; Bind offered from quote | Pass | Quote pages and PDFs pass |
| Bind | cancel does nothing; bind gives policy and binder numbers, PDFs, frozen worksheet; policy page complete; customer record links | Pass | Bind confirmation, then request stopped |
| Accounting | balanced new-business journal; UW action → audit; every period and type filter; push to GL as CSV with batch; re-push says nothing new; Excel and JSON exports (UAT-F1/F2 fixes confirmed) | Pass | Accounting periods and batches render; GL push dry run stopped |
| GL API | front door, OpenAPI 3.1, summaries for all 7 periods plus custom range, bad period 400, postings JSON/CSV/XLSX balanced, periods/batches/accounts, bad journal 400/404 | (canary pass) | Pass |
| MCP | handshake, tool list, resources, every read tool; console handshake; gl_push asks first and cancelling sends nothing | Pass | Pass (gl_push refused by the guard before sending) |
| Renewal | cancel start; start from expiring terms; re-rate and compare; Re-rate on comparison page; renewal quote with memo; bind renewal, expiring shows renewed; prior-system policy renews | Pass | Renewal comparison and memos pass |
| Desk and lists | KPI tiles and their lists; book and filters; header search (exact policy number jumps to the policy); quotes and policies filters; customers; audit filters and case history; sign-ins report and downloads; styled 404 | Pass (audit paging skipped) | Pass (crawl, search, sign-in report JSON/CSV/MD) |
| AI assistant | answers with links into the app; desk Ask box hands off | Pass | Pass |
| Rate admin | versions list; create draft; duplicate label refused; every section opens; edit class rate with reason, zero refused; activate with difference shown | Pass | Pages render; create-draft dry run stopped |
| System | health (every component up), liveness | Pass | Pass |

Artifacts are in `/Users/djsiry/GitHub/underwriting-desktop/uat/.work/`:
- `summary.md`
- `results-sandbox.json`, `results-canary.json`, `results-prod.json`
- `crawl-canary.json`, `crawl-prod.json`
- `blocked-canary.jsonl`, `blocked-prod.jsonl`
- `canary.diff`
- `run-sandbox.log`, `run-canary.log`, `run-prod.log`
