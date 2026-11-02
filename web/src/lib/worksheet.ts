// The underwriting worksheet: rating inputs (the rating service's RatingInput),
// schedule credits/debits with written reasons, and helpers to build and parse them.
// Pure module (type-only imports) so node:test can load it directly.
import type { SubmissionData } from "./submission";

export type RatingInputs = {
  class_code: string;
  gross_receipts: number;
  states: string[];
  home_state: string;
  occurrence_limit: number;
  aggregate_limit: number;
  deductible: number;
  residential_pct: number;
  subcontracted_pct: number;
  subcontractor_coi_required: boolean;
  max_height_ft: number;
  experience_mod: number;
};

export type ScheduleItem = { category: string; pct: number; rationale: string };
/** `detail` is the flag text that was cleared; older clearances (before CR-005) have none. */
export type Clearance = { by: string; at: string; note: string; detail?: string };

/** Schedule rating categories (IRPM-style). Each allows a credit or debit up to MAX_CATEGORY_PCT. */
export const SCHEDULE_CATEGORIES = [
  { key: "management", label: "Management experience" },
  { key: "safety", label: "Safety program & training" },
  { key: "subcontractor_controls", label: "Subcontractor controls (COIs, contracts)" },
  { key: "equipment", label: "Equipment & premises" },
  { key: "loss_experience", label: "Loss experience not reflected in mods" },
  { key: "classification", label: "Classification peculiarities" },
] as const;
export const MAX_CATEGORY_PCT = 10;
/** Total schedule beyond this needs a referral (rating itself allows ±25%). */
export const UW_AUTHORITY_PCT = 15;

export const INPUT_DEFS: { key: keyof RatingInputs; label: string; kind: "text" | "money" | "pct" | "int" | "states" | "state" | "bool" | "mod" }[] = [
  { key: "class_code", label: "Class code", kind: "text" },
  { key: "gross_receipts", label: "Gross receipts", kind: "money" },
  { key: "states", label: "States of operation", kind: "states" },
  { key: "home_state", label: "Home state (SL tax)", kind: "state" },
  { key: "occurrence_limit", label: "Each occurrence", kind: "money" },
  { key: "aggregate_limit", label: "General aggregate", kind: "money" },
  { key: "deductible", label: "Deductible", kind: "money" },
  { key: "residential_pct", label: "Residential %", kind: "pct" },
  { key: "subcontracted_pct", label: "Subcontracted %", kind: "pct" },
  { key: "subcontractor_coi_required", label: "COIs required from subs", kind: "bool" },
  { key: "max_height_ft", label: "Max height (ft)", kind: "int" },
  { key: "experience_mod", label: "Experience mod", kind: "mod" },
];

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A validation error that names the form field it is about, so the form can show it under that input (UX-001). */
export class FieldError extends Error {
  readonly field: string;   // a plain property: node's strip-only TS mode (the tests) has no parameter properties
  constructor(message: string, field: string) {
    super(message);
    this.name = "FieldError";
    this.field = field;
  }
}

/**
 * What the worksheet assumes for an operations input the broker never stated. Each is the
 * lowest-rated band rather than a neutral value, so `referralFlags` warns while one is in use (CR-112).
 */
export const ASSUMED_INPUTS = { max_height_ft: 0, subcontracted_pct: 0, residential_pct: 0, subcontractor_coi_required: true } as const;

