import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSummary, compareRenewal, type Side } from "./renewal-compare.ts";
import type { Rating } from "./worksheets.ts";

const inputs = {
  class_code: "98304", gross_receipts: 650_000, states: ["FL"], home_state: "FL",
  occurrence_limit: 1_000_000, aggregate_limit: 2_000_000, deductible: 1000, residential_pct: 100,
  subcontracted_pct: 0, subcontractor_coi_required: true, max_height_ft: 0, experience_mod: 1,
};

function rating(version: string, lines: [string, string, number | null, number][], premium: number): Rating {
  return {
    rating_id: "r", rate_version: version, rate_version_id: 1, class_description: "Painting",
    premium: String(premium), minimum_premium_applied: false, policy_fee: "250",
    surplus_lines_tax: String(Math.round(premium * 0.05)), surplus_lines_tax_rate: "0.05", total: String(premium + 250 + Math.round(premium * 0.05)),
    worksheet: lines.map(([step, detail, factor, p]) => ({ step, detail, factor: factor === null ? null : String(factor), premium: String(p) })),
  };
}

// Expiring: $650K receipts, FL 1.25, deductible 0.98, on 2026.1.
const expiringRating = rating("2026.1", [
  ["Base premium", "Painting: $8.2000 per $1,000 × $650,000 receipts", null, 5330],
  ["Territory", "Florida (highest of FL)", 1.25, 6663],
  ["Deductible", "$1,000+", 0.98, 6529],
], 6529);
// Renewing terms: receipts up to $800K and a $2,500 deductible. Bridge = those terms on 2026.1.
const bridgeRating = rating("2026.1", [
  ["Base premium", "Painting: $8.2000 per $1,000 × $800,000 receipts", null, 6560],
  ["Territory", "Florida (highest of FL)", 1.25, 8200],
  ["Deductible", "$2,500+", 0.96, 7872],
], 7872);
// Current rates 2026.2 raised FL to 1.35.
const renewingRating = rating("2026.2", [
  ["Base premium", "Painting: $8.2000 per $1,000 × $800,000 receipts", null, 6560],
  ["Territory", "Florida (highest of FL)", 1.35, 8856],
  ["Deductible", "$2,500+", 0.96, 8502],
], 8502);

const expiring: Side = { inputs, schedule: [], rating: expiringRating, effective_date: "2025-11-01", expiration_date: "2026-11-01" };
const renewing: Side = {
  inputs: { ...inputs, gross_receipts: 800_000, deductible: 2500 },
  schedule: [{ category: "safety", pct: -5, rationale: "Program" }],
  rating: renewingRating, effective_date: "2026-11-01", expiration_date: "2027-11-01",
};

test("terms that changed are flagged and described", () => {
  const c = compareRenewal(expiring, renewing, bridgeRating);
  const changed = c.terms.filter((t) => t.changed).map((t) => t.key);
  assert.deepEqual(changed, ["period", "gross_receipts", "deductible", "schedule"]);
  assert.deepEqual(c.reasons.terms, [
    "Gross receipts changed from $650,000 to $800,000 (+23.1%).",
    "Deductible changed from $1,000 to $2,500.",
  ]);
  assert.deepEqual(c.reasons.schedule, ["A credit of -5% applies for safety program & training."]);
});

test("the bridge splits the premium change into terms and rates", () => {
  const c = compareRenewal(expiring, renewing, bridgeRating);
  assert.equal(c.bridge.change, 8502 - 6529);
  assert.equal(c.bridge.termsImpact, 7872 - 6529);
  assert.equal(c.bridge.ratesImpact, 8502 - 7872);
  assert.equal(c.bridge.termsImpact! + c.bridge.ratesImpact!, c.bridge.change);
  assert.equal(changeSummary(c.bridge), "up 30.2% (+$1,973)");
});

test("factor lines say whether terms or rates moved them", () => {
  const c = compareRenewal(expiring, renewing, bridgeRating);
  const by = Object.fromEntries(c.factors.map((f) => [f.step, f]));
  assert.equal(by["Base premium"].cause, "terms");     // receipts changed, same rate per $1,000
  assert.equal(by["Territory"].cause, "rates");        // same state, factor 1.25 -> 1.35
  assert.equal(by["Deductible"].cause, "terms");       // different band
  assert.deepEqual(c.reasons.rates, ["The territory factor (Florida (highest of FL)) changed from 1.25 to 1.35 under rate revision 2026.2."]);
});

test("without a bridge the split is unknown and rate reasons are empty", () => {
  const c = compareRenewal(expiring, renewing, null);
  assert.equal(c.bridge.termsImpact, null);
  assert.equal(c.bridge.ratesImpact, null);
  assert.deepEqual(c.reasons.rates, []);
  assert.equal(c.factors.find((f) => f.step === "Territory")!.cause, null);
});

test("an unchanged renewal reads as unchanged", () => {
  const same: Side = { ...expiring, effective_date: "2026-11-01", expiration_date: "2027-11-01" };
  const c = compareRenewal(expiring, same, expiringRating);
  assert.equal(changeSummary(c.bridge), "unchanged");
  assert.deepEqual(c.reasons, { terms: [], schedule: [], rates: [] });
  assert.equal(c.terms.filter((t) => t.changed).length, 1);  // only the policy period
});
