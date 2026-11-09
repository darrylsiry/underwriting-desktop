import { whenDate } from "./time.ts";
// Comparing an expiring policy with its renewing terms: which rating variables changed, which rate
// factors changed, and how the premium change splits between the two. Pure module (type-only
// imports) so node:test can load it; the memo PDF and the comparison page both render from this.
import { money, moneySigned as signed } from "./format.ts";
import { quotedFactChanges, type ProducerFields } from "./quote-terms.ts";
import type { SubmissionData } from "./submission";
import type { RatingInputs, ScheduleItem } from "./worksheet";
import type { Rating } from "./worksheets";
// Explicit .ts extension so node:test can load this module directly (worksheet.ts is itself pure).
import { INPUT_DEFS, SCHEDULE_CATEGORIES, inputChanges, inputsHash, scheduleTotal } from "./worksheet.ts";

/** Snapshot of the policy being renewed, stored on the renewal submission when it starts. */
export type ExpiringPolicy = {
  source: "book" | "desktop";
  policy_id: string;
  policy_number: string;
  insured_name: string;
  producer: string[];
  producer_fields?: ProducerFields;   // the producer by name; a policy from before CR-125 has only the lines above
  effective_date: string;
  expiration_date: string;
  rate_version: string;
  rating_inputs: RatingInputs;
  schedule: ScheduleItem[];
  rating: Rating;                     // the expiring premium, rated on rate_version
  premium: number;
  policy_fee: number;
  surplus_lines_tax: number;
  total: number;
  terms: { limits: { label: string; amount: number }[]; deductible: number; class_code: string; class_description: string; operations: string; forms: string[] };
  losses: { claims: number; incurred: number; open_claims: number };
  quote_id?: string;
};

export type Side = { inputs: RatingInputs; schedule: ScheduleItem[]; rating: Rating; effective_date: string; expiration_date: string };

export type TermChange = { key: string; label: string; expiring: string; renewing: string; changed: boolean };
export type FactorLine = { detail: string; factor: number | null; premium: number };
export type FactorChange = {
  step: string; expiring: FactorLine | null; renewing: FactorLine | null;
  changed: boolean;                   // the factor or the base rate moved
  cause: "terms" | "rates" | "both" | null;   // what moved it, when the bridge rating is available
};
export type MoneyRow = { label: string; expiring: number; renewing: number; change: number; pct: number | null };
export type Bridge = {
  expiringPremium: number; renewingPremium: number; change: number; pct: number | null;
  termsImpact: number | null;          // renewing inputs on expiring rates, minus expiring premium
  ratesImpact: number | null;          // renewing inputs on current rates, minus the above
  rateVersionFrom: string; rateVersionTo: string;
};
export type Comparison = {
  terms: TermChange[];
  factors: FactorChange[];
  money: MoneyRow[];
  bridge: Bridge;
  reasons: { terms: string[]; schedule: string[]; rates: string[] };
};

export { money, signed };
export const pct = (from: number, to: number): number | null => (from ? Math.round(((to - from) / from) * 1000) / 10 : null);
export const pctText = (p: number | null) => (p === null ? "" : `${p >= 0 ? "+" : ""}${p}%`);

export function inputText(key: keyof RatingInputs, v: RatingInputs[keyof RatingInputs]): string {
  const def = INPUT_DEFS.find((d) => d.key === key)!;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (def.kind === "money") return money(Number(v));
  if (def.kind === "pct") return `${v}%`;
  if (def.kind === "mod") {
    // Saves allow two decimals (CR-104). A longer value saved before that shows in full, so the input can't quietly round it.
    const n = Number(v);
    return Math.round(n * 100) / 100 === n ? n.toFixed(2) : String(n);
  }
  return String(v);
}

const sameInput = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const categoryLabel = (key: string) => SCHEDULE_CATEGORIES.find((c) => c.key === key)?.label ?? key;
const schedText = (pct: number) => `${pct > 0 ? "+" : ""}${pct}%`;
const usDate = (iso: string) => whenDate(iso);   // UX-025: one on-screen date format

function termChanges(a: Side, b: Side): TermChange[] {
  const out: TermChange[] = [{
    key: "period", label: "Policy period", changed: true,
    expiring: `${usDate(a.effective_date)} to ${usDate(a.expiration_date)}`,
    renewing: `${usDate(b.effective_date)} to ${usDate(b.expiration_date)}`,
  }];
  for (const d of INPUT_DEFS) {
    const x = a.inputs[d.key], y = b.inputs[d.key];
    out.push({ key: d.key, label: d.label, expiring: inputText(d.key, x), renewing: inputText(d.key, y), changed: !sameInput(x, y) });
  }
  const ta = scheduleTotal(a.schedule), tb = scheduleTotal(b.schedule);
  out.push({ key: "schedule", label: "Schedule rating", expiring: schedText(ta), renewing: schedText(tb), changed: ta !== tb });
  return out;
}

