import assert from "node:assert/strict";
import { test } from "node:test";
import { stageOf, stageSummary, type StageInput } from "./stage.ts";

// UX-005: one vocabulary for the Received table, the workbench chip and the desk.
const base: StageInput = { status: "accepted", missing: 0, worksheet: null, quote: null, policy: null };

test("stages read from intake to bound", () => {
  assert.deepEqual(stageOf({ ...base, status: "needs_review", missing: 2 }), { key: "review", label: "Needs review (2 missing)", tone: "amber" });
  assert.equal(stageOf({ ...base, status: "needs_review" }).label, "Needs review");
  assert.equal(stageOf(base).label, "Not rated");
  assert.equal(stageOf({ ...base, worksheet: { rated: false, openReferrals: 0 } }).label, "Not rated");
  assert.deepEqual(stageOf({ ...base, worksheet: { rated: true, openReferrals: 3 } }), { key: "referred", label: "3 referrals open", tone: "amber" });
  assert.equal(stageOf({ ...base, worksheet: { rated: false, openReferrals: 1 } }).label, "1 referral open");
  assert.deepEqual(stageOf({ ...base, worksheet: { rated: true, openReferrals: 0 } }), { key: "ready", label: "Ready to quote", tone: "emerald" });
  assert.deepEqual(stageOf({ ...base, worksheet: { rated: true, openReferrals: 0 }, quote: { version: 2, total: "5777.00", status: "issued" } }),
    { key: "quoted", label: "Quoted v2 · $5,777", tone: "indigo" });
  assert.deepEqual(stageOf({ ...base, quote: { version: 2, total: 5777, status: "bound" }, policy: { policy_number: "GL-26-00001" } }),
    { key: "bound", label: "Bound GL-26-00001", tone: "emerald" });
});

test("the count line names what needs attention", () => {
  const stages = [
    stageOf({ ...base, status: "needs_review", missing: 1 }), stageOf({ ...base, status: "needs_review", missing: 0 }),
    stageOf({ ...base, worksheet: { rated: true, openReferrals: 2 } }), stageOf({ ...base, worksheet: { rated: true, openReferrals: 0 } }), stageOf(base),
  ];
  assert.equal(stageSummary(stages), "5 submissions · 2 need review · 1 with referrals open · 1 ready to quote · newest first");
  assert.equal(stageSummary([stageOf(base)]), "1 submission · newest first");
});
