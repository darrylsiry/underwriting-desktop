import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExpiringPolicy } from "./renewal-compare";
import { renewalSubmissionData } from "./renewal-data.ts";
import type { SubmissionData } from "./submission";

// CR-014: the submission a renewal starts from. What it carries decides which referrals can fire.

const inputs = {
  class_code: "91342", gross_receipts: 2_000_000, states: ["TX", "NM"], home_state: "TX", occurrence_limit: 1_000_000, aggregate_limit: 2_000_000,
  deductible: 2500, residential_pct: 80, subcontracted_pct: 10, subcontractor_coi_required: true, max_height_ft: 25, experience_mod: 1,
};
const expiring = (o: Partial<ExpiringPolicy> = {}) => ({
  source: "desktop", policy_id: "p1", policy_number: "GL-25-00001", insured_name: "Hill Country Carpentry LLC",
  producer: ["Copper State Insurance Group", "Hannah Lindqvist", "hannah@example.com", "(201) 555-0110"],
  effective_date: "2026-03-15", expiration_date: "2027-03-15", rate_version: "2026.1", rating_inputs: inputs, schedule: [], rating: {},
  premium: 9000, policy_fee: 250, surplus_lines_tax: 400, total: 9650,
  terms: { limits: [{ label: "Each occurrence", amount: 1_000_000 }, { label: "General aggregate", amount: 2_000_000 }, { label: "Products", amount: 3_000_000 }], deductible: 2500, class_code: "91342", class_description: "Carpentry", operations: "Finish carpentry", forms: [] },
  losses: { claims: 0, incurred: 0, open_claims: 0 }, ...o,
}) as unknown as ExpiringPolicy;
const LOSS = { date: "2025-06-01", description: "Slip and fall", incurred: 12_000, status: "Closed" };
const original = {
  applicant: { name: "Old Name LLC", state: "NM", fein: "86-1234567", street: "1 Main St" },
  producer: { agency: "Old Agency", contact: "Old Contact", email: "old@example.com", phone: "(201) 555-0100" },
  policy: { effective_date: "2026-03-15", occurrence_limit: 500_000, custom: "kept" },
  operations: { description: "Old description", payroll: 500_000 },
  prior: { carrier: "Someone Else", premium: 7000 },
  loss_history: [LOSS],
} as unknown as SubmissionData;

test("the policy period rolls forward one year from the expiring date", () => {
  const { policy } = renewalSubmissionData(expiring(), null, "TX");
  assert.equal(policy.effective_date, "2027-03-15");
  assert.equal(policy.expiration_date, "2028-03-15");
});

test("limits and operations come from what the policy was written on, not the old application", () => {
  const data = renewalSubmissionData(expiring(), original, "TX");
  assert.equal(data.policy.occurrence_limit, 1_000_000);
  assert.equal(data.policy.aggregate_limit, 2_000_000);
  assert.equal(data.policy.products_aggregate_limit, 3_000_000);
  assert.equal(data.policy.deductible, 2500);
  assert.equal(data.operations.description, "Finish carpentry");
  assert.deepEqual(data.operations.states, ["TX", "NM"]);
  assert.equal(data.operations.gross_receipts, 2_000_000);
  assert.equal(data.operations.subcontractor_coi_required, true);
  assert.equal(data.applicant.name, "Hill Country Carpentry LLC");
  assert.equal(data.applicant.state, "TX");
});

test("what only the old application knows is kept", () => {
  const data = renewalSubmissionData(expiring(), original, "TX");
  assert.equal(data.applicant.fein, "86-1234567");
  assert.equal(data.applicant.street, "1 Main St");
  assert.equal(data.policy.custom, "kept");
  assert.equal(data.operations.payroll, 500_000);
  assert.equal(data.producer.email, "old@example.com");
  assert.deepEqual(data.loss_history, [LOSS]);
});

test("the producer is the first two lines of the expiring terms, with email and phone on their own lines or not", () => {
  const data = renewalSubmissionData(expiring(), original, "TX");
  assert.equal(data.producer.agency, "Copper State Insurance Group");
  assert.equal(data.producer.contact, "Hannah Lindqvist");
  const older = renewalSubmissionData(expiring({ producer: ["Copper State", "Hannah", "hannah@example.com  ·  (201) 555-0110"] }), null, "TX");
  assert.equal(older.producer.agency, "Copper State");
  assert.equal(older.producer.contact, "Hannah");
  assert.equal(renewalSubmissionData(expiring({ producer: ["Book Agency"] }), null, "TX").producer.contact, "");
});

test("the prior insurance is the expiring policy, ours", () => {
  assert.deepEqual(renewalSubmissionData(expiring(), original, "TX").prior, { carrier: "Underwriting Desktop Specialty", premium: 9000 });
});

test("a prior-system policy has no application: the sections start empty and there are no loss rows", () => {
  const data = renewalSubmissionData(expiring({ source: "book" }), null, "TX");
  assert.deepEqual(data.loss_history, []);
  assert.equal(data.applicant.fein, undefined);
  assert.equal(data.operations.payroll, undefined);
});

test("missing products aggregate falls back to the general aggregate", () => {
  const exp = expiring();
  exp.terms = { ...exp.terms, limits: exp.terms.limits.slice(0, 2) };
  assert.equal(renewalSubmissionData(exp, null, "TX").policy.products_aggregate_limit, 2_000_000);
});

test("the original isn't changed by building the renewal", () => {
  const before = structuredClone(original);
  renewalSubmissionData(expiring(), original, "TX");
  assert.deepEqual(original, before);
});
