import { money } from "./format";
import { isUuid, paddedSeq } from "./text.ts";
import { whenDate } from "./time.ts";
import type { PoolClient } from "pg";
import { audit, type AuditEvent } from "./audit";
import { customerDb, policyDb } from "./db";
import { formsFor, quoteLimits, type ProducerFields } from "./quote-terms";
import { rateOn, rateVersionId } from "./rating-api";
import { claimsOnFile } from "./book-metrics.ts";
import type { ExpiringPolicy } from "./renewal-compare";
import { renewalSubmissionData } from "./renewal-data.ts";
import type { Extraction, SubmissionData } from "./submission";
import type { SubmissionRow } from "./submissions";
import type { RatingInputs, ScheduleItem } from "./worksheet";
import type { Rating } from "./worksheets";

// A renewal starts from a policy instead of broker documents: the expiring policy's rating inputs,
// schedule and rate version become a new submission of kind 'renewal' with an accepted intake and a
// worksheet already filled in, so the workbench, referrals, quotes, binding and audit all apply.

export type RenewalStatus = "not_started" | "in_progress" | "renewed" | "non_renewed";

/** A policy written in the prior policy system (book_policies). */
export type BookPolicyRow = {
  id: string; policy_number: string; insured_name: string; underwriter: string; class_code: string; class_description: string;
  states: string[]; home_state: string; producer: string; effective_date: string; expiration_date: string;
  premium: string; claims: number; incurred: string; open_claims: number; renewal_status: RenewalStatus;
  rating_inputs: RatingInputs | null; schedule: ScheduleItem[]; rate_version: string | null; renewal_submission_id: string | null;
};

