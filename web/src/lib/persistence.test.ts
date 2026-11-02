// The locks and multi-database orderings, against a throwaway Postgres (CR-014). Skipped when none is
// reachable, like services/rating/tests/conftest.py. Two databases are created for this process and
// dropped after; the rating service is stubbed, so no test depends on its rates.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { Client } from "pg";
import type { Extraction, SubmissionData } from "./submission.ts";
import type { RatingInputs } from "./worksheet.ts";

// The modules under test import each other without file extensions, as Next's bundler allows and node doesn't.
// Cast: @types/node doesn't declare registerHooks yet.
type Resolve = (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: unknown) => unknown) => unknown;
const { registerHooks } = await import("node:module") as unknown as { registerHooks: (hooks: { resolve: Resolve }) => void };
registerHooks({
  resolve: (specifier, context, next) =>
    next(!context.parentURL?.includes("/node_modules/") && /^\.\.?\/(?:[^/]*\/)*[^./]+$/.test(specifier) ? `${specifier}.ts` : specifier, context),
});

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://uw:uw@localhost:5432/postgres";
const names = { customer: `web_test_${process.pid}_customer`, policy: `web_test_${process.pid}_policy` };
const urlOf = (db: string) => `${ADMIN_URL.slice(0, ADMIN_URL.lastIndexOf("/"))}/${db}`;

// Before anything opens a pool: this process must only ever reach its own two databases.
process.env.CUSTOMER_DATABASE_URL = urlOf(names.customer);
process.env.POLICY_DATABASE_URL = urlOf(names.policy);
delete process.env.CUSTOMER_MIGRATION_DATABASE_URL;
delete process.env.POLICY_MIGRATION_DATABASE_URL;

const admin = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3_000 });
const reachable = await admin.connect().then(() => true, () => false);
const options = { skip: reachable ? false : "Postgres not available" };

const { customerDb, policyDb, pools } = await import("./db.ts");
const { auditTrail } = await import("./audit.ts");
const { addDays } = await import("./quote-terms.ts");
const { loadDashboard } = await import("./dashboard.ts");
const { migrate } = await import("./migrate.ts");
const { bindQuote } = await import("./policies.ts");
const { issueQuote } = await import("./quotes.ts");
const { startRenewal } = await import("./renewals.ts");
const { acceptSubmission, dataFingerprint, getSubmission, saveReview, storeSubmission } = await import("./submissions.ts");
const { todayIso } = await import("./time.ts");
const { StaleWorksheetError, worksheetFingerprint } = await import("./worksheet.ts");
const { clearReferral, getWorksheet, openWorksheet, saveAndRate } = await import("./worksheets.ts");

const ACTOR = "underwriter1";
const realFetch = globalThis.fetch;
let duringRating: (() => Promise<void>) | null = null;

before(async () => {
  if (!reachable) return;
  for (const db of Object.values(names)) await admin.query(`CREATE DATABASE ${db}`);
  await migrate();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ active_rate_version: "2026.1" });
    if (url.endsWith("/rate-versions")) return Response.json([{ id: 1, label: "2026.1", status: "active" }]);
    if (url.endsWith("/rate")) {
      const hook = duringRating;
      duringRating = null;
      await hook?.();
      return Response.json({
        rating_id: randomUUID(), rate_version: "2026.1", rate_version_id: 1, class_description: "Roofing", premium: "1000", minimum_premium_applied: false,
        policy_fee: "100", surplus_lines_tax: "55", surplus_lines_tax_rate: "0.05", total: "1155", worksheet: [],
      });
    }
    throw new Error(`Unexpected request in a test: ${url}`);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([pools.customer.end(), pools.policy.end()]);
  if (reachable) {
    for (const db of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
});

let feins = 0;

/** A file through the real intake: stored, optionally accepted. */
async function newSubmission({ accept = true, losses = [] as SubmissionData["loss_history"] } = {}) {
  feins += 1;
  const data = {
    applicant: { name: `Test Roofing ${feins}`, state: "TX", fein: `86-${String(1_000_000 + feins)}`, years_in_business: 12 },
    producer: { agency: "Test Agency" },
    policy: { effective_date: addDays(todayIso(), 30), occurrence_limit: 1_000_000, aggregate_limit: 2_000_000, deductible: 0 },
    operations: { description: "Roofing", class_code: "91580", states: ["TX"], gross_receipts: 1_000_000, residential_pct: 0, subcontracted_pct: 0, subcontractor_coi_required: true, max_height_ft: 20 },
    prior: {},
    loss_history: losses,
  } as unknown as SubmissionData;
  const extraction = {
    submission: data, fields: {}, conflicts: [], missing_for_rating: [], notes: [], warnings: [], claude: null,
    documents: [{ filename: "losses.pdf", doc_type: "loss_run", parent: null, method: "form_field" }],
  } as unknown as Extraction;
  const { id } = await storeSubmission([], extraction, ACTOR, null);
  if (accept) await acceptSubmission(id, ACTOR);
  return (await getSubmission(id))!;
}