/** Seed rating inputs from the reviewed submission; unknowns get the assumptions above. */
export function inputsFromSubmission(data: SubmissionData): RatingInputs {
  const ops = data.operations ?? {};
  const pol = data.policy ?? {};
  return {
    class_code: String(ops.class_code ?? ""),
    gross_receipts: num(ops.gross_receipts, 0),
    states: Array.isArray(ops.states) ? (ops.states as string[]) : [],
    home_state: String(data.applicant?.state ?? ""),
    occurrence_limit: num(pol.occurrence_limit, 1_000_000),
    aggregate_limit: num(pol.aggregate_limit, 2_000_000),
    deductible: num(pol.deductible, 0),
    residential_pct: num(ops.residential_pct, ASSUMED_INPUTS.residential_pct),
    subcontracted_pct: num(ops.subcontracted_pct, ASSUMED_INPUTS.subcontracted_pct),
    subcontractor_coi_required: typeof ops.subcontractor_coi_required === "boolean" ? ops.subcontractor_coi_required : ASSUMED_INPUTS.subcontractor_coi_required,
    max_height_ft: num(ops.max_height_ft, ASSUMED_INPUTS.max_height_ft),
    experience_mod: 1,
  };
}

/** A factor with at most two decimals: 1, 0.95, .9, 1.10. */
const MOD_PATTERN = /^\d*\.?\d{0,2}$/;

export function parseInputs(form: Record<string, string>): RatingInputs {
  const out = {} as Record<string, unknown>;
  for (const def of INPUT_DEFS) {
    const raw = (form[def.key] ?? "").trim();
    const label = def.label;
    switch (def.kind) {
      case "text":
        if (!raw) throw new FieldError(`${label} is required`, def.key);
        out[def.key] = raw;
        break;
      case "state":
        if (!/^[A-Za-z]{2}$/.test(raw)) throw new FieldError(`${label}: use a 2-letter state code`, def.key);
        out[def.key] = raw.toUpperCase();
        break;
      case "states": {
        const states = raw.split(/[\s,;/]+/).filter(Boolean).map((s) => s.toUpperCase());
        if (!states.length || !states.every((s) => /^[A-Z]{2}$/.test(s))) throw new FieldError(`${label}: use 2-letter state codes`, def.key);
        out[def.key] = [...new Set(states)];
        break;
      }
      case "bool":
        out[def.key] = raw === "yes";
        break;
      case "mod": {
        // Two decimals everywhere: what's shown is what's rated, so a later save can't round it and move the premium (CR-104).
        const n = Number(raw);
        if (!MOD_PATTERN.test(raw) || !Number.isFinite(n) || n <= 0) throw new FieldError(`${label}: enter a factor with up to two decimals, like 0.95 or 1.10`, def.key);
        out[def.key] = n;
        break;
      }
      default: {
        // Formatted values are fine: the form shows "$2,300,000" and "100%" (UX-004).
        const n = Number(raw.replace(/[$,%\s]/g, ""));
        if (!raw || !Number.isFinite(n) || n < 0) throw new FieldError(`${label}: "${raw}" is not a number`, def.key);
        if (def.kind === "pct" && n > 100) throw new FieldError(`${label}: must be 0–100`, def.key);
        out[def.key] = Math.round(n);
        // Checked here so it lands under the field; the rating service would refuse it with a banner of raw validation (CR-130).
        if (def.key === "gross_receipts" && out[def.key] === 0) throw new FieldError(`${label} must be more than zero`, def.key);
      }
    }
  }
  return out as RatingInputs;
}

/** Read schedule rows from the form; any non-zero credit or debit needs a written reason. */
export function parseSchedule(form: Record<string, string>): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const c of SCHEDULE_CATEGORIES) {
    const raw = (form[`schedule.${c.key}.pct`] ?? "").trim() || "0";
    const pct = Number(raw.replace("%", ""));
    const rationale = (form[`schedule.${c.key}.rationale`] ?? "").trim();
    if (!Number.isInteger(pct) || Math.abs(pct) > MAX_CATEGORY_PCT) {
      throw new FieldError(`${c.label}: enter a whole percent between -${MAX_CATEGORY_PCT} (credit) and +${MAX_CATEGORY_PCT} (debit)`, `schedule.${c.key}.pct`);
    }
    if (pct !== 0 && rationale.length < 10) throw new FieldError(`${c.label}: write a reason for the ${pct < 0 ? "credit" : "debit"}`, `schedule.${c.key}.rationale`);
    if (pct !== 0) items.push({ category: c.key, pct, rationale });
  }
  return items;
}

