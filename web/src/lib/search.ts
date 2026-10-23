import { customerDb, policyDb } from "./db";
import type { Query } from "./search-terms";

export type InsuredHit = { id: string; name: string; fein: string; state: string };
export type SubmissionHit = { id: string; reference: string; applicant_name: string; status: string; class_code: string | null; agency: string | null; received_at: Date };
export type QuoteHit = { id: string; quote_number: string; version: number; status: string; insured_name: string; submission_ref: string; total: string; issued_at: Date };
export type PolicyHit = { id: string; policy_number: string; binder_number: string; insured_name: string; effective_date: string; total: string };

export type SearchResults = { insureds: InsuredHit[]; submissions: SubmissionHit[]; quotes: QuoteHit[]; policies: PolicyHit[] };

const LIMIT = 25;

/**
 * One search box over both databases. Exact identifier matches sort first;
 * everything else is a case-insensitive substring match, newest first.
 */
export async function search(q: Query): Promise<SearchResults> {
  const [insureds, submissions, quotes, policies] = await Promise.all([
    customerDb.query<InsuredHit>(
      `SELECT id, name, fein, state FROM insureds
       WHERE name ILIKE $1 OR fein ILIKE $1
       ORDER BY (fein = $2) DESC, name LIMIT ${LIMIT}`, [q.like, q.text]),
    customerDb.query<SubmissionHit>(
      `SELECT id, reference, applicant_name, status, data->'operations'->>'class_code' AS class_code,
              data->'producer'->>'agency' AS agency, received_at
       FROM submissions
       WHERE reference ILIKE $1 OR applicant_name ILIKE $1 OR data->'producer'->>'agency' ILIKE $1
          OR data->'applicant'->>'fein' = $2 OR data->'operations'->>'class_code' = $2
       ORDER BY (upper(reference) = upper($2)) DESC, received_at DESC LIMIT ${LIMIT}`, [q.like, q.text]),
    policyDb.query<QuoteHit>(
      `SELECT id, quote_number, version, status, insured_name, submission_ref, total, issued_at
       FROM quotes
       WHERE quote_number || ' v' || version ILIKE $1 OR insured_name ILIKE $1 OR submission_ref ILIKE $1
       ORDER BY (upper(quote_number) = upper($2) OR upper(quote_number || ' v' || version) = upper($2)) DESC,
                issued_at DESC LIMIT ${LIMIT}`, [q.like, q.text]),
    policyDb.query<PolicyHit>(
      `SELECT id, policy_number, binder_number, insured_name, effective_date::text, total
       FROM policies
       WHERE policy_number ILIKE $1 OR binder_number ILIKE $1 OR insured_name ILIKE $1
       ORDER BY (upper(policy_number) = upper($2) OR upper(binder_number) = upper($2)) DESC, bound_at DESC
       LIMIT ${LIMIT}`, [q.like, q.text]),
  ]);
  return { insureds: insureds.rows, submissions: submissions.rows, quotes: quotes.rows, policies: policies.rows };
}

/** If the query is a full reference that matched exactly one record, where to send the user. */
export function directHit(q: Query, r: SearchResults): string | null {
  const t = q.text.toUpperCase();
  if (q.reference === "submission") {
    const s = r.submissions.filter((s) => s.reference.toUpperCase() === t);
    if (s.length === 1) return `/submissions/${s[0].id}`;
  }
  if (q.reference === "quote") {
    const hits = r.quotes.filter((x) => `${x.quote_number} v${x.version}`.toUpperCase() === t || x.quote_number.toUpperCase() === t);
    if (hits.length) return `/quotes/${hits[0].id}`; // newest version first
  }
  if (q.reference === "policy" || q.reference === "binder") {
    const p = r.policies.filter((p) => p.policy_number.toUpperCase() === t || p.binder_number.toUpperCase() === t);
    if (p.length === 1) return `/policies/${p[0].id}`;
  }
  return null;
}
