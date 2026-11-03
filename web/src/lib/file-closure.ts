// How a file ends without a bind (UX-068): a submission declined, a quote closed as not taken, a policy
// non-renewed. Each needs a reason and leaves an audit row, and each can be undone. Also the two
// corrections to a file after the fact: reopening intake (UX-058) and marking a subjectivity received (UX-051).
// The audit trail lives in the policy database, so a change in the customer database writes it before COMMIT.

import type { PoolClient } from "pg";
import { audit } from "./audit";
import { customerDb, policyDb } from "./db";
import { whenDate } from "./time";
import type { RenewalStatus } from "./renewals";
import type { SubmissionRow } from "./submissions";

export const DECLINE_REASONS = ["Outside appetite", "Loss history", "Incomplete submission", "Price", "Other"];
export const NOT_TAKEN_REASONS = ["Lost on price", "Lost on terms", "Insured stayed with incumbent", "No response", "Other"];
export const NON_RENEWAL_REASONS = ["Outside appetite", "Loss history", "Insured declined to renew", "Price", "Other"];

export type Closure = { reason: string; note?: string; by: string; at: string };
export type Decline = Closure & { from: "needs_review" | "accepted" };

/** A closure from what a form sent, or why it can't be one. */
export function closureOf(input: { reason?: string; note?: string }, reasons: string[], actor: string, now = new Date()): Closure {
  const reason = input.reason?.trim() ?? "";
  const note = input.note?.trim() ?? "";
  if (!reasons.includes(reason)) throw new Error("Choose a reason");
  if (reason === "Other" && !note) throw new Error("Say why, since the reason is Other");
  return { reason, ...(note ? { note } : {}), by: actor, at: now.toISOString() };
}

/** `Declined by underwriter1 on Nov 2, 2026: Outside appetite (note).` */
export const closureText = (verb: string, c: Closure) => `${verb} by ${c.by} on ${whenDate(c.at)}: ${c.reason}${c.note ? ` (${c.note})` : ""}`;

