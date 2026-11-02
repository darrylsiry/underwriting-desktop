import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFilters, changes, display, fromDesktop, fromRateAdmin, fromRating, groupByCorrelation, isSubmissionId, merge, onPage, pageEnd, recordedApart, type TimelineEvent } from "./timeline-merge.ts";

const desktop = (id: number, at: string, correlation: string, action = "submission.field_corrected") => fromDesktop({
  id, occurred_at: new Date(at), actor: "pat", action, entity_type: "submission", entity_id: "s1",
  summary: `${action} ${id}`, before: null, after: null, correlation_id: correlation,
});

test("three sources merge newest first with readable summaries", () => {
  const admin = fromRateAdmin({ id: 7, created_at: "2026-10-23T01:55:00Z", actor: "Darryl", action: "update_factor",
    entity: "territory:FL", version_id: 2, version_label: "2026.2", before: { value: "1.2500" }, after: { value: "1.35" }, reason: "FL trend" });
  const rating = fromRating({ id: "r1", created_at: "2026-10-23T03:03:00Z", requested_by: "underwriter", reference: "Q-2026-0001 v1",
    rate_version: "2026.2", class_code: "98304", premium: "5359", total: "5777" });
  const events = merge([desktop(1, "2026-10-23T02:00:00Z", "c1")], [admin], [rating]);
  assert.deepEqual(events.map((e) => e.source), ["rating", "desktop", "rate_admin"]);
  assert.equal(admin.summary, "Rates 2026.2: update factor territory:FL (FL trend)");
  assert.equal(rating.summary, "Rated Q-2026-0001 v1 on 2026.2: $5,359 premium, $5,777 total (class 98304)");
});

test("field-level changes", () => {
  assert.deepEqual(changes({ "applicant.fein": "" }, { "applicant.fein": "86-1" }), [{ field: "applicant.fein", before: "", after: "86-1" }]);
  assert.deepEqual(changes(null, { status: "bound", total: "5665" }).map((c) => c.field), ["status", "total"]);
  assert.deepEqual(changes({ a: 1, b: 2 }, { a: 1, b: 2 }), []);
  assert.deepEqual(changes([{ pct: -5 }], [{ pct: -6 }]), [{ field: "", before: [{ pct: -5 }], after: [{ pct: -6 }] }]);
});

test("events from one click group together", () => {
  const groups = groupByCorrelation([
    desktop(3, "2026-10-23T02:00:02Z", "c2"), desktop(2, "2026-10-23T02:00:01Z", "c2"), desktop(1, "2026-10-23T02:00:00Z", "c1"),
  ]);
  assert.deepEqual(groups.map((g) => g.events.length), [2, 1]);
});

test("filters", () => {
  const events = [desktop(1, "2026-10-22T10:00:00Z", "c1"), desktop(2, "2026-10-23T10:00:00Z", "c2", "quote.issued")];
  assert.equal(applyFilters(events, { q: "QUOTE" }).length, 1);
  assert.equal(applyFilters(events, { from: "2026-10-23" }).length, 1);
  assert.equal(applyFilters(events, { source: "rating" }).length, 0);
  assert.equal(applyFilters(events, { actor: "PAT" }).length, 2);
});

test("a rating call between two events of one Save & rate joins that action", () => {
  const call = fromRating({ id: "r9", created_at: "2026-10-23T02:00:01.500Z", requested_by: "pat", reference: "SUB-0003",
    rate_version: "2026.2", class_code: null, premium: "1", total: "1" });
  const groups = groupByCorrelation([desktop(5, "2026-10-23T02:00:02Z", "c3", "worksheet.rated"), call, desktop(4, "2026-10-23T02:00:01Z", "c3")]);
  assert.deepEqual(groups.map((g) => g.events.length), [3]);
  const lonely = fromRating({ id: "r8", created_at: "2026-10-23T05:00:00Z", requested_by: "pat", reference: "x",
    rate_version: "v", class_code: null, premium: "1", total: "1" });
  assert.equal(groupByCorrelation([lonely, desktop(1, "2026-10-23T02:00:00Z", "c1")]).length, 2);
});

test("schedules display compactly", () => {
  assert.equal(display([{ pct: 8, category: "subcontractor_controls", rationale: "x" }, { pct: -5, category: "safety", rationale: "y" }]),
    "subcontractor_controls +8%, safety -5%");
  assert.equal(display([{ text: "Signed app", status: "received", due_date: null }, { text: "Loss runs", status: "open", due_date: "2026-11-22" }]),
    "Signed app: received; Loss runs: open (due Nov 22, 2026)");
  assert.equal(display([]), "none");
  assert.equal(display(null), "—");
});

// UX-006: the day filters use the display zone, so an event shown as "Oct 31, 11:30 PM EDT" is an Oct 31 event.
test("from/to bucket days in the display zone, not UTC", () => {
  const lateOct31Eastern = [desktop(1, "2026-11-01T03:30:00Z", "c1")];
  assert.equal(applyFilters(lateOct31Eastern, { from: "2026-10-31", to: "2026-10-31" }, "America/New_York").length, 1);
  assert.equal(applyFilters(lateOct31Eastern, { from: "2026-11-01" }, "America/New_York").length, 0);
  assert.equal(applyFilters(lateOct31Eastern, { from: "2026-11-01" }, "UTC").length, 1);
});

test("only a whole uuid is looked up as a submission (CR-018)", () => {
  assert.equal(isSubmissionId("0f8fad5b-d9cb-469f-a165-70867728950e"), true);
  for (const bad of ["junk", "", "-".repeat(36), "0f8fad5b-d9cb-469f-a165-70867728950"]) assert.equal(isSubmissionId(bad), false, bad);
});

