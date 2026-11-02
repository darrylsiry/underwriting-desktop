import { moneyExact as money } from "./format";
import { audit } from "./audit";
import { customerDb, policyDb } from "./db";
import { memoFor } from "./memo-for";
import { clearanceAudit, clearanceStatus, referralFlags, type Flag } from "./referrals";
import { RATING_TIMEOUT_MS, RatingServiceError, rateOn, rateVersionId } from "./rating-api";
import { RATING_SERVICE_URL } from "./services";
import type { SubmissionRow } from "./submissions";
import {
  INPUT_DEFS, StaleWorksheetError, inputsFromSubmission, inputsHash, parseInputs, parseSchedule, scheduleKey, scheduleMod, scheduleTotal, worksheetFingerprint,
  type Clearance, type RatingInputs, type ScheduleItem,
} from "./worksheet";

export type Rating = {
  rating_id: string; rate_version: string; rate_version_id: number; class_description: string;
  premium: string; minimum_premium_applied: boolean; policy_fee: string;
  surplus_lines_tax: string; surplus_lines_tax_rate: string; total: string;
  worksheet: { step: string; detail: string; factor: string | null; premium: string }[];
};

export type WorksheetRow = {
  submission_id: string;
  rating_inputs: RatingInputs;
  schedule: ScheduleItem[];
  referral_clearances: Record<string, Clearance>;
  last_rating: Rating | null;
  rated_inputs_hash: string | null;
  bridge_rating: Rating | null;   // renewals: the same inputs on the expiring rate version
  updated_by: string;
  updated_at: Date;
};

export async function getWorksheet(submissionId: string): Promise<WorksheetRow | null> {
  const { rows } = await customerDb.query<WorksheetRow>("SELECT * FROM worksheets WHERE submission_id = $1", [submissionId]);
  return rows[0] ?? null;
}

/** The worksheet for an accepted submission, created from the reviewed data on first open. `at` back-dates it (seeded history). */
export async function openWorksheet(sub: SubmissionRow, actor: string, at: Date | null = null): Promise<WorksheetRow> {
  if (sub.status !== "accepted") throw new Error(`${sub.reference} needs its intake accepted first`);
  const existing = await getWorksheet(sub.id);
  if (existing) return existing;
  const inputs = inputsFromSubmission(sub.data);
  const { rowCount } = await customerDb.query(
    `INSERT INTO worksheets (submission_id, rating_inputs, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, coalesce($4, now()), coalesce($4, now())) ON CONFLICT DO NOTHING`,
    [sub.id, inputs, actor, at],
  );
  if (rowCount) {
    await audit({
      actor, action: "worksheet.opened", entityType: "submission", entityId: sub.id,
      summary: `${sub.reference}: underwriting worksheet opened`, after: inputs, occurredAt: at ?? undefined,
    });
  }
  return (await getWorksheet(sub.id))!;
}

export function flagsFor(sub: SubmissionRow, ws: WorksheetRow): Flag[] {
  return referralFlags({
    data: sub.data, extraction: sub.extraction, correctedFields: sub.corrected_fields,
    inputs: ws.rating_inputs, schedule: ws.schedule, expiringLosses: sub.renewal_of?.losses,
  });
}

