import type { Closure } from "./file-closure";
import { isUuid } from "./text.ts";
import { todayIso, whenDate } from "./time.ts";
import { audit } from "./audit";
import { bindBlockers, policyNumbers, subjectivityStatus, type SubjectivityStatus } from "./bind-rules";
import { customerDb, policyDb } from "./db";
import { accountingPeriod } from "./gl-journal";
import { postPolicyBound } from "./ledger";
import { renderBinderPdf, renderPolicyPdf, type PolicyDocument } from "./policy-pdf";
import { producerOf, type ProducerFields } from "./quote-terms";
import { wrongStatus } from "./submission";
import type { ExpiringPolicy } from "./renewal-compare";
import type { RatingInputs } from "./worksheet";
import { money, type Rating } from "./worksheets";

export type PolicyRow = {
  id: string; policy_number: string; binder_number: string; status: string; quote_id: string;
  quote_number: string; quote_version: number; submission_id: string; insured_id: string | null; insured_name: string;   // UX-013: lists link the insured
  effective_date: string; expiration_date: string; premium: string; policy_fee: string;
  surplus_lines_tax: string; total: string; subjectivities: SubjectivityStatus[];
  bound_by: string; bound_at: Date;
  renewal_status: "not_started" | "in_progress" | "renewed" | "non_renewed"; renewal_submission_id: string | null;
  renewed_from: { source: "book" | "desktop"; policy_id: string; policy_number: string } | null;
  non_renewal: Closure | null;
};

const COLUMNS = `p.id, p.policy_number, p.binder_number, p.status, p.quote_id, q.quote_number, q.version AS quote_version,
  p.submission_id, p.insured_id, p.insured_name, p.effective_date::text, p.expiration_date::text, p.premium, p.policy_fee,
  p.surplus_lines_tax, p.total, p.subjectivities, p.bound_by, p.bound_at, p.renewal_status, p.renewal_submission_id, p.renewed_from, p.non_renewal`;

export async function policiesForSubmission(submissionId: string): Promise<PolicyRow[]> {
  const { rows } = await policyDb.query<PolicyRow>(
    `SELECT ${COLUMNS} FROM policies p JOIN quotes q ON q.id = p.quote_id WHERE p.submission_id = $1`, [submissionId]);
  return rows;
}

/** What the policy covers, frozen on the quote it was bound from (UX-014). */
export type PolicyTerms = {
  terms: { limits: { label: string; amount: number }[]; deductible: number; class_code: string; class_description: string; operations: string; forms: string[]; producer?: string[]; producer_fields?: ProducerFields };
  rating_inputs: RatingInputs;
};