const formOf = (i: RatingInputs, over: Record<string, string> = {}) => ({
  class_code: i.class_code, gross_receipts: String(i.gross_receipts), states: i.states.join(", "), home_state: i.home_state,
  occurrence_limit: String(i.occurrence_limit), aggregate_limit: String(i.aggregate_limit), deductible: String(i.deductible),
  residential_pct: String(i.residential_pct), subcontracted_pct: String(i.subcontracted_pct),
  subcontractor_coi_required: i.subcontractor_coi_required ? "yes" : "no", max_height_ft: String(i.max_height_ft),
  experience_mod: String(i.experience_mod), ...over,
});

/** Saved and rated, with the height over the referral limit when `height` says so. */
async function ratedSubmission(height = 20, losses: SubmissionData["loss_history"] = []) {
  const sub = await newSubmission({ losses });
  const ws = await openWorksheet(sub, ACTOR);
  await saveAndRate(sub, formOf(ws.rating_inputs, { max_height_ft: String(height) }), ACTOR);
  return sub;
}

const period = (effective = addDays(todayIso(), 30)) => ({ effective_date: effective, expiration_date: `${Number(effective.slice(0, 4)) + 1}${effective.slice(4)}`, subjectivities: "" });

const failAudits = (t: TestContext) => {
  const real = policyDb.query.bind(policyDb) as (...a: unknown[]) => Promise<unknown>;
  return t.mock.method(policyDb, "query", ((...a: unknown[]) =>
    /INSERT INTO audit_events/.test(String(a[0])) ? Promise.reject(new Error("audit database down")) : real(...a)) as never);
};

const actions = async (type: string, id: string) => (await auditTrail(type, id)).map((e) => e.action);

test("a save from a stale form is refused and changes nothing (CR-017)", options, async () => {
  const sub = await ratedSubmission();
  const before = (await getWorksheet(sub.id))!;
  const stale = worksheetFingerprint(before.rating_inputs, before.schedule);
  await saveAndRate(sub, formOf(before.rating_inputs, { gross_receipts: "2000000" }), ACTOR);
  const trail = await actions("submission", sub.id);

  await assert.rejects(saveAndRate(sub, formOf(before.rating_inputs, { gross_receipts: "3000000", _fingerprint: stale }), ACTOR), StaleWorksheetError);
  assert.equal((await getWorksheet(sub.id))!.rating_inputs.gross_receipts, 2_000_000);
  assert.deepEqual(await actions("submission", sub.id), trail);
});

test("if the audit fails, a clearance doesn't stand, and a retry works (CR-144)", options, async (t) => {
  const sub = await ratedSubmission(200);
  const down = failAudits(t);
  await assert.rejects(clearReferral(sub, "HEIGHT", "Roof access only, reviewed by the manager", ACTOR), /audit database down/);
  assert.deepEqual((await getWorksheet(sub.id))!.referral_clearances, {});
  down.mock.restore();

  await clearReferral(sub, "HEIGHT", "Roof access only, reviewed by the manager", ACTOR);
  assert.equal((await getWorksheet(sub.id))!.referral_clearances.HEIGHT.by, ACTOR);
  assert.ok((await actions("submission", sub.id)).includes("referral.cleared"));
});

test("if the audit fails, a correction isn't saved, and a retry isn't called stale (CR-144)", options, async (t) => {
  const sub = await newSubmission({ accept: false });
  const fingerprint = dataFingerprint(sub.data);
  const down = failAudits(t);
  await assert.rejects(saveReview(sub.id, { "applicant.name": "Corrected Roofing" }, ACTOR, fingerprint), /audit database down/);
  assert.equal((await getSubmission(sub.id))!.applicant_name, sub.applicant_name);
  down.mock.restore();

  assert.equal(await saveReview(sub.id, { "applicant.name": "Corrected Roofing" }, ACTOR, fingerprint), 1);
  assert.equal((await getSubmission(sub.id))!.applicant_name, "Corrected Roofing");
});

test("if the audit fails, an intake isn't accepted (CR-144)", options, async (t) => {
  const sub = await newSubmission({ accept: false });
  const down = failAudits(t);
  await assert.rejects(acceptSubmission(sub.id, ACTOR), /audit database down/);
  assert.equal((await getSubmission(sub.id))!.status, "needs_review");
  down.mock.restore();
  await acceptSubmission(sub.id, ACTOR);
  assert.equal((await getSubmission(sub.id))!.status, "accepted");
});

test("a clearance covers only the facts on the page that sent it (CR-148)", options, async () => {
  const sub = await ratedSubmission(55);
  const shown = "Maximum working height 55 ft (limit 50 ft)";
  await saveAndRate(sub, formOf((await getWorksheet(sub.id))!.rating_inputs, { max_height_ft: "150" }), ACTOR);

  await assert.rejects(clearReferral(sub, "HEIGHT", "Acceptable at the height I was shown", ACTOR, null, shown), StaleWorksheetError);
  assert.deepEqual((await getWorksheet(sub.id))!.referral_clearances, {});
});

