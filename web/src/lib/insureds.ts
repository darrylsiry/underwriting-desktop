import { customerDb, policyDb } from "./db";
import { isUuid } from "./text.ts";

export type InsuredRow = { id: string; name: string; fein: string; state: string; created_at: Date };
export type InsuredSummary = InsuredRow & { submissions: number; policies: number; written: number; open_subjectivities: number };

/** Customers with their book: submission count (customer DB) and policies and written premium (policy DB). */
export async function listInsureds(): Promise<InsuredSummary[]> {
  const [insureds, books] = await Promise.all([
    customerDb.query<InsuredRow & { submissions: number }>(
      `SELECT i.*, count(s.id)::int AS submissions FROM insureds i
       LEFT JOIN submissions s ON s.insured_id = i.id GROUP BY i.id ORDER BY i.name`),
    policyDb.query<{ insured_id: string; policies: number; written: string; open_subjectivities: number }>(
      `SELECT insured_id, count(*)::int AS policies, sum(premium) AS written,
              sum((SELECT count(*) FROM jsonb_array_elements(subjectivities) s WHERE s->>'status' = 'open'))::int AS open_subjectivities
       FROM policies WHERE insured_id IS NOT NULL GROUP BY insured_id`),
  ]);
  const byInsured = new Map(books.rows.map((b) => [b.insured_id, b]));
  return insureds.rows.map((i) => {
    const b = byInsured.get(i.id);
    return { ...i, policies: b?.policies ?? 0, written: Number(b?.written ?? 0), open_subjectivities: b?.open_subjectivities ?? 0 };
  });
}

export async function getInsured(id: string): Promise<InsuredRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await customerDb.query<InsuredRow>("SELECT * FROM insureds WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function submissionsForInsured(id: string) {
  const { rows } = await customerDb.query<{ id: string; reference: string; status: string; kind: string; received_by: string; received_at: Date; class_code: string | null; receipts: string | null }>(
    `SELECT id, reference, status, kind, received_by, received_at, data->'operations'->>'class_code' AS class_code,
            data->'operations'->>'gross_receipts' AS receipts
     FROM submissions WHERE insured_id = $1 ORDER BY received_at DESC`, [id]);
  return rows;
}

export async function quotesForInsured(id: string) {
  const { rows } = await policyDb.query<{ id: string; quote_number: string; version: number; status: string; total: string; effective_date: string; issued_at: Date }>(
    `SELECT id, quote_number, version, status, total, effective_date::text, issued_at
     FROM quotes WHERE insured_id = $1 ORDER BY issued_at DESC`, [id]);
  return rows;
}

export async function policiesForInsured(id: string) {
  const { rows } = await policyDb.query<{ id: string; policy_number: string; status: string; renewal_status: string; effective_date: string; expiration_date: string; premium: string; total: string; subjectivities: { status: string }[] }>(
    `SELECT id, policy_number, status, renewal_status, effective_date::text, expiration_date::text, premium, total, subjectivities
     FROM policies WHERE insured_id = $1 ORDER BY effective_date DESC`, [id]);
  return rows;
}
