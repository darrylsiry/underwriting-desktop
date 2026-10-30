import { audit } from "./audit";
import { customerDb } from "./db";
import { clearanceStatus, referralFlags, type Flag } from "./referrals";
import { rateOn, rateVersionId } from "./rating-api";
import { RATING_SERVICE_URL } from "./services";
import type { SubmissionRow } from "./submissions";
import {
  INPUT_DEFS, inputsFromSubmission, inputsHash, parseInputs, parseSchedule, scheduleKey, scheduleMod, scheduleTotal,
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

/** The worksheet for an accepted submission, created from the reviewed data on first open. */
export async function openWorksheet(sub: SubmissionRow, actor: string): Promise<WorksheetRow> {
  if (sub.status !== "accepted") throw new Error(`${sub.reference} needs its intake accepted first`);
  const existing = await getWorksheet(sub.id);
  if (existing) return existing;
  const inputs = inputsFromSubmission(sub.data);
  const { rowCount } = await customerDb.query(
    "INSERT INTO worksheets (submission_id, rating_inputs, updated_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [sub.id, inputs, actor],
  );
  if (rowCount) {
    await audit({
      actor, action: "worksheet.opened", entityType: "submission", entityId: sub.id,
      summary: `${sub.reference}: underwriting worksheet opened`, after: inputs,
    });
  }
  return (await getWorksheet(sub.id))!;
}

export function flagsFor(sub: SubmissionRow, ws: WorksheetRow): Flag[] {
  return referralFlags({
    data: sub.data, extraction: sub.extraction, correctedFields: sub.corrected_fields,
    inputs: ws.rating_inputs, schedule: ws.schedule,
  });
}

/** The rating service's active rate version label, or null if it can't be reached. */
export async function activeRateVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${RATING_SERVICE_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()).active_rate_version ?? null) : null;
  } catch {
    return null;
  }
}

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

async function rate(sub: SubmissionRow, inputs: RatingInputs, schedule: ScheduleItem[], actor: string): Promise<Rating> {
  const res = await fetch(`${RATING_SERVICE_URL}/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...inputs, schedule_mod: scheduleMod(schedule), reference: sub.reference, requested_by: actor }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Rating: ${typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)}`);
  return body as Rating;
}

/** Save inputs and schedule (auditing each change), then rate. Inputs stay saved even if rating fails. */
export async function saveAndRate(sub: SubmissionRow, form: Record<string, string>, actor: string): Promise<Rating> {
  const ws = await openWorksheet(sub, actor);
  const inputs = parseInputs(form);
  const schedule = parseSchedule(form);
  const correlationId = crypto.randomUUID();

  const changed = INPUT_DEFS.filter((d) => JSON.stringify(ws.rating_inputs[d.key]) !== JSON.stringify(inputs[d.key]));
  const scheduleChanged = scheduleKey(ws.schedule) !== scheduleKey(schedule);
  await customerDb.query(
    "UPDATE worksheets SET rating_inputs = $2, schedule = $3, updated_by = $4, updated_at = now() WHERE submission_id = $1",
    [sub.id, inputs, JSON.stringify(schedule), actor],
  );
  await audit(
    ...changed.map((d) => ({
      actor, action: "worksheet.input_changed", entityType: "submission" as const, entityId: sub.id,
      summary: `${sub.reference}: ${d.label} changed`,
      before: { [d.key]: ws.rating_inputs[d.key] }, after: { [d.key]: inputs[d.key] }, correlationId,
    })),
    ...(scheduleChanged ? [{
      actor, action: "worksheet.schedule_changed", entityType: "submission" as const, entityId: sub.id,
      summary: `${sub.reference}: schedule ${formatPct(scheduleTotal(ws.schedule))} → ${formatPct(scheduleTotal(schedule))}`,
      before: ws.schedule, after: schedule, correlationId,
    }] : []),
  );

  return rateAndStore(sub, inputs, schedule, actor, correlationId);
}

/** Rate the worksheet as saved (no input changes): used when rate tables moved or from the renewal comparison. */
export async function rerateWorksheet(sub: SubmissionRow, actor: string): Promise<Rating> {
  const ws = await openWorksheet(sub, actor);
  return rateAndStore(sub, ws.rating_inputs, ws.schedule, actor, crypto.randomUUID());
}

async function rateAndStore(sub: SubmissionRow, inputs: RatingInputs, schedule: ScheduleItem[], actor: string, correlationId: string): Promise<Rating> {
  let rating: Rating;
  try {
    rating = await rate(sub, inputs, schedule, actor);
  } catch (err) {
    await customerDb.query("UPDATE worksheets SET last_rating = NULL, rated_inputs_hash = NULL, bridge_rating = NULL WHERE submission_id = $1", [sub.id]);
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
    correlationId,
  });
  return rating;
}

/** Record why a referral is acceptable. Only flags that currently apply can be cleared. */
export async function clearReferral(sub: SubmissionRow, code: string, note: string, actor: string): Promise<void> {
  const ws = await openWorksheet(sub, actor);
  const flag = flagsFor(sub, ws).find((f) => f.code === code);
  if (!flag) throw new Error(`No ${code} flag applies to ${sub.reference}`);
  if (note.trim().length < 10) throw new Error("Write a note explaining why this is acceptable");
  const clearance: Clearance = { by: actor, at: new Date().toISOString(), note: note.trim(), detail: flag.detail };
  await customerDb.query(
    "UPDATE worksheets SET referral_clearances = referral_clearances || jsonb_build_object($2::text, $3::jsonb) WHERE submission_id = $1",
    [sub.id, code, clearance],
  );
  await audit({
    actor, action: "referral.cleared", entityType: "submission", entityId: sub.id,
    summary: `${sub.reference}: referral "${flag.title}" cleared`, before: flag, after: clearance,
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
    return versionId ? await rateOn(inputs, schedule, versionId, `${sub.reference} on ${exp.rate_version}`, actor) : null;
  } catch {
    return null;
  }
}

export const money = (v: string | number) => `$${Number(v).toLocaleString("en-US")}`;
const formatPct = (n: number) => `${n > 0 ? "+" : ""}${n}%`;