test("a quote issues only at the rating on the page that sent it (CR-148)", options, async () => {
  const sub = await ratedSubmission();
  const shown = (await getWorksheet(sub.id))!.last_rating!.rating_id;
  await saveAndRate(sub, formOf((await getWorksheet(sub.id))!.rating_inputs, { gross_receipts: "1500000" }), ACTOR);

  await assert.rejects(issueQuote(sub, { ...period(), rating_id: shown }, ACTOR), StaleWorksheetError);
  assert.equal((await policyDb.query("SELECT 1 FROM quotes WHERE submission_id = $1", [sub.id])).rowCount, 0);
  const q = await issueQuote(sub, { ...period(), rating_id: (await getWorksheet(sub.id))!.last_rating!.rating_id }, ACTOR);
  assert.equal(q.version, 1);
});

test("a bind while a revised quote is being rated stops the revision (CR-050)", options, async () => {
  const sub = await ratedSubmission();
  const v1 = await issueQuote(sub, period(), ACTOR);
  duringRating = async () => { await bindQuote(v1.id, new Set(), ACTOR); };

  await assert.rejects(issueQuote(sub, period(), ACTOR), /is already bound/);
  const { rows } = await policyDb.query<{ version: number; status: string }>("SELECT version, status FROM quotes WHERE submission_id = $1", [sub.id]);
  assert.deepEqual(rows, [{ version: 1, status: "bound" }]);
});

test("a renewal whose claim fails leaves nothing behind and can start again; binding it completes the trail (CR-084, CR-140)", options, async () => {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  const policy = await bindQuote(quote.id, new Set(), ACTOR);
  const renewals = async () => (await customerDb.query("SELECT 1 FROM submissions WHERE renewal_of->>'policy_id' = $1", [policy.id])).rowCount;

  await policyDb.query(`CREATE FUNCTION test_refuse_claim() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'claim refused'; END $$ LANGUAGE plpgsql`);
  await policyDb.query("CREATE TRIGGER test_refuse_claim BEFORE UPDATE OF renewal_submission_id ON policies FOR EACH ROW EXECUTE FUNCTION test_refuse_claim()");
  await assert.rejects(startRenewal("desktop", policy.id, ACTOR), /claim refused/);
  await policyDb.query("DROP TRIGGER test_refuse_claim ON policies");
  await policyDb.query("DROP FUNCTION test_refuse_claim()");
  assert.equal(await renewals(), 0);

  const { submissionId, created } = await startRenewal("desktop", policy.id, ACTOR);
  assert.equal(created, true);
  assert.equal(await renewals(), 1);

  const renewal = (await getSubmission(submissionId))!;
  await saveAndRate(renewal, formOf((await getWorksheet(submissionId))!.rating_inputs), ACTOR);
  const effective = quote.expiration_date;
  const renewalQuote = await issueQuote((await getSubmission(submissionId))!, period(effective), ACTOR);
  const bound = await bindQuote(renewalQuote.id, new Set(), ACTOR);

  const [latest] = await auditTrail("policy", policy.id);
  assert.equal(latest.action, "renewal.completed");
  assert.deepEqual(latest.before, { renewal_status: "in_progress" });
  assert.deepEqual(latest.after, { renewal_status: "renewed", renewal_policy: bound.policy_number });
});

test("a claim on a submission that doesn't exist is released on the record (CR-140)", options, async () => {
  const sub = await ratedSubmission();
  const policy = await bindQuote((await issueQuote(sub, period(), ACTOR)).id, new Set(), ACTOR);
  const dangling = randomUUID();
  await policyDb.query("UPDATE policies SET renewal_status = 'in_progress', renewal_submission_id = $2 WHERE id = $1", [policy.id, dangling]);

  const { created } = await startRenewal("desktop", policy.id, ACTOR);
  assert.equal(created, true);
  const released = (await auditTrail("policy", policy.id)).find((e) => e.action === "renewal.released")!;
  assert.match(released.summary, new RegExp(dangling));
  assert.deepEqual(released.after, { renewal_status: "not_started", renewal_submission_id: null });
});

test("the desk and its renewal list show a bound policy's own claims (CR-135)", options, async () => {
  const sub = await ratedSubmission(20, [
    { date: "2025-02-03", description: "Fall", incurred: 40_000, status: "Open" },
    { date: "2024-05-06", description: "Slip", incurred: 2_500, status: "Closed" },
  ]);
  const effective = addDays(todayIso(), -300);
  const policy = await bindQuote((await issueQuote(sub, period(effective), ACTOR)).id, new Set(), ACTOR);

  const row = (await loadDashboard(ACTOR)).renewals.find((p) => p.id === policy.id)!;
  assert.deepEqual([row.claims, row.incurred, row.open_claims], [2, 42_500, 1]);
});
