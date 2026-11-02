import assert from "node:assert/strict";
import { test } from "node:test";
import { attention, fromInput, FIELD_DEFS, missingForRating, openAttention, type FieldMeta, type SubmissionData } from "./submission.ts";

const complete = () => ({
  applicant: { state: "TX" },
  operations: { class_code: "92215", gross_receipts: 500_000, states: ["TX"] },
  policy: { occurrence_limit: 1_000_000, aggregate_limit: 2_000_000 },
  producer: {}, prior: {}, loss_history: [],
}) as unknown as SubmissionData;

test("gross receipts of zero counts as missing, like an empty field (CR-130)", () => {
  assert.deepEqual(missingForRating(complete()), []);
  const zero = complete();
  zero.operations.gross_receipts = 0;
  assert.deepEqual(missingForRating(zero), ["operations.gross_receipts"]);
  assert.equal(attention("operations.gross_receipts", 0, undefined, false), "Required for rating");
  assert.equal(attention("operations.payroll", 0, undefined, false), null);   // only receipts: other zeros are answers
});

test("a required field corrected and then blanked still shows as missing (CR-048)", () => {
  assert.equal(openAttention("operations.class_code", null, undefined, false, true), "Required for rating");
  assert.equal(openAttention("operations.class_code", "", undefined, false, true), "Required for rating");
  // A correction still settles every other doubt.
  const meta: FieldMeta = { value: "92215", confidence: 0.5, method: "claude", basis: "inferred", source_document: "a.eml", snippet: "x" };
  assert.equal(openAttention("operations.class_code", "92215", meta, true, true), null);
  assert.equal(openAttention("operations.class_code", "92215", meta, true, false), "Documents disagree");
  assert.equal(openAttention("applicant.website", null, undefined, false, true), null);   // not required: nothing to say
});

test("intake dates must exist on the calendar", () => {
  const effective = FIELD_DEFS.find((d) => d.path === "policy.effective_date")!;
  assert.equal(fromInput(effective, "2028-02-29"), "2028-02-29");
  assert.throws(() => fromInput(effective, "2026-02-30"), /use YYYY-MM-DD/);
});