async function transaction<T>(pool: { connect: () => Promise<PoolClient> }, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const boundAs = async (submissionId: string) =>
  (await policyDb.query<{ policy_number: string }>("SELECT policy_number FROM policies WHERE submission_id = $1 LIMIT 1", [submissionId])).rows[0]?.policy_number;

const renewalTable = (source: "book" | "desktop") => (source === "book" ? "book_policies" : "policies");
const renewalEntity = (source: "book" | "desktop") => (source === "book" ? "book_policy" as const : "policy" as const);

/**
 * Decline a submission. It leaves the desk and stays searchable with its history. A live quote closes with
 * it, and declining a renewal non-renews the policy it came from, so neither is left waiting on nothing.
 */
export async function declineSubmission(sub: SubmissionRow, input: { reason?: string; note?: string }, actor: string): Promise<void> {
  const closure = closureOf(input, DECLINE_REASONS, actor);
  const policy = await boundAs(sub.id);
  if (policy) throw new Error(`${sub.reference} is bound as ${policy}, so it can't be declined`);
  await transaction(customerDb, async (customer) => {
    const was = (await customer.query<{ status: SubmissionRow["status"] }>("SELECT status FROM submissions WHERE id = $1 FOR UPDATE", [sub.id])).rows[0]?.status;
    if (was === "declined") throw new Error(`${sub.reference} is already declined`);
    const decline: Decline = { ...closure, from: was };
    await customer.query("UPDATE submissions SET status = 'declined', decline = $2 WHERE id = $1", [sub.id, decline]);
    await transaction(policyDb, async (policyClient) => {
      const closed = (await policyClient.query<{ id: string; quote_number: string; version: number }>(
        "UPDATE quotes SET status = 'not_taken', closed = $2 WHERE submission_id = $1 AND status = 'issued' RETURNING id, quote_number, version",
        [sub.id, { ...closure, reason: `Declined: ${closure.reason}` }])).rows;
      const exp = sub.kind === "renewal" ? sub.renewal_of : null;
      const released = exp ? (await policyClient.query(
        `UPDATE ${renewalTable(exp.source)} SET renewal_status = 'non_renewed', non_renewal = $3 WHERE id = $1 AND renewal_submission_id = $2 AND renewal_status = 'in_progress'`,
        [exp.policy_id, sub.id, closure])).rowCount : 0;
      await audit([
        { actor, action: "submission.declined", entityType: "submission", entityId: sub.id,
          summary: `${sub.reference}: declined (${closure.reason})`, before: { status: was }, after: { status: "declined", reason: closure.reason, note: closure.note } },
        ...closed.map((q) => ({ actor, action: "quote.not_taken", entityType: "quote" as const, entityId: q.id,
          summary: `${q.quote_number} v${q.version}: closed, ${sub.reference} declined`, before: { status: "issued" }, after: { status: "not_taken", reason: closure.reason } })),
        ...(exp && released ? [{ actor, action: "renewal.non_renewed", entityType: renewalEntity(exp.source), entityId: exp.policy_id,
          summary: `${exp.policy_number}: non-renewed, ${sub.reference} declined (${closure.reason})`, before: { renewal_status: "in_progress" }, after: { renewal_status: "non_renewed", reason: closure.reason } }] : []),
      ], policyClient);
    });
  });
}

/** Undo a decline: the file goes back where it was. A quote it closed stays closed, so a new version says what is on offer now. */
export async function reopenDeclined(sub: SubmissionRow, actor: string): Promise<SubmissionRow["status"]> {
  return transaction(customerDb, async (customer) => {
    const row = (await customer.query<{ status: SubmissionRow["status"]; decline: Decline | null }>("SELECT status, decline FROM submissions WHERE id = $1 FOR UPDATE", [sub.id])).rows[0];
    if (row?.status !== "declined" || !row.decline) throw new Error(`${sub.reference} isn't declined`);
    await customer.query("UPDATE submissions SET status = $2, decline = NULL WHERE id = $1", [sub.id, row.decline.from]);
    await transaction(policyDb, async (policyClient) => {
      const exp = sub.kind === "renewal" ? sub.renewal_of : null;
      const restored = exp ? (await policyClient.query(
        `UPDATE ${renewalTable(exp.source)} SET renewal_status = 'in_progress', non_renewal = NULL WHERE id = $1 AND renewal_submission_id = $2 AND renewal_status = 'non_renewed'`,
        [exp.policy_id, sub.id])).rowCount : 0;
      await audit([
        { actor, action: "submission.reopened", entityType: "submission", entityId: sub.id,
          summary: `${sub.reference}: reopened after decline (${row.decline!.reason})`, before: { status: "declined" }, after: { status: row.decline!.from } },
        ...(exp && restored ? [{ actor, action: "renewal.non_renewal_reversed", entityType: renewalEntity(exp.source), entityId: exp.policy_id,
          summary: `${exp.policy_number}: renewal back in progress, ${sub.reference} reopened`, before: { renewal_status: "non_renewed" }, after: { renewal_status: "in_progress" } }] : []),
      ], policyClient);
    });
    return row.decline.from;
  });
}

/** Reopen an accepted intake to correct it (UX-058). The worksheet is kept, and issued quotes stay as sent. */
export async function reopenIntake(sub: SubmissionRow, actor: string): Promise<void> {
  const policy = await boundAs(sub.id);
  if (policy) throw new Error(`${sub.reference} is bound as ${policy}; changes now need a policy endorsement`);
  await transaction(customerDb, async (customer) => {
    const done = await customer.query("UPDATE submissions SET status = 'needs_review' WHERE id = $1 AND status = 'accepted'", [sub.id]);
    if (!done.rowCount) throw new Error(`${sub.reference} isn't accepted, so there is nothing to reopen`);
    await audit({ actor, action: "submission.intake_reopened", entityType: "submission", entityId: sub.id,
      summary: `${sub.reference}: intake reopened for corrections`, before: { status: "accepted" }, after: { status: "needs_review" } });
  });
}

/** Close the live quote as not taken: it leaves Quotes out and the desk, and counts as lost in the hit ratio. */
export async function closeQuote(quoteId: string, input: { reason?: string; note?: string }, actor: string): Promise<{ submissionId: string }> {
  const closure = closureOf(input, NOT_TAKEN_REASONS, actor);
  return transaction(policyDb, async (client) => {
    const q = (await client.query<{ status: string; quote_number: string; version: number; submission_id: string }>(
      "SELECT status, quote_number, version, submission_id FROM quotes WHERE id = $1 FOR UPDATE", [quoteId])).rows[0];
    if (!q) throw new Error("Quote not found");
    if (q.status !== "issued") throw new Error(`${q.quote_number} v${q.version} is ${q.status.replace("_", " ")}, so it can't be closed`);
    await client.query("UPDATE quotes SET status = 'not_taken', closed = $2 WHERE id = $1", [quoteId, closure]);
    await audit([{ actor, action: "quote.not_taken", entityType: "quote", entityId: quoteId,
      summary: `${q.quote_number} v${q.version}: closed as not taken (${closure.reason})`, before: { status: "issued" }, after: { status: "not_taken", reason: closure.reason, note: closure.note } }], client);
    return { submissionId: q.submission_id };
  });
}

type RenewalRow = { policy_number: string; renewal_status: RenewalStatus; renewal_submission_id: string | null };
const lockRenewal = async (client: PoolClient, source: "book" | "desktop", id: string) =>
  (await client.query<RenewalRow>(`SELECT policy_number, renewal_status, renewal_submission_id FROM ${renewalTable(source)} WHERE id = $1 FOR UPDATE`, [id])).rows[0];

/** Mark a policy non-renewed. A renewal already started is ended by declining its submission, which says the same thing. */
export async function nonRenewPolicy(source: "book" | "desktop", id: string, input: { reason?: string; note?: string }, actor: string): Promise<void> {
  const closure = closureOf(input, NON_RENEWAL_REASONS, actor);
  await transaction(policyDb, async (client) => {
    const p = await lockRenewal(client, source, id);
    if (!p) throw new Error("Policy not found");
    if (p.renewal_submission_id) throw new Error(`${p.policy_number} has a renewal started; decline that submission to end it`);
    if (p.renewal_status === "non_renewed" || p.renewal_status === "renewed") throw new Error(`${p.policy_number} is already ${p.renewal_status.replace("_", " ")}`);
    await client.query(`UPDATE ${renewalTable(source)} SET renewal_status = 'non_renewed', non_renewal = $2 WHERE id = $1`, [id, closure]);
    await audit([{ actor, action: "renewal.non_renewed", entityType: renewalEntity(source), entityId: id,
      summary: `${p.policy_number}: marked non-renewed (${closure.reason})`, before: { renewal_status: p.renewal_status }, after: { renewal_status: "non_renewed", reason: closure.reason, note: closure.note } }], client);
  });
}

export async function reverseNonRenewal(source: "book" | "desktop", id: string, actor: string): Promise<void> {
  await transaction(policyDb, async (client) => {
    const p = await lockRenewal(client, source, id);
    if (!p) throw new Error("Policy not found");
    if (p.renewal_status !== "non_renewed") throw new Error(`${p.policy_number} isn't non-renewed`);
    if (p.renewal_submission_id) throw new Error(`${p.policy_number} was non-renewed by declining its renewal; reopen that submission instead`);
    await client.query(`UPDATE ${renewalTable(source)} SET renewal_status = 'not_started', non_renewal = NULL WHERE id = $1`, [id]);
    await audit([{ actor, action: "renewal.non_renewal_reversed", entityType: renewalEntity(source), entityId: id,
      summary: `${p.policy_number}: non-renewal reversed`, before: { renewal_status: "non_renewed" }, after: { renewal_status: "not_started" } }], client);
  });
}

/** Record that a subjectivity came in (UX-051). The binder stays as issued; this is where receipts live. */
export async function markSubjectivityReceived(policyId: string, index: number, actor: string): Promise<void> {
  await transaction(policyDb, async (client) => {
    const p = (await client.query<{ policy_number: string; subjectivities: { text: string; status: string; due_date: string | null }[] }>(
      "SELECT policy_number, subjectivities FROM policies WHERE id = $1 FOR UPDATE", [policyId])).rows[0];
    if (!p) throw new Error("Policy not found");
    const item = p.subjectivities[index];
    if (!item) throw new Error(`${p.policy_number} has no such subjectivity`);
    if (item.status !== "open") throw new Error(`"${item.text}" is already marked received`);
    const next = p.subjectivities.map((s, i) => (i === index ? { ...s, status: "received", received_at: new Date().toISOString(), received_by: actor } : s));
    await client.query("UPDATE policies SET subjectivities = $2 WHERE id = $1", [policyId, JSON.stringify(next)]);
    await audit([{ actor, action: "policy.subjectivity_received", entityType: "policy", entityId: policyId,
      summary: `${p.policy_number}: "${item.text}" received`, before: { status: "open", due_date: item.due_date }, after: { status: "received" } }], client);
  });
}
