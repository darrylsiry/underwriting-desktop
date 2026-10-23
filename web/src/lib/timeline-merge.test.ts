import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFilters, changes, display, fromDesktop, fromRateAdmin, fromRating, groupByCorrelation, merge } from "./timeline-merge.ts";

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
    "Signed app: received; Loss runs: open (due 2026-11-22)");
  assert.equal(display([]), "none");
  assert.equal(display(null), "—");
});
