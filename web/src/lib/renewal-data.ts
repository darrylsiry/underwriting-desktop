// The canonical submission for a renewal, without the database. Pure module (type-only imports) for node:test.
import { addYears } from "./quote-terms.ts";
import type { ExpiringPolicy } from "./renewal-compare";
import type { SubmissionData, Value } from "./submission";

/** The canonical submission for a renewal: the expiring terms rolled forward one year. */
export function renewalSubmissionData(exp: ExpiringPolicy, original: SubmissionData | null, homeState: string): SubmissionData {
  const inputs = exp.rating_inputs;
  const base = original ?? ({ applicant: {}, producer: {}, policy: {}, operations: {}, prior: {}, loss_history: [] } as unknown as SubmissionData);
  const section = (name: string): Record<string, Value> => ({ ...(base[name] as Record<string, Value> | undefined) });
  return {
    applicant: { ...section("applicant"), name: exp.insured_name, state: homeState },
    producer: { ...section("producer"), agency: exp.producer[0] ?? "", contact: exp.producer[1] ?? "" },
    policy: {
      ...section("policy"),
      effective_date: exp.expiration_date, expiration_date: addYears(exp.expiration_date, 1),
      occurrence_limit: inputs.occurrence_limit, aggregate_limit: inputs.aggregate_limit,
      products_aggregate_limit: exp.terms.limits[2]?.amount ?? inputs.aggregate_limit, deductible: inputs.deductible,
    },
    operations: {
      ...section("operations"),
      description: exp.terms.operations, class_code: inputs.class_code, states: inputs.states,
      gross_receipts: inputs.gross_receipts, residential_pct: inputs.residential_pct, subcontracted_pct: inputs.subcontracted_pct,
      subcontractor_coi_required: inputs.subcontractor_coi_required, max_height_ft: inputs.max_height_ft,
    },
    prior: { carrier: "Underwriting Desktop Specialty", premium: exp.premium },
    loss_history: base.loss_history ?? [],
  } as unknown as SubmissionData;
}