export async function getPolicy(id: string): Promise<(PolicyRow & PolicyTerms) | null> {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<PolicyRow & PolicyTerms>(
    `SELECT ${COLUMNS}, q.terms, q.rating_inputs FROM policies p JOIN quotes q ON q.id = p.quote_id WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}

export type PolicyFilter = { submissionIds?: string[] | null; inForce?: boolean; newBusiness?: boolean };

/**
 * Bound policies, newest first; optionally only those from given submissions, those in force today
 * (effective and unexpired), and/or the desk's new business (unexpired and not a renewal).
 */
export async function listPolicies(f: PolicyFilter = {}): Promise<PolicyRow[]> {
  const { rows } = await policyDb.query<PolicyRow>(
    `SELECT ${COLUMNS} FROM policies p JOIN quotes q ON q.id = p.quote_id
     WHERE ($1::text[] IS NULL OR p.submission_id::text = ANY($1))
       AND ($2::boolean IS NOT TRUE OR (p.effective_date <= $4::date AND p.expiration_date > $4::date))
       AND ($3::boolean IS NOT TRUE OR (p.renewed_from IS NULL AND p.expiration_date >= $4::date))
     ORDER BY p.bound_at DESC`, [f.submissionIds ?? null, f.inForce ?? false, f.newBusiness ?? false, todayIso()]);
  return rows;
}

export async function getPolicyDocument(id: string, kind: "binder" | "policy") {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<{ filename: string; pdf: Buffer }>(
    kind === "binder"
      ? "SELECT binder_number || '.pdf' AS filename, binder_pdf AS pdf FROM policies WHERE id = $1"
      : "SELECT policy_number || '.pdf' AS filename, policy_pdf AS pdf FROM policies WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

type QuoteForBinding = {
  id: string; quote_number: string; version: number; status: string; submission_id: string; submission_ref: string;
  insured_id: string | null; insured_name: string; effective_date: string; expiration_date: string; valid_until: string;
  rating_inputs: RatingInputs; rating: Rating; premium: string; policy_fee: string; surplus_lines_tax: string; total: string;
  subjectivities: string[];
  terms: { insured_address: string[]; producer: string[]; producer_fields?: ProducerFields; limits: { label: string; amount: number }[]; deductible: number;
    class_code: string; class_description: string; operations: string; forms: string[] };
};

/**
 * Bind an issued quote on its quoted terms (no re-rating). Subjectivities not marked received
 * stay open on the binder with a due date. `at` back-dates the bind (seeded history): the policy,
 * its ledger journal and its audit events all carry that time.
 */
export async function bindQuote(quoteId: string, received: Set<number>, actor: string, at: Date | null = null): Promise<PolicyRow> {
  const boundAt = at ?? new Date();
  const today = todayIso(boundAt);
  const correlationId = crypto.randomUUID();   // shared by the bind's audit events and its ledger journal
  const client = await policyDb.connect();
  let policyId: string;
  let q: QuoteForBinding;
  try {
    await client.query("BEGIN");
    // Lock the quote so two clicks can't bind it twice.
    const found = (await client.query<QuoteForBinding>(
      `SELECT id, quote_number, version, status, submission_id, submission_ref, insured_id, insured_name,
              effective_date::text, expiration_date::text, valid_until::text, rating_inputs, rating,
              premium, policy_fee, surplus_lines_tax, total, subjectivities, terms
       FROM quotes WHERE id = $1 FOR UPDATE`, [quoteId])).rows[0];
    if (!found) throw new Error("Quote not found");
    q = found;
    // After the quote's lock: a reopen holds these locks while it commits, so a bind waiting here then finds the file in review (CR-182).
    const file = (await customerDb.query<{ status: string; kind: string; renewal_of: ExpiringPolicy | null }>(
      "SELECT status, kind, renewal_of FROM submissions WHERE id = $1", [q.submission_id])).rows[0];
    if (file && file.status !== "accepted") throw new Error(wrongStatus(q.submission_ref, file.status, "accepted"));
    const renewedFrom = file?.kind === "renewal" ? file.renewal_of : null;
    const blockers = bindBlockers(q, today);
    if (blockers.length) throw new Error(blockers.join("; "));

    const seq = Number((await client.query<{ n: string }>("SELECT nextval('policy_number_seq') AS n")).rows[0].n);
    const numbers = policyNumbers(seq, Number(q.effective_date.slice(0, 4)));
    const subjectivities = subjectivityStatus(q.subjectivities, received, today);
    const doc: PolicyDocument = {
      policyNumber: numbers.policy, binderNumber: numbers.binder, quoteNumber: q.quote_number, quoteVersion: q.version,
      boundAt, boundBy: actor, insuredName: q.insured_name, insuredAddress: q.terms.insured_address, producer: q.terms.producer,
      effectiveDate: q.effective_date, expirationDate: q.expiration_date, limits: q.terms.limits, deductible: q.terms.deductible,
      classCode: q.terms.class_code, classDescription: q.terms.class_description, operations: q.terms.operations,
      states: q.rating_inputs.states, grossReceipts: q.rating_inputs.gross_receipts,
      premium: Number(q.premium), policyFee: Number(q.policy_fee), surplusLinesTax: Number(q.surplus_lines_tax),
      surplusLinesTaxRate: Number(q.rating.surplus_lines_tax_rate), homeState: q.rating_inputs.home_state,
      total: Number(q.total), rateVersion: q.rating.rate_version, subjectivities, forms: q.terms.forms,
    };
    const [binderPdf, policyPdf] = await Promise.all([renderBinderPdf(doc), renderPolicyPdf(doc)]);

    policyId = (await client.query<{ id: string }>(
      `INSERT INTO policies (policy_number, binder_number, quote_id, submission_id, insured_id, insured_name,
         effective_date, expiration_date, premium, policy_fee, surplus_lines_tax, total, subjectivities,
         binder_pdf, policy_pdf, bound_by, bound_at, renewed_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [numbers.policy, numbers.binder, q.id, q.submission_id, q.insured_id, q.insured_name, q.effective_date,
       q.expiration_date, q.premium, q.policy_fee, q.surplus_lines_tax, q.total, JSON.stringify(subjectivities),
       Buffer.from(binderPdf), Buffer.from(policyPdf), actor, boundAt,
       renewedFrom ? { source: renewedFrom.source, policy_id: renewedFrom.policy_id, policy_number: renewedFrom.policy_number } : null],
    )).rows[0].id;
    await client.query("UPDATE quotes SET status = 'bound' WHERE id = $1", [q.id]);
    let renewalWas: string | undefined;
    if (renewedFrom) {  // the expiring policy is now renewed
      const table = renewedFrom.source === "book" ? "book_policies" : "policies";
      renewalWas = (await client.query<{ renewal_status: string }>(`SELECT renewal_status FROM ${table} WHERE id = $1 FOR UPDATE`, [renewedFrom.policy_id])).rows[0]?.renewal_status;
      await client.query(`UPDATE ${table} SET renewal_status = 'renewed' WHERE id = $1`, [renewedFrom.policy_id]);
    }
    // Book the premium to the sub-ledger in the same transaction: no bound policy without its journal.
    const journal = await postPolicyBound(client, {
      policyId, policyNumber: numbers.policy, insuredName: q.insured_name, effectiveDate: q.effective_date, expirationDate: q.expiration_date,
      quoteRef: `${q.quote_number} v${q.version}`, submissionId: q.submission_id, submissionRef: q.submission_ref,
      underwriter: actor, producer: producerOf(q.terms).agency, transactionType: renewedFrom ? "renewal" : "new_business",
      amounts: q, postedAt: boundAt, correlationId,
    });
    const open = doc.subjectivities.filter((s) => s.status === "open");
    // In the transaction, so a policy and its journal can't exist without their trail (CR-034).
    await audit([
      {
        actor, action: "quote.bound", entityType: "quote", entityId: q.id,
        summary: `${q.quote_number} v${q.version} bound as ${doc.policyNumber}`, before: { status: "issued" }, after: { status: "bound" },
        correlationId, occurredAt: at ?? undefined,
      },
      {
        actor, action: "policy.bound", entityType: "policy", entityId: policyId,
        summary: `${doc.policyNumber} bound for ${q.insured_name}: ${money(q.total)}, effective ${whenDate(q.effective_date)}`
          + (open.length ? `, ${open.length} open subjectivit${open.length === 1 ? "y" : "ies"}` : ""),
        after: { quote_id: q.id, binder_number: doc.binderNumber, total: q.total, subjectivities: doc.subjectivities }, correlationId, occurredAt: at ?? undefined,
      },
      {
        actor, action: "policy.bound", entityType: "submission", entityId: q.submission_id,
        summary: `${q.submission_ref}: bound as ${doc.policyNumber} (${q.quote_number} v${q.version}, ${money(q.total)})${renewedFrom ? `, renewing ${renewedFrom.policy_number}` : ""}`, correlationId, occurredAt: at ?? undefined,
      },
      {
        actor, action: "gl.posted", entityType: "policy", entityId: policyId,
        summary: `${journal.journal_no}: ${money(q.total)} booked to the premium sub-ledger for ${doc.policyNumber} (${renewedFrom ? "renewal" : "new business"}, period ${accountingPeriod(boundAt)})`,
        after: { journal_no: journal.journal_no, lines: journal.lines.map((l) => ({ account: l.account_code, debit: l.debit, credit: l.credit })) }, correlationId, occurredAt: at ?? undefined,
      },
      // The expiring policy's own trail, which renewal.started began (CR-140).
      ...(renewedFrom ? [{
        actor, action: "renewal.completed", entityType: renewedFrom.source === "book" ? "book_policy" as const : "policy" as const, entityId: renewedFrom.policy_id,
        summary: `${renewedFrom.policy_number}: renewed as ${doc.policyNumber}`, before: { renewal_status: renewalWas }, after: { renewal_status: "renewed", renewal_policy: doc.policyNumber },
        correlationId, occurredAt: at ?? undefined,
      }] : []),
    ], client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return (await policiesForSubmission(q.submission_id)).find((p) => p.id === policyId)!;
}
