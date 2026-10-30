// Seeded history: a year of policies bound in the UW Desktop. Each one goes through the real
// pipeline (submission received, intake accepted, worksheet rated, referrals cleared, quote issued,
// bound) at back-dated times, so the desk, the policies list, the renewal register, the premium
// sub-ledger and the audit trail all show a book that has been written since January rather than
// a handful of policies bound today. Runs once at startup when SEED_HISTORY=<count> is set and
// skips any insured that already exists, so it's safe to leave on. Names are fictitious; the
// numbers come from the rating service on the rates in force now.
import { loadUsers } from "./basic-auth";
import { customerDb } from "./db";
import { bindQuote } from "./policies";
import { addDays, addYears, suggestedSubjectivities } from "./quote-terms";
import { issueQuote } from "./quotes";
import { FIELD_DEFS, getPath, type Extraction, type FieldMeta } from "./submission";
import { acceptSubmission, getSubmission, storeSubmission } from "./submissions";
import { between, buildSyntheticCase, pick, rng, type Rng } from "./synthetic-risk";
import type { ScheduleItem } from "./worksheet";
import { activeRateVersion, clearReferral, flagsFor, getWorksheet, readiness, saveAndRate } from "./worksheets";

export const HISTORY_START = "2026-01-01";

const CLEARANCE_NOTES: Record<string, string> = {
  ROOFING: "Manager approval on file (GL product lead): residential re-roof and repair only, no torch-applied or hot work, five years loss-free per loss runs, written fall-protection program confirmed with the broker.",
  HEIGHT: "Work above 50 ft is limited to aerial lifts with a harnessed fall-protection program the broker documented; manager agreed to write it at the quoted height.",
  UNINSURED_SUBS: "Broker confirmed a certificate program starts at inception and sent a sample subcontract with hold-harmless and additional-insured wording.",
  HEAVY_SUBCONTRACTING: "Subcontractors carry equal limits with additional-insured wording per the sample agreement received.",
  LARGE_ACCOUNT: "Manager approved the account above the receipts authority on the quoted terms.",
  LOSS_FREQUENCY: "Claims reviewed with the manager: small, closed and not repeated after the safety program began.",
};
const RATIONALE: Record<string, [string, string]> = {   // [credit, debit]
  management: ["Owner-operated for 20+ years with a dedicated safety lead and documented QA on every job", "Recent ownership change; management experience in this trade still being established"],
  safety: ["Written safety program, weekly toolbox talks and OSHA 30 for every supervisor", "No written safety program; training is informal"],
  subcontractor_controls: ["Written subcontracts with hold-harmless and additional-insured wording; certificates tracked", "Subcontract agreements lack additional-insured wording and certificates are collected inconsistently"],
  equipment: ["Fleet and lifts under a documented inspection program", "Aging equipment with no documented inspection program"],
  loss_experience: ["Five years loss-free, confirmed by currently valued loss runs", "Two paid losses in the period with the same cause of loss"],
  classification: ["Operations are at the low-hazard end of the class (service and repair work)", "A share of operations is heavier than the class contemplates"],
};

// ---- one risk ----------------------------------------------------------------------------------

export type SeedTimes = { received: Date; accepted: Date; rated: Date; cleared: Date; issued: Date; bound: Date };
export type SeedRisk = {
  name: string; fein: string; underwriter: string; effective: string; expiration: string;
  extraction: Extraction; form: Record<string, string>; times: SeedTimes; leaveOneSubjectivityOpen: boolean;
};

