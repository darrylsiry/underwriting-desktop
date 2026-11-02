import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOFING_CLASSES, clearanceStatus, isOpenLoss, lossRunYears, referralFlags, type ReferralContext } from "./referrals.ts";
import { formsFor } from "./quote-terms.ts";
import { inputsHash, parseSchedule, scheduleKey, scheduleMod } from "./worksheet.ts";
import type { SubmissionData } from "./submission.ts";

const inputs = {
  class_code: "92215", gross_receipts: 6_800_000, states: ["TX"], home_state: "TX",
  occurrence_limit: 1_000_000, aggregate_limit: 2_000_000, deductible: 5000, residential_pct: 0,
  subcontracted_pct: 10, subcontractor_coi_required: true, max_height_ft: 30, experience_mod: 1,
};

function ctx(overrides: Partial<ReferralContext> = {}): ReferralContext {
  const data = {
    applicant: { years_in_business: 14 }, operations: {}, policy: {}, producer: {}, prior: {},
    loss_history: [{ date: "2024-03-18", description: "Trip", incurred: 8200, status: "Closed" }],
  } as unknown as SubmissionData;
  return {
    data, correctedFields: [], inputs, schedule: [],
    extraction: { fields: {}, documents: [{ filename: "lr.pdf", doc_type: "loss_run", parent: null, method: "claude" }] },
    ...overrides,
  };
}

const codes = (c: ReferralContext) => referralFlags(c).map((f) => `${f.severity}:${f.code}`);

test("a clean commercial electrician has no flags", () => {
  assert.deepEqual(codes(ctx()), []);
});

test("roofing with losses, uninsured subs and FL", () => {
  const c = ctx({
    inputs: { ...inputs, class_code: "98677", subcontracted_pct: 45, subcontractor_coi_required: false },
    data: { ...ctx().data, loss_history: [
      { date: "2023-01-01", description: "a", incurred: 20000, status: "Closed" },
      { date: "2024-01-01", description: "b", incurred: 150000, status: "Open" },
      { date: "2025-01-01", description: "c", incurred: 5000, status: "Closed" },
    ] } as SubmissionData,
  });
  assert.deepEqual(codes(c), ["refer:LARGE_OPEN_CLAIM", "refer:LOSS_FREQUENCY", "refer:UNINSURED_SUBS", "refer:ROOFING"]);
});

test("NY, height, receipts and limits each refer", () => {
  const c = ctx({ inputs: { ...inputs, states: ["NY", "NJ"], max_height_ft: 85, gross_receipts: 18_500_000, occurrence_limit: 2_000_000, subcontracted_pct: 75 } });
  assert.deepEqual(codes(c), ["warn:HEAVY_SUBCONTRACTING", "refer:NY_LABOR_LAW", "refer:HEIGHT", "refer:LARGE_ACCOUNT", "refer:HIGH_LIMITS"]);
});

test("schedule beyond ±15% needs authority", () => {
  const schedule = [{ category: "safety", pct: -10, rationale: "x" }, { category: "management", pct: -6, rationale: "y" }];
  assert.deepEqual(codes(ctx({ schedule })), ["refer:SCHEDULE_AUTHORITY"]);
  assert.deepEqual(codes(ctx({ schedule: schedule.slice(0, 1) })), []);
});

test("inferred class and missing loss runs warn", () => {
  const c = ctx({
    inputs: { ...inputs, class_code: "98304" },
    extraction: {
      fields: { "operations.class_code": { value: "98304", confidence: 0.85, method: "claude", basis: "inferred", source_document: "a.eml", snippet: "residential painting" } },
      documents: [{ filename: "a.eml", doc_type: "broker_email", parent: null, method: "claude" }],
    },
  });
  assert.deepEqual(codes(c), ["warn:CLASS_INFERRED", "warn:NO_LOSS_RUNS"]);
  assert.match(referralFlags(c)[0].detail, /^Class 98304 was inferred/);
  assert.deepEqual(codes({ ...c, correctedFields: ["operations.class_code"] }), ["warn:NO_LOSS_RUNS"]);
  // Changed on the workbench instead: the inferred class is gone, so the warning about it is too (CR-055).
  assert.deepEqual(codes({ ...c, inputs: { ...inputs, class_code: "91342" } }), ["warn:NO_LOSS_RUNS"]);
});

