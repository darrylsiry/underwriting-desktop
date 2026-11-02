import assert from "node:assert/strict";
import { test } from "node:test";
import { inputText } from "./renewal-compare.ts";
import { FieldError, inputChanges, inputUnit, INPUT_DEFS, parseInputs, parseSchedule, worksheetChips, type RatingInputs } from "./worksheet.ts";

const form = {
  class_code: "98677", gross_receipts: "$2,300,000", states: "TX, OK", home_state: "tx",
  occurrence_limit: "1,000,000", aggregate_limit: "$2,000,000", deductible: "2,500", residential_pct: "100%",
  subcontracted_pct: "0", subcontractor_coi_required: "yes", max_height_ft: "45", experience_mod: "1.00",
};

test("formatted money and percent inputs parse to numbers (UX-004)", () => {
  const inputs = parseInputs(form);
  assert.equal(inputs.gross_receipts, 2_300_000);
  assert.equal(inputs.deductible, 2500);
  assert.equal(inputs.residential_pct, 100);
  assert.equal(inputs.experience_mod, 1);
  assert.equal(inputs.home_state, "TX");
  assert.deepEqual(inputs.states, ["TX", "OK"]);
});

test("a bad input names its field (UX-001)", () => {
  assert.throws(() => parseInputs({ ...form, gross_receipts: "2,3o0,000" }), (err: unknown) =>
    err instanceof FieldError && err.field === "gross_receipts" && /"2,3o0,000" is not a number/.test(err.message));
  assert.throws(() => parseSchedule({ "schedule.safety.pct": "-5" }), (err: unknown) =>
    err instanceof FieldError && err.field === "schedule.safety.rationale");
  assert.throws(() => parseSchedule({ "schedule.safety.pct": "-15", "schedule.safety.rationale": "documented toolbox talks" }), (err: unknown) =>
    err instanceof FieldError && err.field === "schedule.safety.pct");
});

test("units follow the input kind", () => {
  const unit = (key: string) => inputUnit(INPUT_DEFS.find((d) => d.key === key)!);
  assert.equal(unit("gross_receipts"), "$");
  assert.equal(unit("residential_pct"), "%");
  assert.equal(unit("max_height_ft"), "ft");
  assert.equal(unit("experience_mod"), null);
});

test("inputChanges lists changed inputs and schedule categories (UX-003)", () => {
  const a: RatingInputs = parseInputs(form);
  const b: RatingInputs = { ...a, deductible: 1000 };
  const changes = inputChanges({ inputs: a, schedule: [] }, { inputs: b, schedule: [{ category: "safety", pct: -5, rationale: "x" }] });
  assert.deepEqual(changes.map((c) => [c.key, c.from, c.to]), [["deductible", 2500, 1000], ["schedule.safety", "0%", "-5%"]]);
  assert.deepEqual(inputChanges({ inputs: a, schedule: [] }, { inputs: a, schedule: [] }), []);
});

test("worksheetChips: the commercial chip persists while the worksheet chip tracks the rating", () => {
  const base = { hasRating: true, rated: true, ready: true, openReferrals: 0 };
  assert.deepEqual(worksheetChips({ ...base, hasRating: false, rated: false, ready: false }), { commercial: null, worksheet: { label: "Not rated", tone: "quiet" } });
  assert.deepEqual(worksheetChips({ ...base, rated: false, ready: false, quote: { number: "Q-2026-0001", version: 1 } }),
    { commercial: { label: "Quoted · Q-2026-0001 v1", tone: "action" }, worksheet: { label: "Rating out of date", tone: "attention" } });
  assert.deepEqual(worksheetChips({ ...base, ready: false, openReferrals: 2 }).worksheet, { label: "2 referrals open", tone: "attention" });
  assert.deepEqual(worksheetChips(base).worksheet, { label: "Ready to quote", tone: "done" });
  assert.equal(worksheetChips({ ...base, quote: { number: "Q", version: 1 }, quoteCurrent: true }).worksheet, null);
  assert.deepEqual(worksheetChips({ ...base, quote: { number: "Q", version: 1 }, quoteCurrent: false }).worksheet, { label: "Differs from quote", tone: "attention" });
  assert.deepEqual(worksheetChips({ ...base, policyNumber: "GL-26-00001", quote: { number: "Q", version: 1 } }), { commercial: { label: "Bound · GL-26-00001", tone: "done" }, worksheet: null });
});

test("gross receipts of zero is refused under the field, not by the rating service (CR-130)", () => {
  for (const gross_receipts of ["0", "$0", "0.4"]) {
    assert.throws(() => parseInputs({ ...form, gross_receipts }), (err: unknown) =>
      err instanceof FieldError && err.field === "gross_receipts" && err.message === "Gross receipts must be more than zero");
  }
  assert.equal(parseInputs({ ...form, deductible: "0", max_height_ft: "0" }).deductible, 0);   // zero is fine elsewhere
});

test("an experience mod holds two decimals, so what's shown is what's rated (CR-104)", () => {
  assert.equal(parseInputs({ ...form, experience_mod: "0.95" }).experience_mod, 0.95);
  assert.equal(parseInputs({ ...form, experience_mod: "1.1" }).experience_mod, 1.1);
  assert.equal(parseInputs({ ...form, experience_mod: ".9" }).experience_mod, 0.9);
  assert.throws(() => parseInputs({ ...form, experience_mod: "0.875" }), (err: unknown) =>
    err instanceof FieldError && err.field === "experience_mod" && /up to two decimals/.test(err.message));
  // What the input shows goes back in unchanged: a save with nothing touched isn't a change.
  for (const v of [1, 0.95, 1.1]) assert.equal(parseInputs({ ...form, experience_mod: inputText("experience_mod", v) }).experience_mod, v);
  // A longer value saved before the rule shows in full, not rounded to something a save would then write.
  assert.equal(inputText("experience_mod", 0.875), "0.875");
});
