// What the book's numbers mean, in one place: which policies are in force, which are due for
// renewal, what counts as new business, and the loss ratio. Used by the desk, the book page, the
// policy page and the assistant so they can't drift apart. Pure module for node:test.
import { isOpenLoss } from "./referrals.ts";

export const RENEWAL_WINDOW_DAYS = 120;

export const daysUntil = (date: string, today: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

type Term = { effective_date: string; expiration_date: string };

/**
 * In force today: already effective and not yet expired (CR-102). A period ends at 12:01 a.m. on its
 * expiration date, the moment its renewal starts, so that day belongs to the renewal (CR-136).
 */
export const isInForce = (p: Term, today: string) => p.effective_date <= today && p.expiration_date > today;

/** Bound ahead of its effective date, such as a renewal waiting for the expiring term to end (CR-102). */
export const isBoundNotEffective = (p: Term, today: string) => p.effective_date > today && p.expiration_date >= today;

/** Expiring within `days` and still needing a renewal: a policy already renewed has nothing left to do (CR-066). */
export const dueWithin = <T extends Term & { renewal_status: string }>(rows: T[], today: string, days: number): T[] =>
  rows.filter((p) => p.renewal_status !== "renewed" && daysUntil(p.expiration_date, today) <= days);

/** Claims, incurred and open claims from a submission's loss rows, so the desk, the assistant and the renewal page agree (CR-135). */
export function lossTotals(losses: { incurred: number; status: string }[] | null | undefined) {
  const rows = losses ?? [];
  return { claims: rows.length, incurred: rows.reduce((n, l) => n + l.incurred, 0), open_claims: rows.filter((l) => isOpenLoss(l.status)).length };
}

/** The years of losses the book's `incurred` covers. */
export const LOSS_HISTORY_YEARS = 5;
export const LOSS_RATIO_BASIS = "five-year losses on current premium";

/**
 * Five years of incurred over five years of premium, approximated from one term's premium (CR-124).
 * Null when there is no premium to divide by.
 */
export function lossRatio(incurred: number, annualPremium: number): number | null {
  return annualPremium > 0 ? incurred / (annualPremium * LOSS_HISTORY_YEARS) : null;
}

export type BookRow = Term & {
  class_code: string; class_description: string; premium: number; incurred: number; open_claims: number;
  renewal_status: string; source: "prior system" | "uw desktop";
  is_renewal?: boolean;   // bound in the UW Desktop as the renewal of an expiring policy
};

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
const isPrior = (p: BookRow) => p.source === "prior system";

/**
 * The desk's numbers from every unexpired policy of one underwriter. The tiles and the by-class
 * chart count what is in force today; renewal work and new business use the wider list.
 */
export function summarizeBook<T extends BookRow>(unexpired: T[], today: string) {
  const book = unexpired.filter((p) => isInForce(p, today));
  const boundNotEffective = unexpired.filter((p) => isBoundNotEffective(p, today));
  const due90 = dueWithin(unexpired, today, 90);
  const prior = book.filter(isPrior);
  const newBusiness = unexpired.filter((p) => !isPrior(p) && !p.is_renewal);

  const byClass = new Map<string, { code: string; description: string; premium: number; policies: number }>();
  for (const p of book) {
    const c = byClass.get(p.class_code) ?? { code: p.class_code, description: p.class_description, premium: 0, policies: 0 };
    c.premium += p.premium;
    c.policies += 1;
    byClass.set(p.class_code, c);
  }

  return {
    book, boundNotEffective,
    renewals: dueWithin(unexpired, today, RENEWAL_WINDOW_DAYS),
    premiumByClass: [...byClass.values()].sort((a, b) => b.premium - a.premium),
    kpis: {
      inForcePremium: sum(book, (p) => p.premium),
      policies: book.length,
      boundNotEffectivePremium: sum(boundNotEffective, (p) => p.premium),
      boundNotEffectivePolicies: boundNotEffective.length,
      renewalsDue90: due90.length,
      renewalPremium90: sum(due90, (p) => p.premium),
      lossRatio: lossRatio(sum(prior, (p) => p.incurred), sum(prior, (p) => p.premium)),
      openClaims: sum(prior, (p) => p.open_claims),
      newBusinessPremium: sum(newBusiness, (p) => p.premium),
      newBusinessPolicies: newBusiness.length,
    },
  };
}

type Desk = {
  user: string;
  book: BookRow[];
  kpis: ReturnType<typeof summarizeBook>["kpis"];
};

const cents = (n: number) => Math.round(n * 100) / 100;
const ratio = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

/** The whole operation: every number is the sum of the desks, so the team and a desk can't disagree (CR-080, CR-089). */
export function teamSummary(desks: Desk[]) {
  const total = (f: (k: Desk["kpis"]) => number) => sum(desks, (d) => f(d.kpis));
  const prior = desks.flatMap((d) => d.book.filter(isPrior));
  return {
    in_force_premium: cents(total((k) => k.inForcePremium)),
    policies_in_force: total((k) => k.policies),
    bound_not_effective: { policies: total((k) => k.boundNotEffectivePolicies), premium: cents(total((k) => k.boundNotEffectivePremium)) },
    renewals_due_90_days: total((k) => k.renewalsDue90),
    renewal_premium_90_days: cents(total((k) => k.renewalPremium90)),
    book_loss_ratio_incurred: ratio(lossRatio(sum(prior, (p) => p.incurred), sum(prior, (p) => p.premium))),
    loss_ratio_basis: LOSS_RATIO_BASIS,
    open_claims: total((k) => k.openClaims),
    new_business_premium: cents(total((k) => k.newBusinessPremium)),
    new_business_policies: total((k) => k.newBusinessPolicies),
    by_underwriter: desks.map((d) => {
      const mine = d.book.filter(isPrior);
      const written = d.book.filter((p) => !isPrior(p));
      return {
        underwriter: d.user,
        prior_system_policies: mine.length, prior_system_premium: cents(sum(mine, (p) => p.premium)),
        uw_desktop_policies: written.length, uw_desktop_premium: cents(sum(written, (p) => p.premium)),
        bound_not_effective_policies: d.kpis.boundNotEffectivePolicies,
        renewals_due_90: d.kpis.renewalsDue90,
        loss_ratio: ratio(d.kpis.lossRatio),
      };
    }),
  };
}
