import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOFING_CLASSES, clearanceAudit, clearanceStatus, isOpenLoss, lossRunYears, referralFlags, type ReferralContext } from "./referrals.ts";
import { formsFor, suggestedSubjectivities } from "./quote-terms.ts";
import { changes } from "./timeline-merge.ts";
import { inputsFromSubmission, inputsHash, parseSchedule, scheduleKey, scheduleMod } from "./worksheet.ts";
import type { SubmissionData } from "./submission.ts";

const inputs = {
  class_code: "92215", gross_receipts: 6_800_000, states: ["TX"], home_state: "TX",
  occurrence_limit: 1_000_000, aggregate_limit: 2_000_000, deductible: 5000, residential_pct: 0,
  subcontracted_pct: 10, subcontractor_coi_required: true, max_height_ft: 30, experience_mod: 1,
};

function ctx(overrides: Partial<ReferralContext> = {}): ReferralContext {
  const data = {
    applicant: { years_in_business: 14 }, policy: {}, producer: {}, prior: {},
    operations: { max_height_ft: 30, subcontracted_pct: 10, residential_pct: 0, subcontractor_coi_required: true },
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

test("on a bound file any clearance counts; only a flag never cleared is since bind (CR-138)", () => {
  const flag = { code: "HEIGHT", severity: "refer" as const, title: "Work at height", detail: "Maximum working height 85 ft (limit 50 ft)" };
  const later = { by: "pat", at: "2026-11-02T00:00:00Z", note: "Cleared again at the new height", detail: "Maximum working height 95 ft (limit 50 ft)" };
  assert.equal(clearanceStatus(flag, later), "stale");
  assert.equal(clearanceStatus(flag, later, true), "cleared");
  assert.equal(clearanceStatus(flag, undefined, true), "open");
});

test("a loss run nobody read is not a loss run on file (CR-147)", () => {
  const unread = ctx({ extraction: { fields: {}, documents: [{ filename: "losses.pdf", doc_type: "loss_run" as const, parent: null, method: "not_read" as const }] } });
  assert.deepEqual(codes(unread), ["warn:NO_LOSS_RUNS"]);
  const flag = referralFlags(unread)[0];
  assert.equal(flag.title, "Loss run not read");
  assert.match(flag.detail, /^losses\.pdf was not read/);
  assert.match(suggestedSubjectivities(referralFlags(unread), unread.data).join(" | "), /loss runs/);
  // Stored before the method existed: it was read.
  const older = ctx({ extraction: { fields: {}, documents: [{ filename: "losses.pdf", doc_type: "loss_run", parent: null } as never] } });
  assert.deepEqual(codes(older), []);
});

test("loss runs are requested whatever the tenure, sized to it (CR-062)", () => {
  const noLossRun = { fields: {}, documents: [{ filename: "a.eml", doc_type: "broker_email" as const, parent: null, method: "claude" as const }] };
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

test("inputs the broker never stated warn, name themselves and suggest a subjectivity, without blocking the quote (CR-112)", () => {
  const stated = { class_code: "98304", gross_receipts: 900_000, states: ["AZ"], residential_pct: 100, max_height_ft: null, subcontracted_pct: null, subcontractor_coi_required: null };
  const data = { ...ctx().data, operations: stated, policy: { occurrence_limit: 1_000_000, aggregate_limit: 2_000_000 }, applicant: { state: "AZ", years_in_business: 14 } } as unknown as SubmissionData;
  const c = ctx({ data, inputs: inputsFromSubmission(data) });
  assert.deepEqual(codes(c), ["warn:ASSUMED_INPUTS"]);
  const flag = referralFlags(c)[0];
  assert.match(flag.detail, /max height 0 ft, subcontracted 0%, COIs required from subs/);
  assert.doesNotMatch(flag.detail, /residential/);   // the broker stated that one
  assert.ok(suggestedSubjectivities([flag], data).includes("Confirmation of working height, subcontracted share and subcontractor certificates"));
  // A real value on the worksheet drops that input from the list, and the warning goes once none are left.
  const height = referralFlags({ ...c, inputs: { ...c.inputs, max_height_ft: 30 } })[0];
  assert.doesNotMatch(height.detail, /max height/);
  assert.deepEqual(codes({ ...c, inputs: { ...c.inputs, max_height_ft: 30, subcontracted_pct: 10, subcontractor_coi_required: false } }), []);
});

test("a renewal with only the expiring policy's claim totals still refers (CR-101)", () => {
  const none = { ...ctx().data, loss_history: [] } as unknown as SubmissionData;
  const c = ctx({ data: none, expiringLosses: { claims: 3, incurred: 3400, open_claims: 0 } });
  assert.deepEqual(codes(c), ["refer:LOSS_FREQUENCY"]);
  assert.equal(referralFlags(c)[0].detail, "3 claims on the expiring policy, $3,400 incurred");
  assert.deepEqual(codes(ctx({ data: none, expiringLosses: { claims: 2, incurred: 3400, open_claims: 0 } })), []);
  const open = ctx({ data: none, expiringLosses: { claims: 1, incurred: 9000, open_claims: 1 } });
  assert.deepEqual(codes(open), ["refer:OPEN_CLAIMS_NO_DETAIL"]);
  assert.ok(suggestedSubjectivities(referralFlags(open), none).includes("Current adjuster's status report on open claims"));
});

test("a renewal whose loss rows match its totals keeps the wording its clearances were given for (CR-101)", () => {
  const losses = [
    { date: "2023-01-01", description: "a", incurred: 20000, status: "Closed" },
    { date: "2024-01-01", description: "b", incurred: 5000, status: "Open" },
    { date: "2025-01-01", description: "c", incurred: 5000, status: "Closed" },
  ];
  const data = { ...ctx().data, loss_history: losses } as SubmissionData;
  const before = referralFlags(ctx({ data }));
  const after = referralFlags(ctx({ data, expiringLosses: { claims: 3, incurred: 30000, open_claims: 1 } }));
  assert.deepEqual(after, before);
  assert.equal(after[0].detail, "3 claims in the loss history, $30,000 incurred");
  assert.equal(clearanceStatus(after[0], { by: "pat", at: "2026-10-23", note: "Reviewed with the manager", detail: before[0].detail }), "cleared");
});

test("a clearance reads as one change, keyed by the rule code (CR-053)", () => {
  const flag = referralFlags(ctx({ inputs: { ...inputs, max_height_ft: 55 } })).find((f) => f.code === "HEIGHT")!;
  const { before, after } = clearanceAudit(flag, { by: "pat", at: "2026-10-23T12:00:00Z", note: "Rope access certified", detail: flag.detail });
  const diff = changes(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].field, "HEIGHT");
  assert.deepEqual(diff[0].before, { status: "open" });
  assert.deepEqual(diff[0].after, { status: "cleared", by: "pat", note: "Rope access certified", detail: flag.detail });
});

test("an experience credit refers, so it has a reason on file; a debit or none doesn't (CR-161)", () => {
  const withMod = (experience_mod: number) => ctx({ inputs: { ...inputs, experience_mod } });
  assert.ok(codes(withMod(0.8)).includes("refer:EXPERIENCE_MOD"));
  assert.ok(codes(withMod(0.99)).includes("refer:EXPERIENCE_MOD"));
  assert.ok(!codes(withMod(1)).includes("refer:EXPERIENCE_MOD"));
  assert.ok(!codes(withMod(1.1)).includes("refer:EXPERIENCE_MOD"));
  const flag = referralFlags(withMod(0.8)).find((f) => f.code === "EXPERIENCE_MOD")!;
  assert.match(flag.detail, /0\.80.*20% credit/);
});