export async function getBookPolicy(id: string): Promise<BookPolicyRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<BookPolicyRow>(
    `SELECT id, policy_number, insured_name, underwriter, class_code, class_description, states, home_state, producer,
            effective_date::text, expiration_date::text, premium, claims, incurred, open_claims, renewal_status,
            rating_inputs, schedule, rate_version, renewal_submission_id
     FROM book_policies WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** The expiring policy a renewal submission was started from (null for new business). */
export function expiringOf(sub: Pick<SubmissionRow, "kind" | "renewal_of">): ExpiringPolicy | null {
  return sub.kind === "renewal" && sub.renewal_of ? sub.renewal_of : null;
}

/** Snapshot of a prior-system policy: its premium is reproduced by rating its inputs on its rate version. */
export function expiringFromBook(p: BookPolicyRow, rating: Rating): ExpiringPolicy {
  const inputs = p.rating_inputs!;
  return {
    source: "book", policy_id: p.id, policy_number: p.policy_number, insured_name: p.insured_name, producer: [p.producer],
    effective_date: p.effective_date, expiration_date: p.expiration_date, rate_version: p.rate_version ?? rating.rate_version,
    rating_inputs: inputs, schedule: p.schedule ?? [], rating,
    premium: Number(rating.premium), policy_fee: Number(rating.policy_fee), surplus_lines_tax: Number(rating.surplus_lines_tax), total: Number(rating.total),
    terms: { limits: quoteLimits(inputs), deductible: inputs.deductible, class_code: p.class_code, class_description: p.class_description,
      operations: p.class_description, forms: formsFor(inputs) },
    losses: { claims: p.claims, incurred: Number(p.incurred), open_claims: p.open_claims },
  };
}

type DesktopPolicyForRenewal = {
  id: string; policy_number: string; insured_name: string; insured_id: string | null; submission_id: string;
  effective_date: string; expiration_date: string; premium: string; policy_fee: string; surplus_lines_tax: string; total: string;
  renewal_status: RenewalStatus; renewal_submission_id: string | null;
  quote_id: string; rate_version: string; rating_inputs: RatingInputs; schedule: ScheduleItem[]; rating: Rating;
  terms: ExpiringPolicy["terms"] & { producer: string[]; producer_fields?: ProducerFields };
};

async function desktopPolicyForRenewal(id: string): Promise<DesktopPolicyForRenewal | null> {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<DesktopPolicyForRenewal>(
    `SELECT p.id, p.policy_number, p.insured_name, p.insured_id, p.submission_id, p.effective_date::text, p.expiration_date::text,
            p.premium, p.policy_fee, p.surplus_lines_tax, p.total, p.renewal_status, p.renewal_submission_id,
            q.id AS quote_id, q.rate_version, q.rating_inputs, q.schedule, q.rating, q.terms
     FROM policies p JOIN quotes q ON q.id = p.quote_id WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Snapshot of a policy bound in the UW Desktop: everything is on its quote and the original submission. */
export function expiringFromDesktop(p: DesktopPolicyForRenewal, original: SubmissionData | null, originalRenewalOf: ExpiringPolicy | null = null): ExpiringPolicy {
  return {
    source: "desktop", policy_id: p.id, policy_number: p.policy_number, insured_name: p.insured_name, producer: p.terms.producer, producer_fields: p.terms.producer_fields,
    effective_date: p.effective_date, expiration_date: p.expiration_date, rate_version: p.rate_version,
    rating_inputs: p.rating_inputs, schedule: p.schedule, rating: p.rating,
    premium: Number(p.premium), policy_fee: Number(p.policy_fee), surplus_lines_tax: Number(p.surplus_lines_tax), total: Number(p.total),
    terms: { limits: p.terms.limits, deductible: p.terms.deductible, class_code: p.terms.class_code, class_description: p.terms.class_description,
      operations: p.terms.operations, forms: p.terms.forms },
    losses: claimsOnFile({ data: original, renewal_of: originalRenewalOf }),
    quote_id: p.quote_id,
  };
}

const EMPTY_EXTRACTION = (data: SubmissionData): Extraction => ({
  submission: data, fields: {}, conflicts: [], missing_for_rating: [], documents: [], notes: [], warnings: [], claude: null,
});

/**
 * The customer record for a policy with no FEIN to match on. Names aren't unique between companies, so
 * only an insured with the same name and state and no FEIN of its own is the same one (CR-111). The
 * lock, held until the caller's transaction ends, stops two renewals both creating it.
 */
async function insuredWithoutFein(name: string, state: string, client: { query: typeof customerDb.query }): Promise<{ id: string; created: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`insured:${name}:${state}`]);
  const found = (await client.query<{ id: string }>(
    "SELECT id FROM insureds WHERE name = $1 AND state = $2 AND fein = '' ORDER BY created_at LIMIT 1", [name, state])).rows[0];
  if (found) return { id: found.id, created: false };
  const made = (await client.query<{ id: string }>("INSERT INTO insureds (name, fein, state) VALUES ($1, '', $2) RETURNING id", [name, state])).rows[0];
  return { id: made.id, created: true };
}

/**
 * The renewal a policy points at, or null when that submission doesn't exist: a claim stranded by a failed
 * start from before CR-084, which 404ed for good. It's released here, on the record (CR-140), so the renewal can start again.
 */