const at = (iso: string, hourUtc: number, minute: number) => new Date(`${iso}T${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const laterThan = (d: Date, prev: Date) => (d.getTime() > prev.getTime() ? d : new Date(prev.getTime() + 25 * 60_000));

/** The dates one file moved through: received → accepted → rated → quoted → bound, bound on or before the effective date and never in the future. */
export function seedTimes(r: Rng, effective: string, now: Date): SeedTimes {
  const today = now.toISOString().slice(0, 10);
  let bound = addDays(effective, -between(r, 0, 21));
  if (bound < HISTORY_START) bound = HISTORY_START;
  if (bound > today) bound = today;
  const issued = addDays(bound, -between(r, 1, 10));
  const rated = addDays(issued, -between(r, 0, 2));
  const accepted = addDays(rated, -between(r, 0, 3));
  const received = addDays(accepted, -between(r, 1, 9));
  const t = {} as SeedTimes;
  t.received = at(received, between(r, 13, 16), between(r, 0, 59));
  t.accepted = laterThan(at(accepted, between(r, 15, 20), between(r, 0, 59)), t.received);
  t.rated = laterThan(at(rated, between(r, 14, 21), between(r, 0, 59)), t.accepted);
  t.cleared = new Date(t.rated.getTime() + between(r, 20, 90) * 60_000);
  t.issued = laterThan(at(issued, between(r, 14, 22), between(r, 0, 59)), t.cleared);
  t.bound = laterThan(at(bound, between(r, 14, 22), between(r, 0, 59)), t.issued);
  if (t.bound.getTime() > now.getTime() - 60_000) t.bound = new Date(now.getTime() - 60_000);
  return t;
}

/** Effective dates spread evenly from HISTORY_START to a few weeks out, with a little jitter. */
export function effectiveDates(r: Rng, count: number, now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${HISTORY_START}T00:00:00Z`)) / 86_400_000) + 14;
  return Array.from({ length: count }, (_, i) => {
    let d = addDays(HISTORY_START, Math.round((i * span) / Math.max(1, count - 1)) + between(r, -2, 2));
    if (d < HISTORY_START) d = HISTORY_START;
    return d;
  });
}

function buildRisk(r: Rng, effective: string, underwriter: string, now: Date, taken: Set<string>): SeedRisk {
  const c = buildSyntheticCase(r, { effective, referrals: "clearable" }, taken);
  const { data, name, fein, slug } = c;
  const ops = data.operations as { class_code: string; gross_receipts: number; states: string[]; residential_pct: number; subcontracted_pct: number; max_height_ft: number };
  const pol = data.policy as { aggregate_limit: number; deductible: number };
  const losses = data.loss_history;
  const mod = r() < 0.55 ? 1 : Math.round((0.85 + r() * 0.3) * 100) / 100;
  const application = `${slug}-acord-125.pdf`;
  const fields: Record<string, FieldMeta> = {};
  for (const def of FIELD_DEFS) {
    const value = getPath(data, def.path);
    if (value === null || value === "") continue;
    fields[def.path] = { value, confidence: Math.round((0.9 + r() * 0.1) * 100) / 100, method: "form_field", basis: "stated", source_document: application, snippet: "" };
  }
  const extraction: Extraction = {
    submission: data, fields, conflicts: [], missing_for_rating: [],
    documents: [{ filename: application, doc_type: "acord_125", parent: null, method: "form_fields" },
      ...(losses.length || r() < 0.7 ? [{ filename: `${slug}-loss-runs.pdf`, doc_type: "loss_run", parent: null, method: "claude" }] : [])],
    notes: [], warnings: ["Carried over from the quoting history: the broker's documents were not kept with this file; the extracted values were confirmed at intake."],
    claude: null,
  };

  // The underwriter's worksheet: the application's inputs, a mod on some files, a schedule on a third.
  const form: Record<string, string> = {
    class_code: ops.class_code, gross_receipts: String(ops.gross_receipts), states: ops.states.join(", "), home_state: c.home, occurrence_limit: "1000000", aggregate_limit: String(pol.aggregate_limit),
    deductible: String(pol.deductible), residential_pct: String(ops.residential_pct), subcontracted_pct: String(ops.subcontracted_pct), subcontractor_coi_required: "yes", max_height_ft: String(ops.max_height_ft), experience_mod: String(mod),
  };
  if (r() < 0.35) {
    const cats = Object.keys(RATIONALE);
    const n = between(r, 1, 2);
    const schedule: ScheduleItem[] = [];
    for (let k = 0; k < n; k++) {
      const cat = pick(r, cats);
      if (schedule.some((s) => s.category === cat)) continue;
      const credit = r() < 0.65;
      const pct = (credit ? -1 : 1) * between(r, 3, 8);
      schedule.push({ category: cat, pct, rationale: RATIONALE[cat][credit ? 0 : 1] });
    }
    for (const s of schedule) { form[`schedule.${s.category}.pct`] = String(s.pct); form[`schedule.${s.category}.rationale`] = s.rationale; }
  }
  const times = seedTimes(r, effective, now);
  const recent = now.getTime() - times.bound.getTime() < 45 * 86_400_000;
  return { name, fein, underwriter, effective, expiration: addYears(effective, 1), extraction, form, times, leaveOneSubjectivityOpen: recent && r() < 0.5 };
}