test("loss runs are requested whatever the tenure, sized to it (CR-062)", () => {
  const noLossRun = { fields: {}, documents: [{ filename: "a.eml", doc_type: "broker_email", parent: null, method: "claude" }] };
  const unknown = ctx({ extraction: noLossRun, data: { ...ctx().data, applicant: {} } as unknown as SubmissionData });
  assert.deepEqual(codes(unknown), ["warn:NO_LOSS_RUNS"]);
  assert.match(referralFlags(unknown)[0].detail, /request 5 years of/);
  const young = ctx({ extraction: noLossRun, data: { ...ctx().data, applicant: { years_in_business: 2 } } as unknown as SubmissionData });
  assert.deepEqual(codes(young), ["warn:NEW_VENTURE", "warn:NO_LOSS_RUNS"]);
  assert.match(referralFlags(young)[1].detail, /request all 2 years in business of/);
  assert.deepEqual(codes(ctx({ data: { ...ctx().data, applicant: {} } as unknown as SubmissionData })), []);   // a loss run is on file
  assert.equal(lossRunYears(1), "all 1 year in business");
  assert.equal(lossRunYears(14), "5 years");
  assert.equal(lossRunYears(null), "5 years");
});

test("a large claim refers unless its status is recognizably closed (CR-030)", () => {
  for (const status of ["Open", "O", "OPEN-LIT", "Reopened", "Open - suit filed", "Pending", "Claim open", "Contested", "CIP", "", "Subrogation"]) {
    assert.equal(isOpenLoss(status), true, status);
    const c = ctx({ data: { ...ctx().data, loss_history: [{ date: "2024-01-01", description: "b", incurred: 150_000, status }] } as SubmissionData });
    assert.deepEqual(codes(c), ["refer:LARGE_OPEN_CLAIM"], status);
  }
  for (const status of ["Closed", "C", "closed - paid", "CWP", "Settled", "Denied", "Paid"]) {
    assert.equal(isOpenLoss(status), false, status);
    const c = ctx({ data: { ...ctx().data, loss_history: [{ date: "2024-01-01", description: "b", incurred: 150_000, status }] } as SubmissionData });
    assert.deepEqual(codes(c), [], status);
  }
});

test("schedule parsing requires reasons and bounds", () => {
  const ok = parseSchedule({ "schedule.safety.pct": "-5", "schedule.safety.rationale": "Written safety program, weekly toolbox talks" });
  assert.deepEqual(ok, [{ category: "safety", pct: -5, rationale: "Written safety program, weekly toolbox talks" }]);
  assert.equal(scheduleMod(ok), 0.95);
  assert.throws(() => parseSchedule({ "schedule.safety.pct": "-5" }), /write a reason for the credit/);
  assert.throws(() => parseSchedule({ "schedule.safety.pct": "12", "schedule.safety.rationale": "long enough reason" }), /between -10/);
});

test("rating fingerprint ignores object key order (jsonb reorders keys)", () => {
  const shuffled = Object.fromEntries(Object.entries(inputs).reverse()) as typeof inputs;
  assert.equal(inputsHash(shuffled, []), inputsHash(inputs, []));
  assert.notEqual(inputsHash({ ...inputs, deductible: 1000 }, []), inputsHash(inputs, []));
});

test("schedule comparison ignores jsonb key order (CR-001)", () => {
  const parsed = [{ category: "safety", pct: -5, rationale: "Written program" }];
  const fromJsonb = [{ pct: -5, category: "safety", rationale: "Written program" }];
  assert.equal(scheduleKey(fromJsonb), scheduleKey(parsed));
  assert.notEqual(scheduleKey([{ ...parsed[0], pct: -6 }]), scheduleKey(parsed));
});

test("a clearance stops covering a flag whose facts changed (CR-005)", () => {
  const at55 = referralFlags(ctx({ inputs: { ...inputs, max_height_ft: 55 } })).find((f) => f.code === "HEIGHT")!;
  const clearance = { by: "pat", at: "2026-10-23", note: "Window cleaning only, rope access certified", detail: at55.detail };
  assert.equal(clearanceStatus(at55, clearance), "cleared");
  const at120 = referralFlags(ctx({ inputs: { ...inputs, max_height_ft: 120 } })).find((f) => f.code === "HEIGHT")!;
  assert.equal(clearanceStatus(at120, clearance), "stale");
  assert.equal(clearanceStatus(at120, undefined), "open");
});

test("every roofing class refers and gets the endorsement; the wording existing clearances hold is unchanged (CR-061)", () => {
  for (const class_code of ROOFING_CLASSES) {
    assert.deepEqual(codes(ctx({ inputs: { ...inputs, class_code } })), ["refer:ROOFING"]);
    assert.ok(formsFor({ ...inputs, class_code }).some((f) => f.startsWith("Roofing Operations Endorsement")));
  }
  assert.equal(referralFlags(ctx({ inputs: { ...inputs, class_code: "98677" } }))[0].detail, "Roofing (98677) is written only with manager approval");
});
