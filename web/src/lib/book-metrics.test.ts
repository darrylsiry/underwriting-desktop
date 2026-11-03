import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsOnFile, dueWithin, isBoundNotEffective, isInForce, lossRatio, lossTotals, summarizeBook, teamSummary, type BookRow } from "./book-metrics.ts";

const TODAY = "2026-11-02";

const row = (over: Partial<BookRow>): BookRow & { renewal_status: string } => ({
  effective_date: "2026-01-01", expiration_date: "2027-01-01", class_code: "91580", class_description: "Contractors",
  premium: 10_000, incurred: 0, open_claims: 0, renewal_status: "not_started", source: "uw desktop", ...over,
});

test("in force from the effective date up to, not including, the expiration date (CR-102, CR-136)", () => {
  assert.equal(isInForce({ effective_date: TODAY, expiration_date: "2027-11-02" }, TODAY), true);
  assert.equal(isInForce({ effective_date: "2025-11-02", expiration_date: "2026-11-03" }, TODAY), true);
  assert.equal(isInForce({ effective_date: "2025-11-02", expiration_date: TODAY }, TODAY), false);
  assert.equal(isInForce({ effective_date: "2026-11-03", expiration_date: "2027-11-03" }, TODAY), false);
  assert.equal(isInForce({ effective_date: "2025-01-01", expiration_date: "2026-11-01" }, TODAY), false);
  assert.equal(isBoundNotEffective({ effective_date: "2026-11-03", expiration_date: "2027-11-03" }, TODAY), true);
  assert.equal(isBoundNotEffective({ effective_date: TODAY, expiration_date: "2027-11-03" }, TODAY), false);
});

test("binding a renewal effective in 30 days leaves in-force premium and count alone (CR-102)", () => {
  const expiring = row({ expiration_date: "2026-12-02", premium: 10_000 });
  const before = summarizeBook([expiring], TODAY).kpis;

  const renewed = { ...expiring, renewal_status: "renewed" };
  const renewal = row({ effective_date: "2026-12-02", expiration_date: "2027-12-02", premium: 12_000, is_renewal: true });
  const after = summarizeBook([renewed, renewal], TODAY);

  assert.equal(after.kpis.inForcePremium, before.inForcePremium);
  assert.equal(after.kpis.policies, before.policies);
  assert.deepEqual(after.premiumByClass.map((c) => [c.premium, c.policies]), [[10_000, 1]]);
  assert.deepEqual(after.boundNotEffective, [renewal]);
  assert.equal(after.kpis.boundNotEffectivePolicies, 1);
  assert.equal(after.kpis.boundNotEffectivePremium, 12_000);
});

test("a new policy bound ahead of its effective date is new business, not yet in force (CR-102)", () => {
  const k = summarizeBook([row({ effective_date: "2026-12-15", expiration_date: "2027-12-15" })], TODAY).kpis;
  assert.equal(k.policies, 0);
  assert.equal(k.newBusinessPolicies, 1);
  assert.equal(k.boundNotEffectivePolicies, 1);
});

test("a bound renewal is not new business (CR-066)", () => {
  const k = summarizeBook([
    row({ premium: 5_000 }),
    row({ premium: 7_000, is_renewal: true }),
    row({ premium: 9_000, source: "prior system" }),
  ], TODAY).kpis;
  assert.equal(k.newBusinessPolicies, 1);
  assert.equal(k.newBusinessPremium, 5_000);
});

test("renewals due leave out policies already renewed, matching the table and /book?due= (CR-066)", () => {
  const rows = [
    row({ expiration_date: "2026-11-30", premium: 1_000 }),
    row({ expiration_date: "2026-12-30", premium: 2_000, renewal_status: "renewed" }),
    row({ expiration_date: "2027-01-20", premium: 4_000, renewal_status: "in_progress" }),
    row({ expiration_date: "2027-02-20", premium: 8_000 }),   // past 90 days, inside the 120-day window
  ];
  const s = summarizeBook(rows, TODAY);
  assert.equal(s.kpis.renewalsDue90, 2);
  assert.equal(s.kpis.renewalPremium90, 5_000);
  assert.equal(s.renewals.length, 3);
  assert.equal(dueWithin(rows, TODAY, 90).length, s.kpis.renewalsDue90);
  assert.equal(s.renewals.filter((p) => p.expiration_date <= "2027-01-31").length, s.kpis.renewalsDue90);
});