/** The whole set, deterministic for a given count and day. */
export function generateRisks(count: number, underwriters: string[], now: Date): SeedRisk[] {
  const r = rng(20260101 + count);
  const dates = effectiveDates(r, count, now);
  const taken = new Set<string>();
  return dates.map((effective, i) => buildRisk(r, effective, underwriters[(i + (r() < 0.2 ? 1 : 0)) % underwriters.length], now, taken));
}

// ---- running it --------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitForRating(maxMs: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const v = await activeRateVersion();
    if (v) return v;
    if (Date.now() - t0 > maxMs) throw new Error("the rating service didn't come up in time");
    await sleep(5_000);
  }
}

/** One file through the real pipeline at its back-dated times. Returns null when the insured already exists. */
export async function seedOne(risk: SeedRisk, active: string): Promise<{ policy_number: string; total: string } | null> {
  if ((await customerDb.query("SELECT 1 FROM insureds WHERE fein = $1", [risk.fein])).rowCount) return null;
  const uw = risk.underwriter;
  const t = risk.times;
  const { id } = await storeSubmission([], risk.extraction, uw, null, t.received);
  await acceptSubmission(id, uw, t.accepted);
  const sub = (await getSubmission(id))!;
  await saveAndRate(sub, risk.form, uw, t.rated);
  let ws = (await getWorksheet(id))!;
  for (const f of flagsFor(sub, ws)) {
    if (f.severity !== "refer") continue;
    await clearReferral(sub, f.code, CLEARANCE_NOTES[f.code] ?? "Reviewed with the underwriting manager; acceptable on the quoted terms.", uw, t.cleared);
  }
  ws = (await getWorksheet(id))!;
  const state = readiness(sub, ws, active);
  if (!state.ready) throw new Error(`not ready to quote (rated ${state.rated}, open ${state.openReferrals.map((f) => f.code).join(", ") || "none"})`);
  const subjectivities = suggestedSubjectivities(state.flags, sub.data);
  const q = await issueQuote(sub, { effective_date: risk.effective, expiration_date: risk.expiration, subjectivities: subjectivities.join("\n") }, uw, t.issued);
  const received = new Set(subjectivities.map((_, k) => k));
  if (risk.leaveOneSubjectivityOpen && subjectivities.length > 1) received.delete(subjectivities.length - 1);
  const p = await bindQuote(q.id, received, uw, t.bound);
  return { policy_number: p.policy_number, total: p.total };
}

/** The underwriters the history is spread over: the configured logins, else underwriter1-9 like the prior-system book. */
export function historyUnderwriters(env: Record<string, string | undefined>): string[] {
  const names = [...loadUsers(env).keys()];
  return names.length >= 2 ? names : Array.from({ length: 9 }, (_, i) => `underwriter${i + 1}`);
}

export async function seedHistory(count: number, env: Record<string, string | undefined> = process.env, now = new Date()) {
  const log = (m: string) => console.log(`[seed-history] ${m}`);
  const active = await waitForRating(5 * 60_000);
  const underwriters = historyUnderwriters(env);
  log(`seeding ${count} bound policies since ${HISTORY_START} across ${underwriters.join(", ")} on rates ${active}`);
  const risks = generateRisks(count, underwriters, now);
  let made = 0, present = 0, failed = 0;
  for (const [i, risk] of risks.entries()) {
    try {
      const made1 = await seedOne(risk, active);
      if (!made1) { present++; continue; }
      made++;
      log(`${i + 1}/${count} ${made1.policy_number} ${risk.name} · ${risk.underwriter} · bound ${risk.times.bound.toISOString().slice(0, 10)}, effective ${risk.effective} · $${Math.round(Number(made1.total)).toLocaleString("en-US")}`);
    } catch (err) {
      failed++;
      log(`${i + 1}/${count} FAILED ${risk.name}: ${(err as Error).message}`);
    }
  }
  log(`done: ${made} bound, ${present} already present, ${failed} failed`);
  return { made, present, failed };
}

/** SEED_HISTORY=<count>: seed in the background after startup (idempotent, so it may stay set). */
export function seedHistoryIfAsked(env: Record<string, string | undefined> = process.env): void {
  const n = Number(env.SEED_HISTORY ?? 0);
  if (!Number.isFinite(n) || n <= 0) return;
  void seedHistory(n, env).catch((err) => console.error("[seed-history] aborted:", err));
}
