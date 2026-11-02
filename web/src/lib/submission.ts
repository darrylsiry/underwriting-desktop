// The canonical submission schema (see samples/README.md and the ingestion
// service's app/schema.py) plus helpers for the intake review screen.
import { isIsoDate } from "./time.ts";

export type FieldType = "str" | "state" | "states" | "int" | "money" | "pct" | "bool" | "date";
export type FieldDef = { path: string; label: string; type: FieldType };

export const SECTIONS: { key: string; title: string; fields: FieldDef[] }[] = [
  { key: "applicant", title: "Applicant", fields: [
    { path: "applicant.name", label: "Named insured", type: "str" },
    { path: "applicant.dba", label: "DBA", type: "str" },
    { path: "applicant.street", label: "Street", type: "str" },
    { path: "applicant.city", label: "City", type: "str" },
    { path: "applicant.state", label: "State", type: "state" },
    { path: "applicant.zip", label: "ZIP", type: "str" },
    { path: "applicant.fein", label: "FEIN", type: "str" },
    { path: "applicant.entity_type", label: "Entity type", type: "str" },
    { path: "applicant.years_in_business", label: "Years in business", type: "int" },
    { path: "applicant.website", label: "Website", type: "str" },
  ] },
  { key: "operations", title: "Operations", fields: [
    { path: "operations.description", label: "Description", type: "str" },
    { path: "operations.class_code", label: "Class code", type: "str" },
    { path: "operations.states", label: "States of operation", type: "states" },
    { path: "operations.gross_receipts", label: "Gross receipts", type: "money" },
    { path: "operations.payroll", label: "Payroll", type: "money" },
    { path: "operations.employees", label: "Employees", type: "int" },
    { path: "operations.subcontracted_pct", label: "Subcontracted %", type: "pct" },
    { path: "operations.subcontractor_coi_required", label: "COIs required from subs", type: "bool" },
    { path: "operations.residential_pct", label: "Residential %", type: "pct" },
    { path: "operations.new_construction_pct", label: "New construction %", type: "pct" },
    { path: "operations.max_height_ft", label: "Max height (ft)", type: "int" },
    { path: "operations.wrap_up_projects", label: "Wrap-up projects", type: "bool" },
  ] },
  { key: "policy", title: "Coverage requested", fields: [
    { path: "policy.effective_date", label: "Effective", type: "date" },
    { path: "policy.expiration_date", label: "Expiration", type: "date" },
    { path: "policy.occurrence_limit", label: "Each occurrence", type: "money" },
    { path: "policy.aggregate_limit", label: "General aggregate", type: "money" },
    { path: "policy.products_aggregate_limit", label: "Products-completed ops agg.", type: "money" },
    { path: "policy.deductible", label: "Deductible", type: "money" },
  ] },
  { key: "producer", title: "Producer", fields: [
    { path: "producer.agency", label: "Agency", type: "str" },
    { path: "producer.contact", label: "Contact", type: "str" },
    { path: "producer.email", label: "Email", type: "str" },
    { path: "producer.phone", label: "Phone", type: "str" },
  ] },
  { key: "prior", title: "Prior insurance", fields: [
    { path: "prior.carrier", label: "Prior carrier", type: "str" },
    { path: "prior.premium", label: "Prior premium", type: "money" },
  ] },
];

export const FIELD_DEFS = SECTIONS.flatMap((s) => s.fields);

/** Fields the rating service needs (matches REQUIRED_FOR_RATING in ingestion). */
export const REQUIRED_FOR_RATING = [
  "operations.class_code", "operations.gross_receipts", "operations.states", "applicant.state",
  "policy.occurrence_limit", "policy.aggregate_limit",
];

export type Value = string | number | boolean | string[] | null;
export type Loss = { date: string; description: string; incurred: number; status: string };
export type SubmissionData = Record<string, Record<string, Value>> & { loss_history: Loss[] };

export type FieldMeta = {
  value: Value;
  confidence: number;
  method: "form_field" | "claude";
  basis: "stated" | "inferred";
  source_document: string;
  snippet: string;
};

export type Extraction = {
  submission: SubmissionData;
  fields: Record<string, FieldMeta>;
  conflicts: { path: string; chosen: Value; others: { value: Value; source_document: string; method: string }[] }[];
  missing_for_rating: string[];
  documents: { filename: string; doc_type: string; parent: string | null; method: string }[];
  notes: string[];
  warnings: string[];
  claude: { model: string; usage: { input_tokens: number; output_tokens: number } } | null;
};

export function getPath(data: SubmissionData, path: string): Value {
  const [section, name] = path.split(".");
  return (data[section] as Record<string, Value> | undefined)?.[name] ?? null;
}

export function setPath(data: SubmissionData, path: string, value: Value): void {
  const [section, name] = path.split(".");
  (data[section] as Record<string, Value>)[name] = value;
}

export function isEmpty(v: Value): boolean {
  return v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Text shown in an input for a stored value. */
export function toInput(type: FieldType, v: Value): string {
  if (isEmpty(v)) return "";
  if (type === "states") return (v as string[]).join(", ");
  if (type === "bool") return v ? "yes" : "no";
  return String(v);
}

/** Parse what the underwriter typed back into the schema type; throws with a readable message. */
export function fromInput(def: FieldDef, raw: string): Value {
  const text = raw.trim();
  if (!text) return def.type === "str" ? "" : null;
  switch (def.type) {
    case "str":
      return text;
    case "state":
      if (!/^[A-Za-z]{2}$/.test(text)) throw new Error(`${def.label}: use a 2-letter state code`);
      return text.toUpperCase();
    case "states": {
      const states = text.split(/[\s,;/]+/).filter(Boolean).map((s) => s.toUpperCase());
      if (!states.every((s) => /^[A-Z]{2}$/.test(s))) throw new Error(`${def.label}: use 2-letter state codes`);
      return [...new Set(states)];
    }
    case "int":
    case "money":
    case "pct": {
      const n = Number(text.replace(/[$,%\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${def.label}: "${text}" is not a number`);
      if (def.type === "pct" && n > 100) throw new Error(`${def.label}: must be 0–100`);
      return Math.round(n);
    }
    case "bool":
      if (/^(y|yes|true)$/i.test(text)) return true;
      if (/^(n|no|false)$/i.test(text)) return false;
      throw new Error(`${def.label}: answer yes or no`);
    case "date":
      if (!isIsoDate(text)) throw new Error(`${def.label}: use YYYY-MM-DD`);
      return text;
  }
}

export function sameValue(a: Value, b: Value): boolean {
  return JSON.stringify(isEmpty(a) ? null : a) === JSON.stringify(isEmpty(b) ? null : b);
}

/** Why a field deserves the underwriter's attention, or null if it looks fine. */
export function attention(path: string, value: Value, meta: FieldMeta | undefined, conflicted: boolean): string | null {
  if (isEmpty(value)) return REQUIRED_FOR_RATING.includes(path) ? "Required for rating" : null;
  if (conflicted) return "Documents disagree";
  if (!meta) return null;
  if (meta.basis === "inferred") return "Inferred, not stated";
  if (meta.confidence < 0.9) return "Low confidence";
  return null;
}

export function formatValue(type: FieldType, v: Value): string {
  if (isEmpty(v)) return "—";
  if (type === "money") return `$${Number(v).toLocaleString("en-US")}`;
  if (type === "pct") return `${v}%`;
  return toInput(type, v);
}
