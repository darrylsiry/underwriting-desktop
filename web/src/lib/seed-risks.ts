// The seeded history without a database: what each file looks like, and how a run decides what to
// do. seed-history.ts plugs in the real pipeline. Pure module (type-only imports) for node:test.
import { addDays, addYears } from "./quote-terms.ts";
import { FIELD_DEFS, getPath, type Extraction, type FieldMeta } from "./submission.ts";
import { between, buildSyntheticCase, pick, rng, type Rng } from "./synthetic-risk.ts";
import type { ScheduleItem } from "./worksheet";

export const HISTORY_START = "2026-01-01";

/** Marks a submission as seeded history. Databases already hold it, and CR-121's count depends on it: don't reword. */
export const SEEDED_WARNING = "Carried over from the quoting history: the broker's documents were not kept with this file; the extracted values were confirmed at intake.";

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
    documents: [{ filename: application, doc_type: "acord_application", parent: null, method: "form_field" },
      ...(losses.length || r() < 0.7 ? [{ filename: `${slug}-loss-runs.pdf`, doc_type: "loss_run" as const, parent: null, method: "claude" as const }] : [])],
    notes: [], warnings: [SEEDED_WARNING],
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
  const coin = r();   // drawn whether or not it's used: which draws happen must not depend on the date
  return { name, fein, underwriter, effective, expiration: addYears(effective, 1), extraction, form, times, leaveOneSubjectivityOpen: recent && coin < 0.5 };
}

/**
 * The whole set. Each risk has its own random stream, so which insureds it holds (names, FEINs) is
 * the same whatever day it's generated, and only their dates follow `now` (CR-121).
 */
export function generateRisks(count: number, underwriters: string[], now: Date): SeedRisk[] {
  const dates = effectiveDates(rng(20260101 + count), count, now);
  const taken = new Set<string>();
  return dates.map((effective, i) => {
    const r = rng(20260101 + count + (i + 1) * 7919);
    return buildRisk(r, effective, underwriters[(i + (r() < 0.2 ? 1 : 0)) % underwriters.length], now, taken);
  });
}

// ---- how a run decides what to do ---------------------------------------------------------------

export type SeedBound = { policy_number: string; total: string };
export type SeedQuote = { id: string; subjectivities: string[] };
/** How far one seeded file got. */
export type SeedFile = {
  accepted: boolean;
  rated: boolean;              // a rating of its current inputs on the active rates
  openReferrals: string[];     // rule codes still to clear
  quote: SeedQuote | null;     // issued and waiting to bind
  policy: SeedBound | null;    // bound: nothing left to do
};
export type SeedSummary = { made: number; present: number; failed: number };

/** The steps of the real pipeline (seed-history.ts), passed in so the decisions below run under node:test. */
export type SeedPipeline = {
  /** Seeded files on this database, and how many of them are bound. */
  counts(): Promise<{ files: number; bound: number }>;
  /** Waits for the rating service; returns the active rate version. */
  ready(): Promise<string>;
  findFile(risk: SeedRisk): Promise<string | null>;
  insuredExists(risk: SeedRisk): Promise<boolean>;
  store(risk: SeedRisk): Promise<string>;
  state(id: string): Promise<SeedFile>;
  accept(id: string, risk: SeedRisk): Promise<void>;
  rate(id: string, risk: SeedRisk): Promise<void>;
  clear(id: string, code: string, risk: SeedRisk): Promise<void>;
  issue(id: string, risk: SeedRisk): Promise<SeedQuote>;
  bind(quoteId: string, received: Set<number>, risk: SeedRisk): Promise<SeedBound>;
};

/** Carry one file from wherever it stopped to bound (CR-076). Null when it already was. */
export async function advanceFile(id: string, risk: SeedRisk, p: SeedPipeline): Promise<SeedBound | null> {
  let file = await p.state(id);
  if (file.policy) return null;
  let quote = file.quote;
  if (!quote) {
    if (!file.accepted) { await p.accept(id, risk); file = await p.state(id); }
    if (!file.rated) { await p.rate(id, risk); file = await p.state(id); }
    for (const code of file.openReferrals) await p.clear(id, code, risk);
    file = await p.state(id);
    if (!file.rated || file.openReferrals.length) throw new Error(`not ready to quote (rated ${file.rated}, open ${file.openReferrals.join(", ") || "none"})`);
    quote = await p.issue(id, risk);
  }
  const received = new Set(quote.subjectivities.map((_, k) => k));
  if (risk.leaveOneSubjectivityOpen && quote.subjectivities.length > 1) received.delete(quote.subjectivities.length - 1);
  return p.bind(quote.id, received, risk);
}

/**
 * One run. A history that's already there is left alone, however its FEINs were generated (CR-121);
 * files that stopped part way are finished (CR-076); and a run never starts more files than `count`.
 */
export async function runSeedHistory(count: number, risks: SeedRisk[], p: SeedPipeline, log: (m: string) => void): Promise<SeedSummary> {
  const before = await p.counts();
  let files = before.files;
  if (before.bound >= count) {
    log(`${before.bound} seeded policies are already bound (asked for ${count}): nothing to do`);
    return { made: 0, present: count, failed: 0 };
  }
  const active = await p.ready();
  log(`seeding up to ${count} bound policies since ${HISTORY_START} on rates ${active} (${before.files} files on record, ${before.bound} bound)`);
  let made = 0, present = 0, failed = 0;
  for (const [i, risk] of risks.entries()) {
    try {
      let id = await p.findFile(risk);
      if (!id) {
        if (files >= count) continue;
        if (await p.insuredExists(risk)) { present++; continue; }
        id = await p.store(risk);
        files++;
      }
      const bound = await advanceFile(id, risk, p);
      if (!bound) { present++; continue; }
      made++;
      log(`${i + 1}/${count} ${bound.policy_number} ${risk.name} · ${risk.underwriter} · bound ${risk.times.bound.toISOString().slice(0, 10)}, effective ${risk.effective} · $${Math.round(Number(bound.total)).toLocaleString("en-US")}`);
    } catch (err) {
      failed++;
      log(`${i + 1}/${count} FAILED ${risk.name}: ${(err as Error).message}`);
    }
  }
  log(`done: ${(await p.counts()).bound} bound, ${failed} failed (${made} finished in this run, ${present} already present)`);
  return { made, present, failed };
}
