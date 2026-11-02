// Quote terms that don't need the database: suggested subjectivities and dates.
// Pure module (type-only imports) so node:test can load it.
import { ROOFING_CLASSES, lossRunYears, type Flag } from "./referrals.ts";   // .ts so node:test can load this pure module too
import type { SubmissionData } from "./submission";
import type { RatingInputs } from "./worksheet";

export const QUOTE_VALID_DAYS = 30;

/** Conditions the broker must satisfy before binding, suggested from the file's gaps. */
export function suggestedSubjectivities(flags: Flag[], data: SubmissionData): string[] {
  const out = ["Signed and dated application"];
  const codes = new Set(flags.map((f) => f.code));
  if (codes.has("NO_LOSS_RUNS")) {
    const span = lossRunYears(data.applicant?.years_in_business);   // five years, or all of a younger business's years (CR-062)
    out.push(span === "5 years"
      ? "Five years of currently valued loss runs, satisfactory to the company"
      : `Currently valued loss runs for ${span}, satisfactory to the company`);
  }
  if (codes.has("CLASS_INFERRED")) out.push("Confirmation of operations and class code");
  if (codes.has("ASSUMED_INPUTS")) out.push("Confirmation of working height, subcontracted share and subcontractor certificates");
  if (codes.has("UNINSURED_SUBS") || codes.has("HEAVY_SUBCONTRACTING")) {
    out.push("Sample subcontract showing hold-harmless and additional insured requirements");
  }
  if (codes.has("NY_LABOR_LAW")) out.push("Executed contractual risk transfer for all NY projects (Labor Law 240/241)");
  if (codes.has("LARGE_OPEN_CLAIM") || codes.has("OPEN_CLAIMS_NO_DETAIL")) out.push("Current adjuster's status report on open claims");
  const missing = (["street", "zip", "fein"] as const).filter((k) => !String(data.applicant?.[k] ?? "").trim());
  if (missing.length) out.push(`Complete named insured details (${missing.join(", ").replace("fein", "FEIN")})`);
  return out;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addYears(isoDate: string, years: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export function parseSubjectivities(text: string): string[] {
  // Strip list markers ("1.", "2)", "-", "•") but not a leading number like "5 years".
  return text.split("\n").map((s) => s.trim().replace(/^(?:[-•*]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

/** Forms and endorsements listed on the quote (illustrative form names). */
export function formsFor(inputs: Pick<RatingInputs, "states" | "subcontracted_pct" | "residential_pct" | "class_code">): string[] {
  const forms = [
    "Commercial General Liability Coverage Form (occurrence)",
    "Classification Limitation Endorsement",
    "Total Pollution Exclusion",
    "Earth Movement / Subsidence Exclusion",
  ];
  if (inputs.subcontracted_pct > 0) forms.push("Independent Contractors Conditions (subcontractors must carry equal limits and name the insured)");
  if (inputs.residential_pct > 0) forms.push("Residential Construction Limitation (no new tract or condominium construction)");
  if (inputs.states.includes("NY")) forms.push("Action Over / Labor Law Exclusion (New York)");
  if (ROOFING_CLASSES.includes(inputs.class_code)) forms.push("Roofing Operations Endorsement (no hot tar or torch-down work)");
  return forms;
}