test("the loss ratio is five years of losses over five years of premium (CR-124)", () => {
  assert.equal(lossRatio(5_000, 10_000), 0.1);
  assert.equal(lossRatio(5_000, 0), null);
  const k = summarizeBook([
    row({ source: "prior system", premium: 10_000, incurred: 5_000, open_claims: 2 }),
    row({ premium: 90_000 }),   // no loss history here yet, so not in the ratio
    row({ source: "prior system", premium: 40_000, incurred: 40_000, open_claims: 3, effective_date: "2026-12-01", expiration_date: "2027-12-01" }),   // not in force
  ], TODAY).kpis;
  assert.equal(k.lossRatio, 0.1);
  assert.equal(k.openClaims, 2);
});

test("the team's numbers are the sum of the desks, on the same definitions (CR-080, CR-089, CR-102, CR-124)", () => {
  const desk = (user: string, rows: BookRow[]) => ({ user, ...summarizeBook(rows, TODAY) });
  const a = desk("underwriter1", [
    row({ source: "prior system", premium: 10_000, incurred: 5_000, expiration_date: "2026-12-01" }),
    row({ premium: 3_000, expiration_date: "2026-12-15" }),
  ]);
  const b = desk("underwriter2", [
    row({ source: "prior system", premium: 30_000, incurred: 0, expiration_date: "2027-06-01" }),
    row({ premium: 6_000, effective_date: "2027-01-01", expiration_date: "2028-01-01" }),
  ]);
  const team = teamSummary([a, b]);
  assert.equal(team.in_force_premium, a.kpis.inForcePremium + b.kpis.inForcePremium);
  assert.equal(team.policies_in_force, 3);
  // Both the count and the premium cover Desktop policies as well as prior-system ones.
  assert.equal(team.renewals_due_90_days, 2);
  assert.equal(team.renewal_premium_90_days, 13_000);
  assert.deepEqual(team.bound_not_effective, { policies: 1, premium: 6_000 });
  assert.equal(team.new_business_policies, 2);
  assert.equal(team.book_loss_ratio_incurred, lossRatio(5_000, 40_000));
  assert.deepEqual(team.by_underwriter.map((u) => [u.underwriter, u.prior_system_policies, u.uw_desktop_policies]), [["underwriter1", 1, 1], ["underwriter2", 1, 0]]);
  assert.equal(team.by_underwriter[0].loss_ratio, 0.1);
});

test("on a renewal's effective date only the renewal counts, and the expiring one can still be worked (CR-136)", () => {
  const expiring = row({ effective_date: "2025-11-02", expiration_date: TODAY, premium: 10_000 });
  const renewal = row({ effective_date: TODAY, expiration_date: "2027-11-02", premium: 12_000, is_renewal: true });
  const s = summarizeBook([expiring, renewal], TODAY);
  assert.equal(s.kpis.inForcePremium, 12_000);
  assert.equal(s.kpis.policies, 1);
  assert.deepEqual(s.renewals, [expiring, renewal].filter((p) => p.expiration_date === TODAY));
});

test("loss totals count every row and only open ones as open (CR-135)", () => {
  assert.deepEqual(lossTotals([
    { incurred: 40_000, status: "Open" },
    { incurred: 2_500, status: "Closed" },
  ]), { claims: 2, incurred: 42_500, open_claims: 1 });
  assert.deepEqual(lossTotals([]), { claims: 0, incurred: 0, open_claims: 0 });
  assert.deepEqual(lossTotals(null), { claims: 0, incurred: 0, open_claims: 0 });
});

test("a renewal's claims: the rows when they tell the whole story, otherwise the totals carried from the expiring policy (CR-152)", () => {
  const rows = [{ incurred: 1000, status: "Closed" }, { incurred: 2000, status: "Open" }];
  assert.deepEqual(claimsOnFile({ data: { loss_history: rows } }), { claims: 2, incurred: 3000, open_claims: 1 });
  const carried = { claims: 3, incurred: 90_000, open_claims: 1 };
  assert.deepEqual(claimsOnFile({ data: { loss_history: [] }, renewal_of: { losses: carried } }), carried);
  assert.deepEqual(claimsOnFile({ data: { loss_history: rows }, renewal_of: { losses: { claims: 1, incurred: 500, open_claims: 0 } } }), { claims: 2, incurred: 3000, open_claims: 1 });
  assert.deepEqual(claimsOnFile(undefined), { claims: 0, incurred: 0, open_claims: 0 });
});
