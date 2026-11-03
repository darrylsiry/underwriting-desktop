import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSummary, compareRenewal, coverageGapNote, type Side } from "./renewal-compare.ts";
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

const minimumCase = (expiringMin: number, renewingMin: number | null, renewingPremium: number) => {
  const lines = (premium: number) => [["Base premium", "Painting: $8.2000 per $1,000 × $100,000 receipts", null, premium]] as [string, string, number | null, number][];
  const withMin = (min: number | null, base: number) => min === null ? lines(base) : [...lines(base), ["Minimum premium", `Class minimum $${min.toLocaleString("en-US")}`, null, min] as [string, string, number | null, number]];
  const before = rating("2026.1", withMin(expiringMin, 820), expiringMin);
  const after = rating("2026.2", withMin(renewingMin, renewingPremium), renewingPremium);
  const side = (r: Rating): Side => ({ inputs, schedule: [], rating: r, effective_date: "2025-11-01", expiration_date: "2026-11-01" });
  return compareRenewal(side(before), side(after), before).reasons.rates;
};

test("a raised class minimum is named as the reason, not called no change (CR-170)", () => {
  const reasons = minimumCase(2500, 3500, 3500);
  assert.ok(reasons.some((r) => r.includes("minimum premium") && r.includes("$2,500") && r.includes("$3,500")), reasons.join());
  assert.ok(!reasons.some((r) => r.includes("none of its changes")), reasons.join());
});

test("a minimum that stops applying is named too", () => {
  const reasons = minimumCase(2500, null, 3000);
  assert.ok(reasons.some((r) => r.includes("minimum premium") && r.includes("$2,500") && r.includes("no longer")), reasons.join());
});

test("only a revision that moved nothing says so; one nothing explains gives the amount (CR-170)", () => {
  const lines = (rate: string) => [["Base premium", `Painting: $${rate} per $1,000 × $100,000 receipts`, null, 820]] as [string, string, number | null, number][];
  const side = (r: Rating): Side => ({ inputs, schedule: [], rating: r, effective_date: "2025-11-01", expiration_date: "2026-11-01" });
  const same = rating("2026.1", lines("8.20"), 820);
  assert.ok(compareRenewal(side(same), side(rating("2026.2", lines("8.20"), 820)), same).reasons.rates[0].includes("none of its changes"));
  const moved = compareRenewal(side(same), side(rating("2026.2", lines("8.20"), 821)), same).reasons.rates;
  assert.ok(!moved.some((r) => r.includes("none of its changes")), moved.join());
  assert.ok(moved.some((r) => r.includes("$1")), moved.join());
});

test("a renewal that starts after the expiring policy ends says how long the gap is (CR-156)", () => {
  assert.equal(coverageGapNote("2027-03-15", "2027-03-15"), null);
  assert.match(coverageGapNote("2027-03-15", "2027-04-01")!, /17 days/);
  assert.match(coverageGapNote("2027-03-15", "2027-03-16")!, /1 day\b/);
});
