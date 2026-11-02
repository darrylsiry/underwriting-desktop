import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerFileQuery, nothingToPushPath, parseLedgerQuery, pushedAccountingPath, refusedPushPath } from "./gl-query.ts";

// UX-022, CR-127: after a push the page keeps the filter, so the download holds the lines the banner and audit row count.
test("a push that stamped lines names its batch and keeps the filter the file reads back", () => {
  assert.equal(pushedAccountingPath({ period: "this_month", from: "", to: "", type: "", batch: "" }, "GLX-20261031-001", 12, "xlsx"),
    "/accounting?period=this_month&pushed_batch=GLX-20261031-001&pushed=12&format=xlsx");
});

test("a partial push downloads every line it reports, not only the newly stamped ones (CR-127)", () => {
  const path = pushedAccountingPath({ period: "all", batch: "" }, "GLX-20261031-002", 3, "csv");
  const p = Object.fromEntries(new URL(path, "https://x.test").searchParams);
  assert.equal(p.batch, undefined);
  assert.equal(p.pushed_batch, "GLX-20261031-002");
  const { query } = parseLedgerQuery(p, "2026-10-31", "this_month");
  assert.equal(ledgerFileQuery(query, "csv"), "period=all&format=csv");
});

test("a push that stamped nothing keeps the filter it came from", () => {
  assert.equal(pushedAccountingPath({ period: "custom", from: "2026-10-01", to: "2026-10-31", type: "renewal", batch: "GLX-20261030-002" }, "GLX-20261031-003", 0, "csv"),
    "/accounting?period=custom&from=2026-10-01&to=2026-10-31&type=renewal&batch=GLX-20261030-002&pushed=0&format=csv");
});

test("a push with a bad filter is reported, and the bad values don't travel back (CR-139)", () => {
  for (const form of [{ period: "junk" }, { period: "custom", from: "2026-02-31" }]) {
    const { errors } = parseLedgerQuery(form, "2026-11-02", "all");
    assert.notEqual(errors.length, 0);
    const url = new URL(refusedPushPath(form, errors), "https://x.test");
    assert.match(url.searchParams.get("error") ?? "", /^Nothing was pushed: /);
    assert.equal(url.searchParams.get("period"), null);
  }
});

test("a push with nothing to send returns to the same filter with a message (CR-119)", () => {
  const url = new URL(nothingToPushPath({ period: "custom", from: "2020-01-01", to: "2020-01-31", type: "", batch: "" }), "https://x.test");
  assert.equal(url.searchParams.get("from"), "2020-01-01");
  assert.match(url.searchParams.get("msg") ?? "", /Nothing to push/);
  assert.equal(url.searchParams.get("pushed"), null);
});

test("the file link keeps what the push was filtered by (CR-114)", () => {
  const f = { from: null, to: null, type: "" as const, batch: "" };
  assert.equal(ledgerFileQuery(f, "json"), "period=all&format=json");
  assert.equal(ledgerFileQuery({ ...f, batch: "GLX-20261030-004" }, "csv"), "period=all&batch=GLX-20261030-004&format=csv");
  assert.equal(ledgerFileQuery({ ...f, from: "2026-03-01", to: "2026-03-31", type: "renewal" }, "xlsx"), "from=2026-03-01&to=2026-03-31&type=renewal&format=xlsx");
  assert.equal(ledgerFileQuery(f, "json", { download: true }), "period=all&format=json&download=1");
  // Read back through the API's own parser, the link lands on the same range.
  const { query } = parseLedgerQuery(Object.fromEntries(new URLSearchParams(ledgerFileQuery(f, "json"))), "2026-11-02", "this_month");
  assert.equal(query.period, "all");
  assert.equal(query.from, null);
});

test("inherited names are not transaction types (CR-107)", () => {
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const { query, errors } = parseLedgerQuery({ type }, "2026-11-02");
    assert.equal(query.type, "", type);
    assert.match(errors.join(), /type must be one of/, type);
  }
  assert.equal(parseLedgerQuery({ type: "renewal" }, "2026-11-02").query.type, "renewal");
});

test("a date that isn't on the calendar is an error, not a 500 at the Postgres cast (CR-068)", () => {
  const { query, errors } = parseLedgerQuery({ from: "2026-02-30" }, "2026-11-02");
  assert.match(errors.join(), /from must be a date/);
  assert.equal(query.from, null);
});

test("bare from and to mean a custom range, which is what the summary's month links send (CR-086)", () => {
  const { query } = parseLedgerQuery({ from: "2026-03-01", to: "2026-03-31" }, "2026-11-02", "this_month");
  assert.equal(query.period, "custom");
  assert.equal(query.from, "2026-03-01");
  assert.equal(query.to, "2026-03-31");
});