function line(r: Rating, step: string): FactorLine | null {
  const w = r.worksheet.find((l) => l.step === step);
  return w ? { detail: w.detail, factor: w.factor === null ? null : Number(w.factor), premium: Number(w.premium) } : null;
}

const lineKey = (l: FactorLine | null) => (l ? `${l.factor ?? ""}|${l.detail}` : "");

function factorChanges(expiring: Rating, renewing: Rating, bridge: Rating | null): FactorChange[] {
  const steps = [...new Set([...expiring.worksheet.map((l) => l.step), ...renewing.worksheet.map((l) => l.step)])];
  return steps.map((step) => {
    const x = line(expiring, step), y = line(renewing, step), b = bridge ? line(bridge, step) : null;
    const changed = lineKey(x) !== lineKey(y);
    let cause: FactorChange["cause"] = null;
    if (changed && bridge) {
      const terms = lineKey(x) !== lineKey(b);
      const rates = lineKey(b) !== lineKey(y);
      cause = terms && rates ? "both" : rates ? "rates" : "terms";
    }
    return { step, expiring: x, renewing: y, changed, cause };
  });
}

/** Sentences for the memo: every rating variable that changed, in the insured's terms. */
function termReasons(a: Side, b: Side): string[] {
  const out: string[] = [];
  for (const d of INPUT_DEFS) {
    const x = a.inputs[d.key], y = b.inputs[d.key];
    if (sameInput(x, y)) continue;
    const from = inputText(d.key, x), to = inputText(d.key, y);
    if (d.key === "gross_receipts" && typeof x === "number" && typeof y === "number") {
      out.push(`${d.label} changed from ${from} to ${to} (${pctText(pct(x, y))}).`);
    } else if (d.key === "states") {
      out.push(`States of operation changed from ${from} to ${to}; the territory factor follows the highest-rated state.`);
    } else {
      out.push(`${d.label} changed from ${from} to ${to}.`);
    }
  }
  return out;
}

function scheduleReasons(a: ScheduleItem[], b: ScheduleItem[]): string[] {
  const out: string[] = [];
  const before = new Map(a.map((s) => [s.category, s])), after = new Map(b.map((s) => [s.category, s]));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(key), y = after.get(key);
    const label = categoryLabel(key);
    if (x && !y) out.push(`The ${x.pct < 0 ? "credit" : "debit"} of ${schedText(x.pct)} for ${label.toLowerCase()} no longer applies.`);
    else if (!x && y) out.push(`A ${y.pct < 0 ? "credit" : "debit"} of ${schedText(y.pct)} applies for ${label.toLowerCase()}.`);
    else if (x && y && x.pct !== y.pct) out.push(`The adjustment for ${label.toLowerCase()} changed from ${schedText(x.pct)} to ${schedText(y.pct)}.`);
  }
  return out;
}

type Terms = { rating_inputs: RatingInputs; schedule: ScheduleItem[] };

/**
 * Does the worksheet still say what the latest issued quote says? The quote froze its inputs and schedule (UX-003).
 * The workbench and the renewal page both read this, so they agree about one file (CR-180).
 */
export function quoteDrift(
  quoted: (Terms & { insured_name?: string; terms?: { insured_address: string[]; producer: string[] } }) | null, ws: Terms,
  sub?: { applicant_name: string; data: SubmissionData },
) {
  // The insured and producer a quote froze count too: a correction to them on a reopened intake is a difference (UX-081).
  const facts = quoted && sub && quoted.insured_name !== undefined && quoted.terms ? quotedFactChanges({ insured_name: quoted.insured_name, terms: quoted.terms }, sub) : [];
  const quoteCurrent = !!quoted && !facts.length && inputsHash(quoted.rating_inputs, quoted.schedule) === inputsHash(ws.rating_inputs, ws.schedule);
  // A schedule change arrives as its percent; every input reads as it does on the worksheet.
  const text = (key: string, v: unknown) => key.startsWith("schedule.") ? String(v) : inputText(key as keyof RatingInputs, v as RatingInputs[keyof RatingInputs]);
  const drift = quoted && !quoteCurrent
    ? [...inputChanges({ inputs: quoted.rating_inputs, schedule: quoted.schedule }, { inputs: ws.rating_inputs, schedule: ws.schedule })
        .map((c) => ({ label: c.label, from: text(c.key, c.from), to: text(c.key, c.to) })), ...facts]
    : [];
  return { quoteCurrent, drift };
}

const RATE_PER_1000 = /\$([\d.]+) per \$1,000/;
const CLASS_MINIMUM = "Minimum premium";

/** A class minimum moves the premium with no factor to show for it (CR-170). */
function minimumReason(bridge: Rating, renewing: Rating): string | null {
  const b = line(bridge, CLASS_MINIMUM), r = line(renewing, CLASS_MINIMUM);
  const to = renewing.rate_version;
  if (b && r) return b.premium === r.premium ? null : `The minimum premium for your class changed from ${money(Number(b.premium))} to ${money(Number(r.premium))} under rate revision ${to}.`;
  if (r) return `The minimum premium for your class, ${money(Number(r.premium))}, now applies to this policy under rate revision ${to}.`;
  if (b) return `The minimum premium for your class, ${money(Number(b.premium))}, no longer applies to this policy under rate revision ${to}.`;
  return null;
}