/** The rating service's active rate version label, or null if it can't be reached. */
export async function activeRateVersion(timeoutMs = RATING_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(`${RATING_SERVICE_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()).active_rate_version ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The active version for pages that only word a task from it (the desk, the lists): remembered for
 * 30 s, waited on for 3 s, so a stopped service can't hold them up (CR-085). Quoting and the
 * workbench, which act on the answer, keep asking activeRateVersion.
 */
export const recentRateVersion = memoFor(30_000, () => activeRateVersion(3_000));

/**
 * Ready to quote: a rating of the current inputs on the currently active rate version, and every
 * "refer" flag cleared. `activeVersion` null means the rating service couldn't be asked.
 */
export function readiness(sub: SubmissionRow, ws: WorksheetRow, activeVersion: string | null) {
  const flags = flagsFor(sub, ws);
  const open = flags.filter((f) => f.severity === "refer" && clearanceStatus(f, ws.referral_clearances[f.code]) !== "cleared");
  const inputsCurrent = !!ws.last_rating && ws.rated_inputs_hash === inputsHash(ws.rating_inputs, ws.schedule);
  const staleRates = ws.last_rating && activeVersion && ws.last_rating.rate_version !== activeVersion
    ? { from: ws.last_rating.rate_version, to: activeVersion } : null;
  const rated = inputsCurrent && !staleRates;
  return { flags, openReferrals: open, inputsCurrent, staleRates, rated, ready: rated && open.length === 0 };
}

/** Rate on the active rate version. `at` back-dates the rating service's log entry (seeded history). */
function rate(sub: SubmissionRow, inputs: RatingInputs, schedule: ScheduleItem[], actor: string, at: Date | null = null): Promise<Rating> {
  return rateOn(inputs, schedule, null, sub.reference, actor, at);
}

/** UX-037 / CR-100: a bound file's worksheet is the rating that was bound. Every change to it stops here, stale tabs included. */
async function refuseIfBound(sub: SubmissionRow): Promise<void> {
  const { rows } = await policyDb.query<{ policy_number: string }>("SELECT policy_number FROM policies WHERE submission_id = $1 LIMIT 1", [sub.id]);
  if (rows[0]) throw new Error(`Bound as ${rows[0].policy_number}; the worksheet can't change. Changes to a bound policy need an endorsement.`);
}

/**
 * Save inputs and schedule (auditing each change), then rate. Inputs stay saved even if rating fails. `at` back-dates it (seeded history).
 * `form._fingerprint` is the worksheet the form showed: if someone saved since, refuse rather than revert their edits (CR-017).
 */
export async function saveAndRate(sub: SubmissionRow, form: Record<string, string>, actor: string, at: Date | null = null): Promise<Rating> {
  await refuseIfBound(sub);
  await openWorksheet(sub, actor, at);
  const inputs = parseInputs(form);
  const schedule = parseSchedule(form);
  const correlationId = crypto.randomUUID();

  const client = await customerDb.connect();
  try {
    await client.query("BEGIN");
    const ws = (await client.query<Pick<WorksheetRow, "rating_inputs" | "schedule">>(
      "SELECT rating_inputs, schedule FROM worksheets WHERE submission_id = $1 FOR UPDATE", [sub.id])).rows[0];
    if (form._fingerprint && form._fingerprint !== worksheetFingerprint(ws.rating_inputs, ws.schedule)) {
      throw new StaleWorksheetError(`${sub.reference} was changed by someone else since you opened it. Nothing was saved: reload to see their edits, then save again.`);
    }
    const changed = INPUT_DEFS.filter((d) => JSON.stringify(ws.rating_inputs[d.key]) !== JSON.stringify(inputs[d.key]));
    const scheduleChanged = scheduleKey(ws.schedule) !== scheduleKey(schedule);
    await client.query(
      "UPDATE worksheets SET rating_inputs = $2, schedule = $3, updated_by = $4, updated_at = coalesce($5, now()) WHERE submission_id = $1",
      [sub.id, inputs, JSON.stringify(schedule), actor, at],
    );
    // The audit trail is in the other database, so it can't share this transaction. Written under the lock and
    // before COMMIT: its "before" values are the ones replaced, and a failure leaves no unaudited change.
    await audit(
      ...changed.map((d) => ({
        actor, action: "worksheet.input_changed", entityType: "submission" as const, entityId: sub.id,
        summary: `${sub.reference}: ${d.label} changed`,
        before: { [d.key]: ws.rating_inputs[d.key] }, after: { [d.key]: inputs[d.key] }, correlationId, occurredAt: at ?? undefined,
      })),
      ...(scheduleChanged ? [{
        actor, action: "worksheet.schedule_changed", entityType: "submission" as const, entityId: sub.id,
        // UX-045: say what changed; a reason-only edit is not a percentage change.
        summary: scheduleTotal(ws.schedule) === scheduleTotal(schedule) && scheduleKey(ws.schedule.map((i) => ({ ...i, rationale: "" }))) === scheduleKey(schedule.map((i) => ({ ...i, rationale: "" })))
          ? `${sub.reference}: schedule reasons updated (total ${formatPct(scheduleTotal(schedule))})`
          : `${sub.reference}: schedule ${formatPct(scheduleTotal(ws.schedule))} → ${formatPct(scheduleTotal(schedule))}`,
        before: ws.schedule, after: schedule, correlationId, occurredAt: at ?? undefined,
      }] : []),
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return rateAndStore(sub, inputs, schedule, actor, correlationId, at);
}

/** Rate the worksheet as saved (no input changes): used when rate tables moved or from the renewal comparison. */
export async function rerateWorksheet(sub: SubmissionRow, actor: string): Promise<Rating> {
  await refuseIfBound(sub);
  const ws = await openWorksheet(sub, actor);
  return rateAndStore(sub, ws.rating_inputs, ws.schedule, actor, crypto.randomUUID());
}

async function rateAndStore(sub: SubmissionRow, inputs: RatingInputs, schedule: ScheduleItem[], actor: string, correlationId: string, at: Date | null = null): Promise<Rating> {
  let rating: Rating;
  try {
    rating = await rate(sub, inputs, schedule, actor, at);
  } catch (err) {
    // Inputs the service refused can't be described by the old rating, so it goes. A service that is
    // down or restarting says nothing about the inputs: the last rating stays, shown as not current (CR-037).
    if (err instanceof RatingServiceError && err.rejectedInputs) {
      await customerDb.query("UPDATE worksheets SET last_rating = NULL, rated_inputs_hash = NULL, bridge_rating = NULL WHERE submission_id = $1", [sub.id]);
    }
    throw err;
  }
  await customerDb.query(
    "UPDATE worksheets SET last_rating = $2, rated_inputs_hash = $3, bridge_rating = $4 WHERE submission_id = $1",
    [sub.id, rating, inputsHash(inputs, schedule), await bridgeRating(sub, inputs, schedule, rating, actor)],
  );
  await audit({
    actor, action: "worksheet.rated", entityType: "submission", entityId: sub.id,
    summary: `${sub.reference}: rated ${money(rating.premium)} premium, ${money(rating.total)} total on rates ${rating.rate_version}`,
    after: { rating_id: rating.rating_id, premium: rating.premium, total: rating.total, schedule_mod: scheduleMod(schedule) },
    correlationId, occurredAt: at ?? undefined,
  });
  return rating;
}

/** Record why a referral is acceptable. Only flags that currently apply can be cleared. `at` back-dates it (seeded history). */
export async function clearReferral(sub: SubmissionRow, code: string, note: string, actor: string, at: Date | null = null): Promise<void> {
  await refuseIfBound(sub);
  const ws = await openWorksheet(sub, actor, at);
  const flag = flagsFor(sub, ws).find((f) => f.code === code);
  if (!flag) throw new Error(`No ${code} flag applies to ${sub.reference}`);
  if (note.trim().length < 10) throw new Error("Write a note explaining why this is acceptable");
  const clearance: Clearance = { by: actor, at: (at ?? new Date()).toISOString(), note: note.trim(), detail: flag.detail };
  await customerDb.query(
    "UPDATE worksheets SET referral_clearances = referral_clearances || jsonb_build_object($2::text, $3::jsonb) WHERE submission_id = $1",
    [sub.id, code, clearance],
  );
  await audit({
    actor, action: "referral.cleared", entityType: "submission", entityId: sub.id,
    summary: `${sub.reference}: referral "${flag.title}" cleared`, ...clearanceAudit(flag, clearance), occurredAt: at ?? undefined,
  });
}

/**
 * For a renewal: the renewing inputs rated on the *expiring* policy's rate version, so the premium
 * change can be split into "terms changed" and "rates changed". Null when that version is gone.
 */
async function bridgeRating(sub: SubmissionRow, inputs: RatingInputs, schedule: ScheduleItem[], current: Rating, actor: string): Promise<Rating | null> {
  const exp = sub.kind === "renewal" ? sub.renewal_of : null;
  if (!exp) return null;
  if (current.rate_version === exp.rate_version) return current;
  try {
    const versionId = await rateVersionId(exp.rate_version);
    return versionId ? await rateOn(inputs, schedule, versionId, `${sub.reference} (expiring rates)`   /* UX-031: the summary adds "on <version>" itself */, actor) : null;
  } catch (err) {
    // Only the inputs being refused on that version means it "couldn't be rated on". A service that is down
    // says nothing about the version, and that explanation would be frozen into the memo (CR-067).
    if (err instanceof RatingServiceError && err.rejectedInputs) return null;
    throw err;
  }
}

export { money };
const formatPct = (n: number) => `${n > 0 ? "+" : ""}${n}%`;