// CR-095: walk a timeline page by page, each source returning its newest LIMIT rows under the cursor, as the queries do.
const rated = (i: number, at: number): TimelineEvent => fromRating({ id: `r${i}`, created_at: new Date(at).toISOString(), requested_by: "pat", reference: null, rate_version: "1", class_code: null, premium: null, total: null });
const desk = (i: number, at: number): TimelineEvent => fromDesktop({ id: i, occurred_at: new Date(at), actor: "pat", action: "a", entity_type: "quote", entity_id: "q", summary: "", before: null, after: null, correlation_id: "c" });

function walk(all: { label: string; events: TimelineEvent[] }[], limit: number) {
  const pages: { keys: string[]; cappedBy: string[] }[] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const top = before;
    const sources = all.map((s) => ({
      label: s.label,
      events: s.events.filter((e) => !top || Date.parse(e.at) < Date.parse(top)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit),
    }));
    const { cappedBy, cursor } = pageEnd(sources, limit, before);
    pages.push({ keys: onPage(sources.flatMap((s) => s.events), cursor, before).map((e) => e.key), cappedBy });
    if (!cursor) return pages;
    before = cursor;
  }
  throw new Error("paging did not finish");
}

test("paging: no row repeats and none falls between pages, whichever source hits the cap (CR-095)", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const minutes = (n: number) => start + n * 60_000;
  const all = [
    // The rating engine is busy and recent; the desk is sparse and reaches much further back.
    { label: "Rating engine", events: Array.from({ length: 23 }, (_, i) => rated(i, minutes(1000 + i))) },
    { label: "UW Desktop", events: [desk(1, minutes(1010)), desk(2, minutes(300)), desk(3, minutes(200)), desk(4, minutes(100))] },
  ];
  const pages = walk(all, 5);
  const keys = pages.flatMap((p) => p.keys);
  assert.equal(new Set(keys).size, keys.length, "a row repeated across pages");
  assert.deepEqual([...keys].sort(), all.flatMap((s) => s.events.map((e) => e.key)).sort(), "a row was lost between pages");
  assert.deepEqual(pages[0].cappedBy, ["Rating engine"], "the notice names the source that hit the cap");
  assert.equal(pages.at(-1)?.cappedBy.length, 0);
});

test("paging: rows sharing the cut's exact time stay together on the next page (CR-095)", () => {
  const t = Date.parse("2026-03-01T12:00:00Z");
  const all = [{ label: "UW Desktop", events: [desk(1, t + 2000), desk(2, t + 1000), desk(3, t), desk(4, t), desk(5, t), desk(6, t - 1000)] }];
  const pages = walk(all, 3);
  const keys = pages.flatMap((p) => p.keys);
  assert.equal(new Set(keys).size, 6);
  assert.equal(keys.length, 6);
  const page = (key: string) => pages.findIndex((p) => p.keys.includes(key));
  assert.equal(page("d-3"), page("d-4"));
  assert.equal(page("d-4"), page("d-5"));
});

test("paging: a page that all shares one instant still moves on (CR-095)", () => {
  const t = Date.parse("2026-03-01T12:00:00Z");
  const pages = walk([{ label: "UW Desktop", events: [desk(1, t), desk(2, t), desk(3, t), desk(4, t - 1000)] }], 3);
  assert.deepEqual(pages.flatMap((p) => p.keys).sort(), ["d-1", "d-2", "d-3", "d-4"]);
});

test("a page under the cap in every source is the last, and cuts nothing (CR-095)", () => {
  const events = [desk(1, Date.parse("2026-01-01T00:00:00Z")), desk(2, Date.parse("2026-02-01T00:00:00Z"))];
  assert.deepEqual(pageEnd([{ label: "UW Desktop", events }, { label: "Rating engine", events: [] }], 500), { cappedBy: [], cursor: null });
  assert.equal(onPage(events, null, null).length, 2);
});

test("a back-dated row shows when it was really written; a live row or an older one doesn't (CR-074)", () => {
  const row = { id: 1, occurred_at: new Date("2026-03-30T18:13:00Z"), actor: "pat", action: "policy.bound", entity_type: "policy", entity_id: "p1", summary: "bound", before: null, after: null, correlation_id: "c1" };
  assert.equal(fromDesktop({ ...row, recorded_at: new Date("2026-11-02T15:00:00Z") }).recordedAt, "2026-11-02T15:00:00.000Z");
  assert.ok(!("recordedAt" in fromDesktop({ ...row, recorded_at: row.occurred_at })), "written when it happened");
  assert.ok(!("recordedAt" in fromDesktop({ ...row, recorded_at: new Date("2026-03-30T18:13:30Z") })), "seconds apart isn't back-dating");
  assert.ok(!("recordedAt" in fromDesktop({ ...row, recorded_at: null })), "written before the column existed");
  assert.ok(!("recordedAt" in fromDesktop(row)));
  const rating = { id: "r1", created_at: "2026-03-30T18:13:00Z", requested_by: "pat", reference: "SUB-1", rate_version: "2026.1", class_code: null, premium: "1", total: "2" };
  assert.equal(fromRating({ ...rating, recorded_at: "2026-11-02T15:00:00Z" }).recordedAt, "2026-11-02T15:00:00.000Z");
  assert.ok(!("recordedAt" in fromRating({ ...rating, recorded_at: "2026-03-30T18:13:00Z" })));
  assert.equal(recordedApart("2026-03-30T18:13:00Z", "2026-03-30T18:14:01Z"), "2026-03-30T18:14:01.000Z");
  assert.equal(recordedApart("2026-03-30T18:13:00Z", null), undefined);
});
