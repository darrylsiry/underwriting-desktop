// Quote terms that don't need the database: suggested subjectivities and dates.
// Pure module (type-only imports) so node:test can load it.
import { ROOFING_CLASSES, lossRunYears, type Flag } from "./referrals.ts";   // .ts so node:test can load this pure module too
import { isIsoDate, type SubmissionData } from "./submission.ts";
import { whenDate } from "./time.ts";
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

/**
 * The policy period from a quote form, or an error starting with the field's name (the forms put it
 * under that input). Rating has no term input and nothing pro-rates, so a quote's premium is for
 * twelve months and the period must be one year (CR-113). Runs before anything is rated (CR-019).
 */
export function quotePeriod(form: { effective_date: string; expiration_date: string }): { effective: string; expiration: string } {
  const effective = form.effective_date.trim();
  if (!isIsoDate(effective)) throw new Error("Effective date: use YYYY-MM-DD");
  const oneYear = addYears(effective, 1);
  const expiration = form.expiration_date.trim() || oneYear;
  if (!isIsoDate(expiration)) throw new Error("Expiration: use YYYY-MM-DD");
  if (expiration !== oneYear) throw new Error(`Expiration must be ${whenDate(oneYear)}: policies are written for one year from the effective date`);
  return { effective, expiration };
}

/** The limits a quote prints. All of them come from the worksheet: the underwriter sees and rates these, not the broker's request (CR-024). */
export function quoteLimits(inputs: Pick<RatingInputs, "occurrence_limit" | "aggregate_limit">): { label: string; amount: number }[] {
  return [
    { label: "Each occurrence", amount: inputs.occurrence_limit },
    { label: "General aggregate", amount: inputs.aggregate_limit },
    { label: "Products-completed operations aggregate", amount: inputs.aggregate_limit },
  ];
}

/** Who the producer is, by name. Stored beside the display lines, which drop blanks and so can't be read by position (CR-125). */
export type ProducerFields = { agency: string; contact: string; email: string; phone: string };

export function producerFields(p: Record<string, unknown>): ProducerFields {
  const text = (v: unknown) => String(v ?? "").trim();
  return { agency: text(p.agency), contact: text(p.contact), email: text(p.email), phone: text(p.phone) };
}

/** The producer block as a PDF prints it. */
export function producerLines(f: ProducerFields): string[] {
  return [f.agency, f.contact, f.email, f.phone].filter(Boolean);   // CR-118: one line each, so a long email can't push the phone off the page
}

/** The named producer on a frozen quote or expiring policy. Rows from before CR-125 have only the display lines, read by position. */
export function producerOf(t: { producer?: string[]; producer_fields?: ProducerFields }): ProducerFields {
  return t.producer_fields ?? { agency: t.producer?.[0] ?? "", contact: t.producer?.[1] ?? "", email: "", phone: "" };
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
