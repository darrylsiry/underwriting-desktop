# UAT report: Underwriting Desktop

Run: 2026-10-31 21:28 EDT · code a26098c (same as origin/main) · live site https://uwdesk-web.fly.dev

## Verdict
Most of the app works end to end in the sandbox: 57 of 60 flows passed, covering intake, rating, quote, bind, renewal, desk, audit, API, MCP, the assistant and rate admin. Two Accounting export defects fail, and they ship on the live site too because the code is identical. The production pass only ran its 5 signed-out checks because no `uat` login exists, so the signed-in live site was not tested.

## Summary
| Pass | What it covers | Passed | Failed | Skipped | Result |
|------|----------------|--------|--------|---------|--------|
| Sandbox flows | every function end to end, writes included, on a disposable copy | 57 | 2 | 1 | FAIL |
| Canary | the read-only suite on the sandbox, data compared before and after | 33 | 0 | 0 | PASS |
| Production | every page, download, API and MCP read on the live site, writes blocked | 5 | 0 | 0 | PASS (signed-out checks only) |

## Production safety
- Writes stopped by the guard on the live site: 0. No `blocked-prod.jsonl` was written, because the signed-out pass never reaches a write control. On the sandbox canary the guard stopped 6 writes, all from the intended dry-run tests: Save & rate, Bind (after its confirmation), Extract from inbox, Push to the GL, Create rate-table draft, and Sign out. No page tried to write just by being opened.
- Canary: no table changed. `policy.login_events` went from 6 to 8, which are the expected API sign-in rows.
- Login used on production: none (signed-out checks only). The harness found no `uat` login; `scripts/fly-users.sh uat` would add one, but that is for Darryl to run.

## Failures
### UAT-F1 "Nothing new to push" on All periods downloads only this month's lines (App defect)
- **Where:** Accounting, `/accounting?period=all` → Export CSV / Excel / JSON when every line shown has already been pushed. The banner's "Download .csv" link and the automatic download both point at `/api/gl/postings?format=csv`.
- **What a user sees:** The page shows All periods and says "every line in the file had been pushed in an earlier batch; the file shows which". The file they get holds only the current month's journals, not the selection on screen.
- **Evidence:** `tests/sandbox/30-accounting.spec.ts:54`: expected `/period=all|gl-subledger-all/`, received `http://127.0.0.1:3900/api/gl/postings?format=csv`. Screenshot: `/Users/djsiry/GitHub/underwriting-desktop/uat/.work/artifacts-sandbox/30-accounting-accounting-e-a2d0b-me-selection-the-page-shows/test-failed-1.png`
- **Likely cause:** `web/src/app/accounting/page.tsx:48` builds `fileQs` from `filter.from` and `filter.to` only. For All periods both are null, so the query carries no period. `ledgerQuery` (`web/src/lib/gl-http.ts:21`) then falls back to `this_month` whenever there is no batch. A fresh push is not affected because it adds `batch=…`, and every other preset is not affected because it sets from/to.
- **Suggested fix:** Add `period: preset` to `fileQs` in `page.tsx:48`. For a custom range it could be added only when from/to are absent. The file stem then becomes `gl-subledger-all-…` as the test expects.

