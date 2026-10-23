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
export type Clearance = { by: string; at: string; note: string };

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

/** Seed rating inputs from the reviewed submission; unknowns get neutral defaults. */
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
    residential_pct: num(ops.residential_pct, 0),
    subcontracted_pct: num(ops.subcontracted_pct, 0),
    subcontractor_coi_required: typeof ops.subcontractor_coi_required === "boolean" ? ops.subcontractor_coi_required : true,
    max_height_ft: num(ops.max_height_ft, 0),
    experience_mod: 1,
  };
}

export function parseInputs(form: Record<string, string>): RatingInputs {
  const out = {} as Record<string, unknown>;
  for (const def of INPUT_DEFS) {
    const raw = (form[def.key] ?? "").trim();
    const label = def.label;
    switch (def.kind) {
      case "text":
        if (!raw) throw new Error(`${label} is required`);
        out[def.key] = raw;
        break;
      case "state":
        if (!/^[A-Za-z]{2}$/.test(raw)) throw new Error(`${label}: use a 2-letter state code`);
        out[def.key] = raw.toUpperCase();
        break;
      case "states": {
        const states = raw.split(/[\s,;/]+/).filter(Boolean).map((s) => s.toUpperCase());
        if (!states.length || !states.every((s) => /^[A-Z]{2}$/.test(s))) throw new Error(`${label}: use 2-letter state codes`);
        out[def.key] = [...new Set(states)];
        break;
      }
      case "bool":
        out[def.key] = raw === "yes";
        break;
      case "mod": {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}: enter a factor like 0.95 or 1.10`);
        out[def.key] = n;
        break;
      }
      default: {
        const n = Number(raw.replace(/[$,%\s]/g, ""));
        if (!raw || !Number.isFinite(n) || n < 0) throw new Error(`${label}: "${raw}" is not a number`);
        if (def.kind === "pct" && n > 100) throw new Error(`${label}: must be 0–100`);
        out[def.key] = Math.round(n);
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
      throw new Error(`${c.label}: enter a whole percent between -${MAX_CATEGORY_PCT} (credit) and +${MAX_CATEGORY_PCT} (debit)`);
    }
    if (pct !== 0 && rationale.length < 10) throw new Error(`${c.label}: write a reason for the ${pct < 0 ? "credit" : "debit"}`);
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
