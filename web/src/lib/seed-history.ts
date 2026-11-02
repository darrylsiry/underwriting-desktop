// Seeded history: a year of policies bound in the UW Desktop. Each one goes through the real
// pipeline (submission received, intake accepted, worksheet rated, referrals cleared, quote issued,
// bound) at back-dated times, so the desk, the policies list, the renewal register, the premium
// sub-ledger and the audit trail all show a book that has been written since January rather than
// a handful of policies bound today. Runs at startup when SEED_HISTORY=<count> is set. It's safe to
// leave on: once that many seeded policies are bound it does nothing, and a run cut short is finished
// by the next one (seed-risks.ts decides; the steps below carry it out). Names are fictitious; the
// numbers come from the rating service on the rates in force now.
import { SEED_HISTORY_LOCK, tryAdvisoryLock } from "./advisory-lock.ts";
import { loadUsers } from "./basic-auth";
import { customerDb, policyDb } from "./db";
import { bindQuote, policiesForSubmission } from "./policies";
import { addYears, suggestedSubjectivities } from "./quote-terms";
import { issueQuote, quotesForSubmission } from "./quotes";
import { SEEDED_WARNING, generateRisks, runSeedHistory, type SeedPipeline, type SeedSummary } from "./seed-risks.ts";
import { acceptSubmission, getSubmission, storeSubmission } from "./submissions";
import { activeRateVersion, clearReferral, getWorksheet, readiness, saveAndRate } from "./worksheets";

const CLEARANCE_NOTES: Record<string, string> = {
  ROOFING: "Manager approval on file (GL product lead): residential re-roof and repair only, no torch-applied or hot work, five years loss-free per loss runs, written fall-protection program confirmed with the broker.",
  HEIGHT: "Work above 50 ft is limited to aerial lifts with a harnessed fall-protection program the broker documented; manager agreed to write it at the quoted height.",
  UNINSURED_SUBS: "Broker confirmed a certificate program starts at inception and sent a sample subcontract with hold-harmless and additional-insured wording.",
  HEAVY_SUBCONTRACTING: "Subcontractors carry equal limits with additional-insured wording per the sample agreement received.",
  LARGE_ACCOUNT: "Manager approved the account above the receipts authority on the quoted terms.",
  LOSS_FREQUENCY: "Claims reviewed with the manager: small, closed and not repeated after the safety program began.",
};

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

/** The real pipeline, one step at a time, at each file's back-dated times. */
function realPipeline(): SeedPipeline {
  let active = "";
  const sub = async (id: string) => (await getSubmission(id))!;
  return {
    counts: async () => {
      const { rows } = await customerDb.query<{ id: string }>("SELECT id FROM submissions WHERE extraction->'warnings' ? $1", [SEEDED_WARNING]);
      const ids = rows.map((r) => r.id);
      const bound = await policyDb.query<{ n: number }>("SELECT count(DISTINCT submission_id)::int AS n FROM policies WHERE submission_id = ANY($1::uuid[])", [ids]);
      return { files: ids.length, bound: bound.rows[0].n };
    },
    ready: async () => (active = await waitForRating(5 * 60_000)),
    findFile: async (risk) => (await customerDb.query<{ id: string }>(
      "SELECT id FROM submissions WHERE data->'applicant'->>'fein' = $1 AND extraction->'warnings' ? $2 ORDER BY received_at LIMIT 1",
      [risk.fein, SEEDED_WARNING])).rows[0]?.id ?? null,
    insuredExists: async (risk) => !!(await customerDb.query("SELECT 1 FROM insureds WHERE fein = $1", [risk.fein])).rowCount,
    store: async (risk) => (await storeSubmission([], risk.extraction, risk.underwriter, null, risk.times.received)).id,
    state: async (id) => {
      const s = await sub(id);
      const policy = (await policiesForSubmission(id))[0];
      if (policy) return { accepted: true, rated: true, openReferrals: [], quote: null, policy: { policy_number: policy.policy_number, total: policy.total } };
      const ws = s.status === "accepted" ? await getWorksheet(id) : null;
      const r = ws && readiness(s, ws, active);
      const quote = (await quotesForSubmission(id)).find((q) => q.status === "issued");
      return {
        accepted: s.status === "accepted", rated: !!r?.rated, openReferrals: r ? r.openReferrals.map((f) => f.code) : [],
        quote: quote ? { id: quote.id, subjectivities: quote.subjectivities } : null, policy: null,
      };
    },
    accept: (id, risk) => acceptSubmission(id, risk.underwriter, risk.times.accepted),
    rate: async (id, risk) => { await saveAndRate(await sub(id), risk.form, risk.underwriter, risk.times.rated); },
    clear: async (id, code, risk) => clearReferral(await sub(id), code,
      CLEARANCE_NOTES[code] ?? "Reviewed with the underwriting manager; acceptable on the quoted terms.", risk.underwriter, risk.times.cleared),
    issue: async (id, risk) => {
      const s = await sub(id);
      const subjectivities = suggestedSubjectivities(readiness(s, (await getWorksheet(id))!, active).flags, s.data);
      // The date the file was stored with: a resumed file's generated date may have moved on with the calendar.
      const effective = String(s.data.policy?.effective_date || risk.effective);
      const q = await issueQuote(s, { effective_date: effective, expiration_date: addYears(effective, 1), subjectivities: subjectivities.join("\n") }, risk.underwriter, risk.times.issued);
      return { id: q.id, subjectivities: q.subjectivities };
    },
    bind: async (quoteId, received, risk) => {
      const p = await bindQuote(quoteId, received, risk.underwriter, risk.times.bound);
      return { policy_number: p.policy_number, total: p.total };
    },
  };
}

/** The underwriters the history is spread over: the configured logins, else underwriter1-9 like the prior-system book. */
export function historyUnderwriters(env: Record<string, string | undefined>): string[] {
  const names = [...loadUsers(env).keys()];
  return names.length >= 2 ? names : Array.from({ length: 9 }, (_, i) => `underwriter${i + 1}`);
}

export async function seedHistory(count: number, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<SeedSummary> {
  const log = (m: string) => console.log(`[seed-history] ${m}`);
  const underwriters = historyUnderwriters(env);
  // CR-038: one instance seeds at a time; another starting meanwhile leaves it to that one.
  const summary = await tryAdvisoryLock(customerDb, SEED_HISTORY_LOCK, () => runSeedHistory(count, generateRisks(count, underwriters, now), realPipeline(), log));
  if (!summary) log("another instance is seeding; leaving it to that one");
  return summary ?? { made: 0, present: 0, failed: 0 };
}

/** SEED_HISTORY=<count>: seed in the background after startup (it may stay set: see the top of this file). */
export function seedHistoryIfAsked(env: Record<string, string | undefined> = process.env): void {
  const n = Number(env.SEED_HISTORY ?? 0);
  if (!Number.isFinite(n) || n <= 0) return;
  void seedHistory(n, env).catch((err) => console.error("[seed-history] aborted:", err));
}