### UAT-F2 Export JSON sends the browser to raw JSON and saves no file (App defect)
- **Where:** Accounting → Export JSON (and the banner's "Download .json" link), which lands on `/api/gl/postings?…&format=json`.
- **What a user sees:** The push still happens and lines are stamped. Then the tab leaves the app and shows the raw JSON document, and no download is saved.
- **Evidence:** `tests/sandbox/30-accounting.spec.ts:70`: expected the URL to contain `/accounting`, received `http://127.0.0.1:3900/api/gl/postings?format=json`, and no download event fired within 20 s. Screenshot: `/Users/djsiry/GitHub/underwriting-desktop/uat/.work/artifacts-sandbox/30-accounting-accounting-e-16da9-he-user-stays-on-Accounting/test-failed-1.png`
- **Likely cause:** `web/src/components/auto-download.tsx` calls `window.location.assign(href)`, which depends on the server sending `Content-Disposition: attachment`. `web/src/app/api/gl/postings/route.ts:11` answers JSON through `jsonResponse` (`gl-http.ts:26`), which sets no Content-Disposition. CSV and Excel go through `fileResponse`, which does.
- **Suggested fix:** Pick one of two:
  - Have the page add `download=1` to `fileHref`, and have the postings route answer `format=json&download=1` with `Content-Disposition: attachment; filename=gl-subledger-….json`. This keeps the plain API response unchanged.
  - Or have AutoDownload click a temporary `<a download>` element instead of `location.assign`, and add `download` to the banner link.

## Coverage
- **Sandbox (built from a26098c, then wiped):** sign-in, wrong password, return-to and sign-out; inbox pickup with the extraction console; intake review (correct, save, accept, refusals); document upload (two files become one submission, empty upload refused); source document files; workbench (validation, Save & rate, schedule credit with reason, referrals cleared); quote issue with PDF and a v2 revision; bind cancel and bind (policy and binder PDFs, worksheet frozen); policy and customer pages; Accounting journals, UW action link, every period and type filter, push to GL as CSV, re-push, Excel and JSON exports; renewal start, re-rate, comparison, quote and bind, including a prior-system policy; desk KPIs and tile lists; book, quotes and policies filters; header search; customers; audit trail with filters and case history; sign-ins report and downloads; 404 page; API docs and Try it; MCP console handshake and tools, plus gl_push cancel; AI assistant and the desk Ask box; rate tables (versions, draft copy, duplicate label refused).
- **Skipped:** audit paging (Older → / ← Newer). The sandbox has fewer than 500 desk events, so there is no second page. This is expected, not a defect.
- **Canary (read-only suite on the sandbox):** GL API (summaries for every preset, custom range, a 400 on a bad period, postings as JSON/CSV/Excel, periods, batches, chart of accounts, journal 400/404); health; sign-in report as JSON/CSV/Markdown; MCP handshake, tools, resources and every read-only tool; guard refuses gl_push; the crawl visited 50 pages and fetched 7 files with 0 failures; dry-run write buttons; MCP console; AI assistant; search.
- **Production:** only the 5 signed-out checks ran: liveness, sign-in form shown and not submitted, protected page redirects to sign-in, API with no login refused with JSON and a Basic challenge, wrong Basic password refused. No signed-in page, download, API or MCP read was checked on the live site.
- **Not verified:** the working tree had uncommitted changes, but only to docs and untracked UAT files, so the sandbox app code matches a26098c. There was no recheck of the two failures because the harness wipes the sandbox; both were confirmed by reading the source, which explains each one deterministically.

## Functions checked
| Area | Function | Sandbox | Production |
|------|----------|---------|------------|
| Sign-in | wrong password, return-to, sign-out, sign-ins report | Pass | Signed-out checks pass |
| Intake | inbox pickup and extraction, review, accept, upload, refusals, documents | Pass | Not run (no login) |
| Workbench | validation, Save & rate, credits, referrals | Pass | Not run |
| Quote / bind | issue, revise, bind, PDFs, policy and customer pages | Pass | Not run |
| Accounting | journals, filters, UW action link, first push (CSV), Excel export | Pass | Not run |
| Accounting | re-push download on All periods | **Fail (UAT-F1)** | Not run (same code is live) |
| Accounting | Export JSON | **Fail (UAT-F2)** | Not run (same code is live) |
| Renewal | start, re-rate, compare, quote, bind, prior-system policy | Pass | Not run |
| Desk / lists | KPIs, tiles, book, quotes, policies, customers, search | Pass | Not run |
| Audit | filters, date range, case history | Pass | Not run |
| Audit | paging | Skipped (under 500 events) | Not run |
| API | GL REST endpoints, OpenAPI, auth refusals | Pass (canary) | Auth refusals pass |
| MCP | handshake, read tools, gl_push guarded or cancelled | Pass | Not run |
| AI assistant | answers with links, desk Ask box | Pass | Not run |
| Rate admin | versions, draft, duplicate refused | Pass | Not run |
