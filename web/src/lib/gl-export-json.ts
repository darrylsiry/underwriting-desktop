// The JSON form of a sub-ledger push: journals with their policy details and lines, plus the
// batch, filter and totals a GL import can reconcile against. Pure module for node:test.

export type JsonLine = { line_no: number; account_code: string; account_name: string; debit: number | string; credit: number | string };
export type JsonJournal = {
  journal_no: string; posted_at: Date | string; accounting_period: string; transaction_type: string; description: string;
  policy_id: string; policy_number: string; insured_name: string; effective_date: string; expiration_date: string;
  quote_ref: string; submission_id: string; submission_ref: string; underwriter: string; producer: string;
  source_action: string; correlation_id: string; export_batch: string | null; lines: JsonLine[];
};
export type JsonTotals = { journals: number; debit: number; credit: number; premium: number; fee: number; tax: number; receivable: number };
export type JsonMeta = {
  batch: string; generatedAt: Date; generatedBy: string; origin: string; timeZone: string;
  from: string | null; to: string | null; transactionType: string | null;
};

const num = (v: number | string) => Math.round(Number(v) * 100) / 100;
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

export function ledgerJson(journals: JsonJournal[], totals: JsonTotals, meta: JsonMeta): string {
  const doc = {
    source: "Underwriting Desktop premium sub-ledger",
    basis: "Premium booked in full when the policy is bound; cash collection and earning are not reflected",
    batch: meta.batch,
    generated_at: meta.generatedAt.toISOString(),
    generated_by: meta.generatedBy,
    time_zone: meta.timeZone,
    filter: { posting_date_from: meta.from, posting_date_to: meta.to, transaction_type: meta.transactionType },
    totals: {
      journals: totals.journals, lines: journals.reduce((n, j) => n + j.lines.length, 0),
      debit: num(totals.debit), credit: num(totals.credit),
      written_premium: num(totals.premium), policy_fees: num(totals.fee), surplus_lines_tax: num(totals.tax), premiums_receivable: num(totals.receivable),
    },
    journals: journals.map((j) => ({
      journal_no: j.journal_no,
      posted_at: iso(j.posted_at),
      accounting_period: j.accounting_period,
      transaction_type: j.transaction_type,
      description: j.description,
      export_batch: j.export_batch ?? meta.batch,
      policy: {
        number: j.policy_number, insured: j.insured_name, effective_date: j.effective_date, expiration_date: j.expiration_date,
        quote: j.quote_ref, submission: j.submission_ref, underwriter: j.underwriter, producer: j.producer,
        url: `${meta.origin}/policies/${j.policy_id}`,
      },
      source: {
        action: j.source_action, correlation_id: j.correlation_id,
        audit_url: `${meta.origin}/audit?submission=${j.submission_id}&correlation=${j.correlation_id}`,
      },
      lines: j.lines.map((l) => ({
        line_no: l.line_no, account_code: l.account_code, account_name: l.account_name, debit: num(l.debit), credit: num(l.credit),
      })),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}