async function liveRenewal(source: "book" | "desktop", policyId: string, policyNumber: string, submissionId: string | null, actor: string): Promise<string | null> {
  if (!submissionId) return null;
  if ((await customerDb.query("SELECT 1 FROM submissions WHERE id = $1", [submissionId])).rowCount) return submissionId;
  const client = await policyDb.connect();
  try {
    await client.query("BEGIN");
    const released = await client.query<{ renewal_status: string }>(
      `UPDATE ${source === "book" ? "book_policies" : "policies"} SET renewal_status = 'not_started', renewal_submission_id = NULL WHERE id = $1 AND renewal_submission_id = $2 RETURNING renewal_status`,
      [policyId, submissionId]);
    if (released.rowCount) {
      await audit([{
        actor, action: "renewal.released", entityType: source === "book" ? "book_policy" : "policy", entityId: policyId,
        summary: `${policyNumber}: renewal claim released, its submission ${submissionId} doesn't exist`,
        before: { renewal_status: "in_progress", renewal_submission_id: submissionId }, after: { renewal_status: "not_started", renewal_submission_id: null },
      }], client);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return null;
}

/**
 * Start (or resume) the renewal of a policy. Creates the renewal submission with its worksheet,
 * marks the policy in progress, and returns the submission id. Idempotent: a second click returns
 * the renewal that already exists.
 */
export async function startRenewal(source: "book" | "desktop", policyId: string, actor: string): Promise<{ submissionId: string; created: boolean }> {
  let exp: ExpiringPolicy;
  let original: SubmissionData | null = null;
  let homeState: string;
  let insuredId: string | null = null;
  let existing: string | null;
  const table = source === "book" ? "book_policies" : "policies";

  if (source === "book") {
    const p = await getBookPolicy(policyId);
    if (!p) throw new Error("Policy not found");
    existing = await liveRenewal(source, policyId, p.policy_number, p.renewal_submission_id, actor);
    if (!existing) {
      if (!p.rating_inputs) throw new Error(`${p.policy_number} has no rating inputs on file; it can't be re-rated`);
      const versionId = await rateVersionId(p.rate_version ?? "");
      if (!versionId) throw new Error(`Rate version ${p.rate_version} isn't in the rating service, so the expiring premium can't be reproduced`);
      const rating = await rateOn(p.rating_inputs, p.schedule ?? [], versionId, `${p.policy_number} expiring`, actor);
      exp = expiringFromBook(p, rating);
      homeState = p.home_state;
    }
  } else {
    const p = await desktopPolicyForRenewal(policyId);
    if (!p) throw new Error("Policy not found");
    existing = await liveRenewal(source, policyId, p.policy_number, p.renewal_submission_id, actor);
    if (!existing) {
      const from = (await customerDb.query<{ data: SubmissionData; renewal_of: ExpiringPolicy | null }>("SELECT data, renewal_of FROM submissions WHERE id = $1", [p.submission_id])).rows[0];
      original = from?.data ?? null;
      exp = expiringFromDesktop(p, original, from?.renewal_of ?? null);
      homeState = p.rating_inputs.home_state;
      insuredId = p.insured_id;
    }
  }
  if (existing) return { submissionId: existing, created: false };

  const submissionId = crypto.randomUUID();
  const data = renewalSubmissionData(exp!, original, homeState!);
  // Two databases, so two transactions. The claim comes last and commits last, so a policy can only ever
  // point at a submission that exists: any failure on the way leaves it unclaimed and a retry works (CR-084).
  let customer: PoolClient | undefined;
  let policy: PoolClient | undefined;
  let submissionCommitted = false;
  try {
    customer = await customerDb.connect();
    await customer.query("BEGIN");
    let insuredCreated = false;
    if (!insuredId) {
      const r = await insuredWithoutFein(exp!.insured_name, homeState!, customer);
      insuredId = r.id;
      insuredCreated = r.created;
    }
    const reference = (await customer.query<{ reference: string }>(
      `INSERT INTO submissions (id, reference, kind, renewal_of, status, applicant_name, data, extraction, received_by, insured_id, reviewed_by, reviewed_at)
       VALUES ($1, 'SUB-' || ${paddedSeq("submission_reference_seq", 4)}, 'renewal', $2, 'accepted', $3, $4, $5, $6, $7, $6, now())
       RETURNING reference`,
      [submissionId, exp!, exp!.insured_name, data, EMPTY_EXTRACTION(data), actor, insuredId],
    )).rows[0].reference;
    await customer.query(
      "INSERT INTO worksheets (submission_id, rating_inputs, schedule, updated_by) VALUES ($1, $2, $3, $4)",
      [submissionId, exp!.rating_inputs, JSON.stringify(exp!.schedule), actor]);

    policy = await policyDb.connect();
    await policy.query("BEGIN");
    // Read under the lock, so the audit says what it really was: the seeded book holds some already in progress (CR-167).
    const statusWas = (await policy.query<{ renewal_status: RenewalStatus }>(`SELECT renewal_status FROM ${table} WHERE id = $1 FOR UPDATE`, [policyId])).rows[0]?.renewal_status;
    // Conditional, so two clicks can't start two renewals: the second waits here, then loses and rolls its inserts back.
    const claimed = await policy.query(
      `UPDATE ${table} SET renewal_status = 'in_progress', renewal_submission_id = $2 WHERE id = $1 AND renewal_submission_id IS NULL`,
      [policyId, submissionId]);
    if (!claimed.rowCount) {
      await policy.query("ROLLBACK");
      await customer.query("ROLLBACK");
      const winner = (await policyDb.query<{ renewal_submission_id: string }>(`SELECT renewal_submission_id FROM ${table} WHERE id = $1`, [policyId])).rows[0];
      return { submissionId: winner.renewal_submission_id, created: false };
    }

    const correlationId = crypto.randomUUID();
    const premium = money(exp!.premium);
    const events: AuditEvent[] = [
      ...(insuredCreated ? [{
        actor, action: "insured.created", entityType: "insured" as const, entityId: insuredId,
        summary: `Insured ${exp!.insured_name} created from renewal of ${exp!.policy_number}`, correlationId,
      }] : []),
      {
        actor, action: "renewal.started", entityType: "submission", entityId: submissionId,
        summary: `${reference}: renewal of ${exp!.policy_number} started (expiring ${premium} on rates ${exp!.rate_version}, expires ${whenDate(exp!.expiration_date)})`,
        after: { policy_number: exp!.policy_number, source, expiring_premium: exp!.premium, rate_version: exp!.rate_version }, correlationId,
      },
      {
        actor, action: "renewal.started", entityType: source === "book" ? "book_policy" : "policy", entityId: policyId,
        summary: `${exp!.policy_number}: renewal started as ${reference}`, before: { renewal_status: statusWas },
        after: { renewal_status: "in_progress", renewal_submission_id: submissionId }, correlationId,
      },
    ];
    await audit(events, policy);   // with the claim, so a started renewal can't be missing its trail (CR-034)
    await customer.query("COMMIT");
    submissionCommitted = true;
    await policy.query("COMMIT");
  } catch (err) {
    await customer?.query("ROLLBACK").catch(() => {});
    await policy?.query("ROLLBACK").catch(() => {});
    if (submissionCommitted) {
      // The claim didn't commit, so nothing points at this submission: don't leave it in the inbox. If it stays, say which (CR-157).
      const notRemoved = (e: unknown) => console.error("[renewal] orphan submission not removed", submissionId, policyId, e);
      await customerDb.query("DELETE FROM worksheets WHERE submission_id = $1", [submissionId]).catch(notRemoved);
      await customerDb.query("DELETE FROM submissions WHERE id = $1", [submissionId]).catch(notRemoved);
    }
    throw err;
  } finally {
    customer?.release();
    policy?.release();
  }
  return { submissionId, created: true };
}

/** For a policy page: the renewal submission started from this policy, with its quotes and the policy it became. */
export async function renewalOfPolicy(renewalSubmissionId: string | null) {
  if (!renewalSubmissionId) return null;
  const sub = (await customerDb.query<SubmissionRow>("SELECT * FROM submissions WHERE id = $1", [renewalSubmissionId])).rows[0];
  if (!sub) return null;
  const [quotes, policies] = await Promise.all([
    policyDb.query<{ id: string; quote_number: string; version: number; status: string; total: string; issued_at: Date; has_memo: boolean }>(
      `SELECT id, quote_number, version, status, total, issued_at, (memo_pdf IS NOT NULL) AS has_memo
       FROM quotes WHERE submission_id = $1 ORDER BY version DESC`, [sub.id]),
    policyDb.query<{ id: string; policy_number: string; total: string; effective_date: string; expiration_date: string }>(
      `SELECT id, policy_number, total, effective_date::text, expiration_date::text FROM policies WHERE submission_id = $1`, [sub.id]),
  ]);
  return { submission: sub, quotes: quotes.rows, policy: policies.rows[0] ?? null };
}