export const scheduleTotal = (items: ScheduleItem[]) => items.reduce((sum, i) => sum + i.pct, 0);
export const scheduleMod = (items: ScheduleItem[]) => Math.round((1 + scheduleTotal(items) / 100) * 100) / 100;

/** Schedule in a fixed key order, for comparing a stored (jsonb, keys reordered) schedule with a parsed one. */
export function scheduleKey(schedule: ScheduleItem[]): string {
  return JSON.stringify(schedule.map((s) => [s.category, s.pct, s.rationale]));
}

/** Fingerprint of what a rating used. Fixed key order: jsonb doesn't preserve object key order. */
export function inputsHash(inputs: RatingInputs, schedule: ScheduleItem[]): string {
  return JSON.stringify([INPUT_DEFS.map((d) => inputs[d.key]), schedule.map((s) => [s.category, s.pct])]);
}

/** The unit shown beside a rating input (UX-004): `$` before money, `%` or `ft` after. */
export function inputUnit(def: (typeof INPUT_DEFS)[number]): "$" | "%" | "ft" | null {
  return def.kind === "money" ? "$" : def.kind === "pct" ? "%" : def.key === "max_height_ft" ? "ft" : null;
}

export type InputChange = { key: string; label: string; from: unknown; to: unknown };

/** What differs between two worksheets (UX-003): rating inputs by definition, then schedule categories by percent. */
export function inputChanges(a: { inputs: RatingInputs; schedule: ScheduleItem[] }, b: { inputs: RatingInputs; schedule: ScheduleItem[] }): InputChange[] {
  const out: InputChange[] = [];
  for (const d of INPUT_DEFS) {
    if (JSON.stringify(a.inputs[d.key]) !== JSON.stringify(b.inputs[d.key])) out.push({ key: d.key, label: d.label, from: a.inputs[d.key], to: b.inputs[d.key] });
  }
  const pct = (items: ScheduleItem[], key: string) => items.find((s) => s.category === key)?.pct ?? 0;
  for (const c of SCHEDULE_CATEGORIES) {
    const [from, to] = [pct(a.schedule, c.key), pct(b.schedule, c.key)];
    if (from !== to) out.push({ key: `schedule.${c.key}`, label: `${c.label} (schedule)`, from: `${from > 0 ? "+" : ""}${from}%`, to: `${to > 0 ? "+" : ""}${to}%` });
  }
  return out;
}

export type Chip = { label: string; tone: "done" | "action" | "attention" | "quiet" };

/**
 * The two header chips a file carries (UX-003): the commercial one persists (`Quoted · Q-… v1`,
 * `Bound · GL-…`), the worksheet one says where the rating stands. The workbench and the renewal
 * comparison both render this pair so the vocabulary is one.
 */
export function worksheetChips(f: {
  policyNumber?: string | null; quote?: { number: string; version: number } | null; quoteCurrent?: boolean;
  hasRating: boolean; rated: boolean; ready: boolean; openReferrals: number;
}): { commercial: Chip | null; worksheet: Chip | null } {
  const commercial: Chip | null = f.policyNumber ? { label: `Bound · ${f.policyNumber}`, tone: "done" }
    : f.quote ? { label: `Quoted · ${f.quote.number} v${f.quote.version}`, tone: "action" } : null;
  if (f.policyNumber) return { commercial, worksheet: null };
  const worksheet: Chip | null = !f.hasRating ? { label: "Not rated", tone: "quiet" }
    : !f.rated ? { label: "Rating out of date", tone: "attention" }
    : !f.ready ? { label: `${f.openReferrals} referral${f.openReferrals === 1 ? "" : "s"} open`, tone: "attention" }
    : f.quote && f.quoteCurrent ? null   // the quote says it: the worksheet is exactly what was quoted
    : f.quote ? { label: "Differs from quote", tone: "attention" }
    : { label: "Ready to quote", tone: "done" };
  return { commercial, worksheet };
}
