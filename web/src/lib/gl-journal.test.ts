import assert from "node:assert/strict";
import { test } from "node:test";
import { accountingPeriod, bindJournal, glDate, isBalanced, presetRange } from "./gl-journal.ts";

test("a bound policy books a balanced journal: receivable against premium, fee and tax", () => {
  const lines = bindJournal({ premium: "37481", policy_fee: "250", surplus_lines_tax: "1132", total: "38863" });
  assert.deepEqual(lines.map((l) => [l.line_no, l.account_code, l.debit, l.credit]), [
    [1, "1200", 38863, 0], [2, "4100", 0, 37481], [3, "4200", 0, 250], [4, "2300", 0, 1132],
  ]);
  assert.ok(isBalanced(lines));
});

test("zero amounts don't make lines, and lines renumber", () => {
  const lines = bindJournal({ premium: 5000, policy_fee: 0, surplus_lines_tax: 150, total: 5150 });
  assert.deepEqual(lines.map((l) => [l.line_no, l.account_code]), [[1, "1200"], [2, "4100"], [3, "2300"]]);
});

test("amounts that don't add up are refused", () => {
  assert.throws(() => bindJournal({ premium: 100, policy_fee: 10, surplus_lines_tax: 5, total: 120 }), /don't add up/);
});

test("accounting period follows the books' time zone, not UTC", () => {
  const lateEvening = new Date("2026-11-01T03:30:00Z");   // 11:30 pm Oct 31 in New York
  assert.equal(accountingPeriod(lateEvening), "2026-10");
  assert.equal(glDate(lateEvening), "2026-10-31");
  assert.equal(accountingPeriod(lateEvening, "UTC"), "2026-11");
});

test("period presets", () => {
  const today = "2026-10-30";
  assert.deepEqual(presetRange("this_month", today), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(presetRange("last_month", today), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("this_quarter", today), { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(presetRange("last_quarter", today), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("ytd", today), { from: "2026-01-01", to: "2026-10-30" });
  assert.deepEqual(presetRange("last_12", today), { from: "2025-11-01", to: "2026-10-31" });
  assert.deepEqual(presetRange("all", today), { from: null, to: null });
  assert.deepEqual(presetRange("custom", today, { from: "2026-02-01", to: "" }), { from: "2026-02-01", to: null });
  // Year boundaries and February.
  assert.deepEqual(presetRange("last_month", "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("last_quarter", "2026-02-10"), { from: "2025-10-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("this_month", "2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
});