/** What a memo says when a renewal starts after the expiring policy ends; null when they meet (CR-156). */
export function coverageGapNote(expiringEnds: string, renewingStarts: string): string | null {
  const days = Math.round((Date.parse(`${renewingStarts}T00:00:00Z`) - Date.parse(`${expiringEnds}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return null;
  return `The expiring policy ends on ${whenDate(expiringEnds)} and this renewal starts on ${whenDate(renewingStarts)}, leaving ${days} day${days === 1 ? "" : "s"} without coverage from us.`;
}

/** Rate-table changes: lines that differ between the bridge (old rates) and the renewing rating (current rates). */
function rateReasons(bridge: Rating | null, renewing: Rating): string[] {
  if (!bridge) return [];
  const out: string[] = [];
  const from = bridge.rate_version, to = renewing.rate_version;
  const minimum = minimumReason(bridge, renewing);
  if (minimum) out.push(minimum);
  for (const l of renewing.worksheet) {
    const b = line(bridge, l.step);
    if (!b) continue;
    if (l.step === "Base premium") {
      const r0 = b.detail.match(RATE_PER_1000)?.[1], r1 = l.detail.match(RATE_PER_1000)?.[1];
      if (r0 && r1 && r0 !== r1) out.push(`The base rate for your class changed from $${Number(r0).toFixed(2)} to $${Number(r1).toFixed(2)} per $1,000 of receipts under rate revision ${to}.`);
      continue;
    }
    if (l.factor !== null && b.factor !== null && Number(l.factor) !== Number(b.factor) && b.detail === l.detail) {
      out.push(`The ${l.step.toLowerCase()} factor (${l.detail}) changed from ${Number(b.factor)} to ${Number(l.factor)} under rate revision ${to}.`);
    }
  }
  if (Number(bridge.policy_fee) !== Number(renewing.policy_fee)) {
    out.push(`The policy fee changed from ${money(Number(bridge.policy_fee))} to ${money(Number(renewing.policy_fee))}.`);
  }
  if (Number(bridge.surplus_lines_tax_rate) !== Number(renewing.surplus_lines_tax_rate)) {
    out.push(`The surplus lines tax rate changed from ${(Number(bridge.surplus_lines_tax_rate) * 100).toFixed(2)}% to ${(Number(renewing.surplus_lines_tax_rate) * 100).toFixed(2)}%.`);
  }
  if (!out.length && from !== to) {
    const moved = Number(renewing.premium) - Number(bridge.premium);
    out.push(moved === 0 ? `Rate revision ${to} replaced ${from}; none of its changes affect this policy's factors.`
      : `Rate revision ${to} replaced ${from} and moved this policy's premium by ${signed(moved)}.`);
  }
  return out;
}

/**
 * `bridge` is the renewing inputs rated on the expiring rate version (null when that version
 * couldn't be rated on). It lets the premium change be split: expiring -> bridge is what the
 * insured's terms did; bridge -> renewing is what the rate tables did.
 */
export function compareRenewal(expiring: Side, renewing: Side, bridge: Rating | null): Comparison {
  const x = expiring.rating, y = renewing.rating;
  const row = (label: string, a: number, b: number): MoneyRow => ({ label, expiring: a, renewing: b, change: b - a, pct: pct(a, b) });
  const moneyRows = [
    row("Premium", Number(x.premium), Number(y.premium)),
    row("Policy fee", Number(x.policy_fee), Number(y.policy_fee)),
    row("Surplus lines tax", Number(x.surplus_lines_tax), Number(y.surplus_lines_tax)),
    row("Total", Number(x.total), Number(y.total)),
  ];
  const bp = bridge ? Number(bridge.premium) : null;
  return {
    terms: termChanges(expiring, renewing),
    factors: factorChanges(x, y, bridge),
    money: moneyRows,
    bridge: {
      expiringPremium: Number(x.premium), renewingPremium: Number(y.premium),
      change: Number(y.premium) - Number(x.premium), pct: pct(Number(x.premium), Number(y.premium)),
      termsImpact: bp === null ? null : bp - Number(x.premium),
      ratesImpact: bp === null ? null : Number(y.premium) - bp,
      rateVersionFrom: x.rate_version, rateVersionTo: y.rate_version,
    },
    reasons: {
      terms: termReasons(expiring, renewing),
      schedule: scheduleReasons(expiring.schedule, renewing.schedule),
      rates: rateReasons(bridge, y),
    },
  };
}

/** One line for list rows and the memo's opening: "up 12.3% ($4,100)" / "unchanged". */
export function changeSummary(b: Bridge): string {
  if (b.change === 0) return "unchanged";
  return `${b.change > 0 ? "up" : "down"} ${Math.abs(b.pct ?? 0)}% (${signed(b.change)})`;
}
