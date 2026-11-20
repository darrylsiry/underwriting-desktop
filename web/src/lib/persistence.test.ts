// The locks and multi-database orderings, against a throwaway Postgres (CR-014). Skipped when none is
// reachable, like services/rating/tests/conftest.py. Two databases are created for this process and
// dropped after; the rating service is stubbed, so no test depends on its rates.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { Client } from "pg";
import type { Extraction, SubmissionData } from "./submission.ts";
import type { SubmissionRow } from "./submissions.ts";
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
const { LOSS_RATIO_BASIS, lossRatio } = await import("./book-metrics.ts");
const { loadAgentActivity, mockupIds, readMockup, readReport } = await import("./agent-activity.ts");
const { closeQuote, declineSubmission, markSubjectivityReceived, nonRenewPolicy, reopenDeclined, reopenIntake, reverseNonRenewal } = await import("./file-closure.ts");
const { addDays } = await import("./quote-terms.ts");
const { loadDashboard, submissionStagesById } = await import("./dashboard.ts");
const { quoteDrift } = await import("./renewal-compare.ts");
const { migrate } = await import("./migrate.ts");
const { APP_TOOLS } = await import("./assistant-tools.ts");
const { bindQuote } = await import("./policies.ts");
const { storePublished } = await import("./published-reports.ts");
const { getQuote, issueQuote } = await import("./quotes.ts");
const { startRenewal } = await import("./renewals.ts");
const { acceptSubmission, dataFingerprint, getSubmission, saveReview, storeSubmission } = await import("./submissions.ts");
const { todayIso } = await import("./time.ts");
const { StaleWorksheetError, worksheetFingerprint } = await import("./worksheet.ts");
const { activeRateVersion, clearReferral, flagsFor, getWorksheet, openWorksheet, readiness, saveAndRate } = await import("./worksheets.ts");

const ACTOR = "underwriter1";
const realFetch = globalThis.fetch;
let duringRating: (() => Promise<void>) | null = null;

/** What a killed run or a failed teardown left behind: databases named for a process that has gone (CR-158). Never FORCE: one in use isn't ours to take. */
async function dropLeftovers() {
  const { rows } = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'web\\_test\\_%'");
  for (const { datname } of rows) {
    const pid = Number(/^web_test_(\d+)_/.exec(datname)?.[1]);
    let running = false;
    try { process.kill(pid, 0); running = true; } catch (err) { running = (err as NodeJS.ErrnoException).code === "EPERM"; }
    if (!running) await admin.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => {});
  }
}

before(async () => {
  if (!reachable) return;
  await dropLeftovers();
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

/** A value as the server action gets it: multipart encoding rewrites each line break in a form field as CRLF. */
const asPosted = async (value: string) => {
  const form = new FormData();
  form.set("detail", value);
  return String((await new Response(form).formData()).get("detail"));
};

test("a referral quoting a multi-line claim clears from the page that shows it, and only at those facts (CR-151)", options, async () => {
  const sub = await ratedSubmission(20, [{ date: "2025-02-03", description: "Fall\nfrom scaffold", incurred: 150_000, status: "Open" }]);
  const shown = flagsFor(sub, (await getWorksheet(sub.id))!).find((f) => f.code === "LARGE_OPEN_CLAIM")!.detail;
  const posted = await asPosted(shown);
  assert.notEqual(posted, shown, "the form post is meant to change the line break");

  await assert.rejects(clearReferral(sub, "LARGE_OPEN_CLAIM", "Reserve reviewed with the claims team", ACTOR, null, posted.replace("150,000", "90,000")), StaleWorksheetError);
  assert.deepEqual((await getWorksheet(sub.id))!.referral_clearances, {});

  await clearReferral(sub, "LARGE_OPEN_CLAIM", "Reserve reviewed with the claims team", ACTOR, null, posted);
  assert.equal((await getWorksheet(sub.id))!.referral_clearances.LARGE_OPEN_CLAIM.detail, shown);
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

test("App Tests reads the newest of the published set and the deployed copy, and only while publishing is on (step 30)", options, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-reports-"));
  const saved = { dir: process.env.AGENT_REPORTS_DIR, token: process.env.REPORTS_PUBLISH_TOKEN };
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [["AGENT_REPORTS_DIR", saved.dir], ["REPORTS_PUBLISH_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.AGENT_REPORTS_DIR = dir;
  process.env.REPORTS_PUBLISH_TOKEN = "test-token";
  const ledger = (updatedAt: string) => JSON.stringify({ version: 1, updatedAt, runs: [], items: {} });
  const report = (id: string) => `# Code review: test\n\n- **Run:** 2026-11-02 20:12\n\n## Medium\n\n### ${id} — A finding\n- **Status:** Open\n`;
  const baked = (updatedAt: string) => writeFileSync(path.join(dir, "AGENT_LEDGER.json"), ledger(updatedAt));
  const WRITTEN = "2026-11-02T20:12:00.000Z";
  const file = (name: string, text: string) => ({ name, text, written_at: WRITTEN });
  baked("2026-11-02T10:00:00.000Z");
  writeFileSync(path.join(dir, "CODE_REVIEW.md"), report("CR-001"));

  assert.equal((await loadAgentActivity()).source, "deployed copy", "nothing published yet");

  const set = [file("AGENT_LEDGER.json", ledger("2026-11-02T12:00:00.000Z")), file("CODE_REVIEW.md", report("CR-002")), file("ux-mockups/UX-068.html", "<p>after</p>")];
  assert.equal(await storePublished(set), "stored");
  assert.equal(await storePublished(set), "unchanged");
  const activity = await loadAgentActivity();
  assert.equal(activity.source, "published");
  assert.ok(activity.publishedAt);
  assert.equal(activity.written.code?.toISOString(), WRITTEN, "keeps when the report was written, not when it was sent");
  assert.match((await readReport("code"))!.text, /CR-002/);
  assert.deepEqual([...await mockupIds()], ["UX-068"]);
  assert.equal(await readMockup("UX-068"), "<p>after</p>");
  assert.equal(await readReport("security"), null, "never held, so /app-tests/security stays a 404 (CR-097)");

  assert.equal(await storePublished([file("AGENT_LEDGER.json", ledger("2026-11-02T11:00:00.000Z")), file("CODE_REVIEW.md", report("CR-003"))]), "stale");
  assert.match((await readReport("code"))!.text, /CR-002/, "an older set changes nothing");

  assert.equal(await storePublished(set.slice(0, 2)), "stored");
  assert.deepEqual([...await mockupIds()], [], "a mockup the agent removed goes with the next set");

  baked("2026-11-02T13:00:00.000Z");
  assert.equal((await loadAgentActivity()).source, "deployed copy", "the image's copy is newer");
  baked("2026-11-02T10:00:00.000Z");

  delete process.env.REPORTS_PUBLISH_TOKEN;
  assert.equal((await loadAgentActivity()).source, "deployed copy", "with publishing off the stored set is ignored");
  assert.match((await readReport("code"))!.text, /CR-001/);
});

let bookPolicies = 0;
/** A prior-system policy: claim totals and no loss rows. */
async function bookPolicy(over: { claims?: number; incurred?: number; open_claims?: number; expiration_date?: string } = {}) {
  bookPolicies += 1;
  const expiration = over.expiration_date ?? addDays(todayIso(), 30);
  const inputs = { class_code: "91580", gross_receipts: 1_000_000, states: ["TX"], home_state: "TX", occurrence_limit: 1_000_000, aggregate_limit: 2_000_000, deductible: 0,
    residential_pct: 0, subcontracted_pct: 0, subcontractor_coi_required: true, max_height_ft: 20, experience_mod: 1 };
  const { rows } = await policyDb.query<{ id: string }>(
    `INSERT INTO book_policies (policy_number, insured_name, underwriter, class_code, class_description, states, home_state, producer, effective_date, expiration_date,
       premium, claims, incurred, open_claims, rating_inputs, schedule, rate_version)
     VALUES ($1, $2, $3, '91580', 'Roofing', '{TX}', 'TX', 'Test Agency', ($4::date - 365), $4, 1000, $5, $6, $7, $8, '[]', '2026.1') RETURNING id`,
    [`GL-TEST-${bookPolicies}`, `Prior Roofing ${bookPolicies}`, ACTOR, expiration, over.claims ?? 0, over.incurred ?? 0, over.open_claims ?? 0, inputs]);
  return rows[0].id;
}

test("a prior-system renewal's claims survive its bind, on the desk and into the next renewal (CR-152)", options, async () => {
  const expired = addDays(todayIso(), -300);
  const book = await bookPolicy({ claims: 3, incurred: 90_000, open_claims: 1, expiration_date: expired });
  const { submissionId } = await startRenewal("book", book, ACTOR);
  const renewal = (await getSubmission(submissionId))!;
  await saveAndRate(renewal, formOf((await getWorksheet(submissionId))!.rating_inputs), ACTOR);
  for (const code of ["OPEN_CLAIMS_NO_DETAIL", "LOSS_FREQUENCY"]) {
    await clearReferral(renewal, code, "Reviewed the expiring file with the manager", ACTOR);
  }
  const quote = await issueQuote((await getSubmission(submissionId))!, period(expired), ACTOR);
  const bound = await bindQuote(quote.id, new Set(), ACTOR);

  const row = (await loadDashboard(ACTOR)).renewals.find((p) => p.id === bound.id)!;
  assert.deepEqual([row.claims, row.incurred, row.open_claims], [3, 90_000, 1]);

  const next = await startRenewal("desktop", bound.id, ACTOR);
  const nextSub = (await getSubmission(next.submissionId))!;
  const codes = flagsFor(nextSub, (await openWorksheet(nextSub, ACTOR))).map((f) => f.code);
  assert.ok(codes.includes("LOSS_FREQUENCY") && codes.includes("OPEN_CLAIMS_NO_DETAIL"), codes.join());
});

test("the audit says what a renewal's status really was (CR-167)", options, async () => {
  const quote = await issueQuote(await ratedSubmission(), period(), ACTOR);
  const policy = await bindQuote(quote.id, new Set(), ACTOR);
  await policyDb.query("UPDATE policies SET renewal_status = 'in_progress' WHERE id = $1", [policy.id]);
  await startRenewal("desktop", policy.id, ACTOR);
  const started = (await auditTrail("policy", policy.id)).find((e) => e.action === "renewal.started")!;
  assert.deepEqual(started.before, { renewal_status: "in_progress" });

  const untouched = await bookPolicy();
  await startRenewal("book", untouched, ACTOR);
  const first = (await auditTrail("book_policy", untouched)).find((e) => e.action === "renewal.started")!;
  assert.deepEqual(first.before, { renewal_status: "not_started" });
});

test("a clean-up that fails after a failed renewal start says which submission it left (CR-157)", options, async (t) => {
  const book = await bookPolicy();
  const realConnect = policyDb.connect.bind(policyDb) as (...a: unknown[]) => Promise<never>;
  t.mock.method(policyDb, "connect", (async (...args: unknown[]) => {
    if (args.length) return realConnect(...args);   // the pool's own query() passes a callback: leave those alone
    const client = await realConnect() as unknown as { query: (...a: unknown[]) => Promise<unknown>; release: (...a: unknown[]) => void };
    const [query, release] = [client.query.bind(client), client.release.bind(client)];
    client.query = (...a) => a[0] === "COMMIT" ? Promise.reject(new Error("commit failed")) : query(...a);
    client.release = (...a) => {
      delete (client as Partial<typeof client>).query;
      delete (client as Partial<typeof client>).release;
      release(...a);
    };
    return client;
  }) as never);
  const realQuery = customerDb.query.bind(customerDb) as (...a: unknown[]) => Promise<unknown>;
  t.mock.method(customerDb, "query", ((...a: unknown[]) =>
    /^DELETE FROM submissions/.test(String(a[0])) ? Promise.reject(new Error("delete failed")) : realQuery(...a)) as never);
  const logged = t.mock.method(console, "error", () => {});

  await assert.rejects(startRenewal("book", book, ACTOR), /commit failed/);
  const orphan = logged.mock.calls.find((c) => String(c.arguments[0]).includes("orphan"));
  assert.ok(orphan, "the log names what was left behind");
  assert.ok((orphan.arguments as unknown[]).includes(book), "and the policy it came from");
});

test("a renewal can't start before the expiring policy ends, and can start on the day it does (CR-156)", options, async () => {
  const expires = addDays(todayIso(), 60);
  const book = await bookPolicy({ expiration_date: expires });
  const { submissionId } = await startRenewal("book", book, ACTOR);
  await saveAndRate((await getSubmission(submissionId))!, formOf((await getWorksheet(submissionId))!.rating_inputs), ACTOR);
  const sub = (await getSubmission(submissionId))!;
  await assert.rejects(issueQuote(sub, period(addDays(expires, -30)), ACTOR), /^Error: Effective date:/);
  assert.equal((await policyDb.query("SELECT 1 FROM quotes WHERE submission_id = $1", [submissionId])).rowCount, 0);
  assert.equal((await issueQuote(sub, period(expires), ACTOR)).version, 1);
});

test("a quote for a period already over is refused before anything is written, but seeded history still issues (CR-164)", options, async () => {
  const sub = await ratedSubmission();
  const live = await issueQuote(sub, period(), ACTOR);
  const longAgo = addDays(todayIso(), -400);
  await assert.rejects(issueQuote(sub, period(longAgo), ACTOR), /^Error: Effective date:/);
  const quotes = (await policyDb.query<{ id: string; status: string }>("SELECT id, status FROM quotes WHERE submission_id = $1", [sub.id])).rows;
  assert.deepEqual(quotes.map((q) => [q.id, q.status]), [[live.id, "issued"]], "the live quote isn't superseded");

  const seeded = await ratedSubmission();
  const issuedThen = new Date(`${longAgo}T12:00:00Z`);
  assert.equal((await issueQuote(seeded, period(longAgo), ACTOR, issuedThen)).version, 1);
});

test("retyping the same states in another order changes nothing; a new state does (CR-168)", options, async () => {
  const sub = await ratedSubmission();
  const states = (v: string) => async () => formOf((await getWorksheet(sub.id))!.rating_inputs, { states: v });
  await saveAndRate(sub, await states("TX, NJ")(), ACTOR);
  const before = (await getWorksheet(sub.id))!;
  const changes = async () => (await auditTrail("submission", sub.id)).filter((e) => e.action === "worksheet.input_changed").length;
  const count = await changes();

  await saveAndRate(sub, await states("NJ, TX")(), ACTOR);
  const after = (await getWorksheet(sub.id))!;
  assert.deepEqual(after.rating_inputs.states, ["TX", "NJ"]);
  assert.equal(after.rated_inputs_hash, before.rated_inputs_hash);
  assert.equal(await changes(), count);

  await saveAndRate(sub, await states("TX, NJ, GA")(), ACTOR);
  assert.deepEqual((await getWorksheet(sub.id))!.rating_inputs.states, ["TX", "NJ", "GA"]);
  assert.equal(await changes(), count + 1);
});

const tool = (name: string) => APP_TOOLS.find((t) => t.name === name)!;
const toolCtx = { actor: ACTOR, origin: "http://test", today: todayIso() };

test("a database that ran the migrations shows the seeded book at about 25%, on the desk and to the assistant", options, async () => {
  const { kpis } = await loadDashboard("underwriter2");   // not ACTOR: other tests add policies to that desk
  assert.ok(kpis.lossRatio! >= 0.235 && kpis.lossRatio! <= 0.265, String(kpis.lossRatio));
  assert.ok(kpis.openClaims > 0);
  const summary = await tool("book_summary").run({ underwriter: "underwriter2" }, toolCtx as never) as { kpis: typeof kpis };
  assert.equal(summary.kpis.lossRatio, kpis.lossRatio);
  assert.equal(summary.kpis.openClaims, kpis.openClaims);
});

test("the assistant is given each policy's loss ratio on the page's basis, so it can't work one out on another", options, async () => {
  const policy = await tool("get_policy").run({ policy: "GL-25-70012" }, toolCtx as never) as { premium: number; incurred: string; loss_ratio: number; loss_ratio_basis: string };
  const pageShows = lossRatio(Number(policy.incurred), policy.premium)!;
  assert.ok(pageShows > 0);
  assert.equal(policy.loss_ratio, Math.round(pageShows * 1000) / 1000);
  assert.equal(policy.loss_ratio_basis, LOSS_RATIO_BASIS);

  const due = await tool("renewals_due").run({ days: 400, underwriter: "underwriter2" }, toolCtx as never) as { loss_ratio_basis: string; policies: { premium: number; incurred: number; loss_ratio: number }[] };
  assert.equal(due.loss_ratio_basis, LOSS_RATIO_BASIS);
  assert.ok(due.policies.some((p) => p.incurred > 0));
  for (const p of due.policies) assert.equal(p.loss_ratio, Math.round(lossRatio(p.incurred, p.premium)! * 1000) / 1000);
});

test("a renewal started before the loss data changed gets the new totals, and only one from the prior-system book does", options, async () => {
  const { rows: [p] } = await policyDb.query<{ id: string; claims: number; incurred: number; open_claims: number }>(
    "SELECT id, claims, incurred::float8 AS incurred, open_claims FROM book_policies WHERE policy_number = 'GL-25-70003'");
  assert.ok(p.open_claims > 0, "this policy has to show the new referral below");
  const { submissionId } = await startRenewal("book", p.id, ACTOR);
  const backToOldTotals = (source: string) => customerDb.query(
    `UPDATE submissions SET renewal_of = renewal_of || jsonb_build_object('source', $2::text, 'losses', '{"claims": 3, "incurred": 24000, "open_claims": 0}'::jsonb) WHERE id = $1`, [submissionId, source]);
  const migration = () => customerDb.query(readFileSync(new URL("../../migrations/customer/007_book_renewal_losses.sql", import.meta.url), "utf8"));

  await backToOldTotals("book");
  await migration();
  const renewal = (await getSubmission(submissionId))!;
  assert.deepEqual(renewal.renewal_of!.losses, { claims: p.claims, incurred: p.incurred, open_claims: p.open_claims });
  assert.ok(flagsFor(renewal, (await getWorksheet(submissionId))!).some((f) => f.code === "OPEN_CLAIMS_NO_DETAIL"));

  await backToOldTotals("desktop");
  await migration();
  assert.equal((await getSubmission(submissionId))!.renewal_of!.losses.incurred, 24_000);
});

test("the assistant judges a bound file as the workbench does, by the terms that were bound (CR-155)", options, async () => {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  const live = await tool("get_submission").run({ reference_or_id: sub.reference }, toolCtx as never) as { worksheet: Record<string, unknown> };
  assert.equal(live.worksheet.ready_to_quote, true);

  await saveAndRate(sub, formOf((await getWorksheet(sub.id))!.rating_inputs, { max_height_ft: "55" }), ACTOR);
  await bindQuote(quote.id, new Set(), ACTOR);
  const { worksheet } = await tool("get_submission").run({ reference_or_id: sub.reference }, toolCtx as never) as { worksheet: Record<string, unknown> & { referrals: { code: string }[]; rating_inputs: { max_height_ft: number } } };
  assert.equal(worksheet.bound, true);
  assert.ok(!("ready_to_quote" in worksheet) && !("rating_is_current" in worksheet));
  assert.ok(!worksheet.referrals.some((r) => r.code === "HEIGHT"), "the bound terms were under the limit");
  assert.equal(worksheet.rating_inputs.max_height_ft, 20, "the inputs that were bound, as the workbench shows them");
});

test("the assistant can say who holds a customer's file and where its renewal stands (CR-173)", options, async () => {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  await bindQuote(quote.id, new Set(), ACTOR);
  const found = await tool("get_insured").run({ name_or_id: (await getSubmission(sub.id))!.insured_id! }, toolCtx as never) as { submissions: Record<string, unknown>[]; policies: Record<string, unknown>[] };
  assert.equal(found.submissions[0].received_by, ACTOR);
  assert.equal(found.submissions[0].kind, "new");
  assert.equal(found.policies[0].status, "bound");
  assert.equal(found.policies[0].renewal_status, "not_started");
});

test("a dropped idle connection is a log line naming the pool, and the next query works (CR-172)", options, async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { pid } = (await policyDb.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0];
  await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  for (let i = 0; i < 100 && !logged.mock.callCount(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /\[db\] idle policy connection lost/);
  assert.equal((await policyDb.query<{ one: number }>("SELECT 1 AS one")).rows[0].one, 1);
});

test("leftover test databases go when their process has gone, and no others do (CR-158)", options, async () => {
  const gone = "web_test_999999_customer";
  await admin.query(`CREATE DATABASE ${gone}`);
  await dropLeftovers();
  const left = (await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'web\\_test\\_%'")).rows.map((r) => r.datname);
  assert.ok(!left.includes(gone));
  for (const own of Object.values(names)) assert.ok(left.includes(own), own);
});

test("long-dead tasks don't outrank current work, and an old expired quote leaves the desk (CR-174)", options, async () => {
  const longAgo = addDays(todayIso(), -200);
  const dead = await issueQuote(await ratedSubmission(), period(longAgo), ACTOR, new Date(`${longAgo}T12:00:00Z`));
  const liveQuote = await issueQuote(await ratedSubmission(), period(), ACTOR);
  const book = await bookPolicy({ expiration_date: addDays(todayIso(), 2) });
  const overdue = await issueQuote(await ratedSubmission(), { ...period(), subjectivities: "Signed application" }, ACTOR);
  const policy = await bindQuote(overdue.id, new Set(), ACTOR);
  await policyDb.query(`UPDATE policies SET subjectivities = jsonb_set(subjectivities, '{0,due_date}', to_jsonb($2::text)) WHERE id = $1`, [policy.id, addDays(todayIso(), -100)]);

  const { tasks } = await loadDashboard(ACTOR);
  const at = (needle: string) => tasks.findIndex((t) => t.href.includes(needle));
  assert.equal(at(dead.id), -1, "dropped once 30 days past valid until");
  assert.ok(at(liveQuote.id) >= 0, "a live quote stays");
  assert.ok(at(book) < at(policy.id), "the renewal due in 2 days sorts ahead of a subjectivity 100 days overdue");
  assert.equal(tasks[at(policy.id)].urgency, -7);
});

test("the assistant says a rule raised since bind needs no action, and calls nothing open on a bound file (CR-175)", options, async () => {
  const sub = await ratedSubmission(20);
  await saveAndRate(sub, formOf((await getWorksheet(sub.id))!.rating_inputs, { experience_mod: "0.90" }), ACTOR);
  await clearReferral(sub, "EXPERIENCE_MOD", "Confirmed against the bureau worksheet", ACTOR);
  await bindQuote((await issueQuote(sub, period(), ACTOR)).id, new Set(), ACTOR);
  await customerDb.query("UPDATE worksheets SET referral_clearances = referral_clearances - 'EXPERIENCE_MOD' WHERE submission_id = $1", [sub.id]);

  const { worksheet } = await tool("get_submission").run({ reference_or_id: sub.reference }, toolCtx as never) as { worksheet: { referrals: { code: string; severity: string; status: string }[] } };
  assert.equal(worksheet.referrals.find((r) => r.code === "EXPERIENCE_MOD")?.status, "raised_since_bind");
  assert.ok(!worksheet.referrals.some((r) => r.severity === "refer" && r.status === "open"));
});

const fresh = async (id: string) => (await getSubmission(id))!;
const taskFor = async (needle: string) => (await loadDashboard(ACTOR)).tasks.find((t) => t.href.includes(needle));

test("a declined file leaves the desk, closes its quote, refuses work and can be reopened (UX-068)", options, async () => {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  assert.ok(await taskFor(quote.id), "on the desk while the quote is out");

  await assert.rejects(declineSubmission(sub, { reason: "Nonsense" }, ACTOR), /Choose a reason/);
  await assert.rejects(declineSubmission(sub, { reason: "Other" }, ACTOR), /Say why/);
  await declineSubmission(sub, { reason: "Outside appetite", note: "Torch work" }, ACTOR);

  const declined = await fresh(sub.id);
  assert.equal(declined.status, "declined");
  assert.deepEqual([declined.decline?.reason, declined.decline?.note, declined.decline?.by, declined.decline?.from], ["Outside appetite", "Torch work", ACTOR, "accepted"]);
  assert.equal(await taskFor(sub.id), undefined);
  assert.equal(await taskFor(quote.id), undefined);
  assert.equal((await policyDb.query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [quote.id])).rows[0].status, "not_taken");
  assert.ok((await actions("submission", sub.id)).includes("submission.declined"));

  await assert.rejects(saveAndRate(declined, formOf((await getWorksheet(sub.id))!.rating_inputs), ACTOR), /declined/);
  await assert.rejects(issueQuote(declined, period(), ACTOR), /declined/);
  await assert.rejects(bindQuote(quote.id, new Set(), ACTOR), /is declined/);   // the file is checked first now (CR-182)
  await assert.rejects(declineSubmission(declined, { reason: "Price" }, ACTOR), /already declined/);

  assert.equal(await reopenDeclined(declined, ACTOR), "accepted");
  const reopened = await fresh(sub.id);
  assert.equal(reopened.status, "accepted");
  assert.equal(reopened.decline, null);
  assert.equal((await issueQuote(reopened, period(), ACTOR)).version, 2, "a new version says what is on offer now");
});

test("a bound file can't be declined (UX-068)", options, async () => {
  const sub = await ratedSubmission();
  await bindQuote((await issueQuote(sub, period(), ACTOR)).id, new Set(), ACTOR);
  await assert.rejects(declineSubmission(sub, { reason: "Price" }, ACTOR), /bound as/);
});

test("a quote closed as not taken leaves Quotes out and counts as lost (UX-068)", options, async () => {
  const before = (await loadDashboard(ACTOR)).kpis;
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  const during = (await loadDashboard(ACTOR)).kpis;
  assert.equal(during.quotesOut, before.quotesOut + 1);

  await closeQuote(quote.id, { reason: "Lost on price" }, ACTOR);
  const after = (await loadDashboard(ACTOR)).kpis;
  assert.equal(after.quotesOut, before.quotesOut);
  assert.equal(await taskFor(quote.id), undefined);
  assert.ok(after.hitRatio !== null);
  await assert.rejects(closeQuote(quote.id, { reason: "Lost on price" }, ACTOR), /not taken, so it can't be closed/);
  assert.ok((await auditTrail("quote", quote.id)).some((e) => e.action === "quote.not_taken"));
});

test("a non-renewed policy leaves the renewal work, refuses a renewal, and can be reversed (UX-068)", options, async () => {
  const book = await bookPolicy({ expiration_date: addDays(todayIso(), 20) });
  assert.ok(await taskFor(book));
  await nonRenewPolicy("book", book, { reason: "Loss history" }, ACTOR);
  assert.equal(await taskFor(book), undefined);
  assert.ok(!(await loadDashboard(ACTOR)).renewals.some((p) => p.id === book));
  await assert.rejects(startRenewal("book", book, ACTOR), /non-renewed/);

  await reverseNonRenewal("book", book, ACTOR);
  assert.ok(await taskFor(book));
  const { submissionId } = await startRenewal("book", book, ACTOR);
  await assert.rejects(nonRenewPolicy("book", book, { reason: "Price" }, ACTOR), /decline that submission/);

  // Declining the renewal says the same thing, and reopening it undoes both.
  const renewal = await fresh(submissionId);
  await declineSubmission(renewal, { reason: "Loss history" }, ACTOR);
  const status = async () => (await policyDb.query<{ renewal_status: string }>("SELECT renewal_status FROM book_policies WHERE id = $1", [book])).rows[0].renewal_status;
  assert.equal(await status(), "non_renewed");
  await reopenDeclined(await fresh(submissionId), ACTOR);
  assert.equal(await status(), "in_progress");
});

test("marking the last subjectivity received clears the chase task and keeps who and when (UX-051)", options, async () => {
  const quote = await issueQuote(await ratedSubmission(), { ...period(), subjectivities: "Signed application\nLoss runs" }, ACTOR);
  const policy = await bindQuote(quote.id, new Set(), ACTOR);
  assert.ok(await taskFor(policy.id));

  await markSubjectivityReceived(policy.id, 0, ACTOR);
  assert.ok(await taskFor(policy.id), "one still open");
  await assert.rejects(markSubjectivityReceived(policy.id, 0, ACTOR), /already marked received/);
  await assert.rejects(markSubjectivityReceived(policy.id, 9, ACTOR), /no such subjectivity/);
  await markSubjectivityReceived(policy.id, 1, ACTOR);
  assert.equal(await taskFor(policy.id), undefined);

  const { subjectivities } = (await policyDb.query<{ subjectivities: { status: string; received_by?: string; received_at?: string }[] }>("SELECT subjectivities FROM policies WHERE id = $1", [policy.id])).rows[0];
  assert.ok(subjectivities.every((s) => s.status === "received" && s.received_by === ACTOR && s.received_at));
  assert.equal((await auditTrail("policy", policy.id)).filter((e) => e.action === "policy.subjectivity_received").length, 2);
});

test("an accepted intake can be reopened to correct it until the file is bound (UX-058)", options, async () => {
  const sub = await ratedSubmission();
  await reopenIntake(sub, ACTOR);
  assert.equal((await fresh(sub.id)).status, "needs_review");
  assert.ok(await getWorksheet(sub.id), "the worksheet is kept");
  await assert.rejects(reopenIntake(await fresh(sub.id), ACTOR), /isn't accepted/);

  await acceptSubmission(sub.id, ACTOR);
  await bindQuote((await issueQuote(await fresh(sub.id), period(), ACTOR)).id, new Set(), ACTOR);
  await assert.rejects(reopenIntake(await fresh(sub.id), ACTOR), /endorsement/);
});

// --- a reopened intake (CR-181, CR-182, CR-183, CR-185, CR-191, CR-200, UX-081, UX-086, UX-092) ---

/** A quoted file reopened for corrections, with the quote that was out. */
async function reopenedQuoted() {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  await reopenIntake(await fresh(sub.id), ACTOR);
  return { sub, quote };
}

test("a correction on a reopened intake reaches the worksheet, and the rating and quote say they're out of date (CR-181, UX-081)", options, async () => {
  const { sub, quote } = await reopenedQuoted();
  await saveReview(sub.id, { "operations.gross_receipts": "1500000", "applicant.name": "Corrected Roofing LLC" }, ACTOR);
  await acceptSubmission(sub.id, ACTOR);

  const accepted = await fresh(sub.id);
  const ws = (await getWorksheet(sub.id))!;
  assert.equal(ws.rating_inputs.gross_receipts, 1_500_000);
  assert.equal(readiness(accepted, ws, await activeRateVersion()).rated, false, "the old rating no longer describes the file");
  const changed = (await auditTrail("submission", sub.id)).filter((e) => e.action === "worksheet.input_changed");
  assert.deepEqual(changed.map((e) => e.after), [{ gross_receipts: 1_500_000 }]);

  const { quoteCurrent, drift } = quoteDrift(await getQuote(quote.id), ws, accepted);
  assert.equal(quoteCurrent, false);
  assert.deepEqual(drift.map((d) => d.label), ["Gross receipts", "Named insured"]);
  assert.deepEqual(drift.find((d) => d.label === "Named insured"), { label: "Named insured", from: quote.insured_name, to: "Corrected Roofing LLC" });
});

test("a reopen with no corrections changes nothing the worksheet or the quote can see (CR-181)", options, async () => {
  const { sub, quote } = await reopenedQuoted();
  await acceptSubmission(sub.id, ACTOR);
  const accepted = await fresh(sub.id);
  const ws = (await getWorksheet(sub.id))!;
  assert.equal(readiness(accepted, ws, await activeRateVersion()).rated, true);
  assert.deepEqual(quoteDrift(await getQuote(quote.id), ws, accepted), { quoteCurrent: true, drift: [] });
});

test("nothing can be quoted or bound while the intake is reopened, even from a tab opened before (CR-182)", options, async () => {
  const { sub, quote } = await reopenedQuoted();
  await assert.rejects(issueQuote(sub, period(), ACTOR), /reopened for corrections/);
  await assert.rejects(bindQuote(quote.id, new Set(), ACTOR), /reopened for corrections/);
  assert.equal((await policyDb.query("SELECT 1 FROM policies WHERE submission_id = $1", [sub.id])).rowCount, 0);
  assert.ok(!(await actions("quote", quote.id)).includes("quote.bound"));
});

test("a reopen made while a bind is landing can't leave a bound file in review (CR-182)", options, async () => {
  const sub = await ratedSubmission();
  const quote = await issueQuote(sub, period(), ACTOR);
  const stale = await fresh(sub.id);
  await bindQuote(quote.id, new Set(), ACTOR);
  await assert.rejects(reopenIntake(stale, ACTOR), /bound as/);
  assert.equal((await fresh(sub.id)).status, "accepted");
});

test("accepting a reopened intake again keeps its insured and corrects it (CR-183)", options, async () => {
  const sub = await newSubmission({ accept: false });
  await customerDb.query("UPDATE submissions SET data = jsonb_set(data, '{applicant,fein}', '\"\"') WHERE id = $1", [sub.id]);
  await acceptSubmission(sub.id, ACTOR);
  const first = (await fresh(sub.id)).insured_id!;
  const insureds = async () => Number((await customerDb.query<{ n: string }>("SELECT count(*) AS n FROM insureds")).rows[0].n);
  const before = await insureds();

  await reopenIntake(await fresh(sub.id), ACTOR);
  const reopened = await fresh(sub.id);
  assert.equal(reopened.reviewed_by, null, "it isn't accepted by anyone while it is back in review");
  await saveReview(sub.id, { "applicant.name": "Renamed Roofing Co" }, ACTOR);
  await acceptSubmission(sub.id, ACTOR);

  assert.equal((await fresh(sub.id)).insured_id, first);
  assert.equal(await insureds(), before, "no second insured");
  const { rows } = await customerDb.query<{ name: string }>("SELECT name FROM insureds WHERE id = $1", [first]);
  assert.equal(rows[0].name, "Renamed Roofing Co");
  assert.ok((await actions("insured", first)).includes("insured.corrected"));
});

test("a file reopened after a decline is back on the desk, and its stage isn't the closed quote (CR-185, UX-086)", options, async () => {
  const sub = await ratedSubmission();
  await issueQuote(sub, period(), ACTOR);
  await declineSubmission(await fresh(sub.id), { reason: "Price" }, ACTOR);
  await reopenDeclined(await fresh(sub.id), ACTOR);
  assert.ok(await taskFor(sub.id), "a task to quote it again");
  assert.notEqual((await submissionStagesById([sub.id])).get(sub.id)?.key, "not_taken");

  const closedOnPurpose = await ratedSubmission();
  const q = await issueQuote(closedOnPurpose, period(), ACTOR);
  await closeQuote(q.id, { reason: "Lost on price" }, ACTOR);
  assert.equal(await taskFor(closedOnPurpose.id), undefined, "a quote closed as not taken keeps the file off the desk");
});

test("a reopened quoted file reads Needs review, and an expired quote reads Expired, wherever stages show (CR-191, UX-092)", options, async () => {
  const { sub } = await reopenedQuoted();
  assert.equal((await submissionStagesById([sub.id])).get(sub.id)?.key, "review");

  const lapsed = await ratedSubmission();
  const q = await issueQuote(lapsed, period(), ACTOR);
  await policyDb.query("UPDATE quotes SET valid_until = $2 WHERE id = $1", [q.id, addDays(todayIso(), -1)]);
  assert.equal((await submissionStagesById([lapsed.id])).get(lapsed.id)?.key, "expired");
});

test("a stale intake tab on a declined file is told it was declined, not accepted (CR-200)", options, async () => {
  const sub = await newSubmission({ accept: false });
  await declineSubmission(sub, { reason: "Incomplete submission" }, ACTOR);
  await assert.rejects(saveReview(sub.id, { "applicant.name": "X Co" }, ACTOR), /is declined; reopen it/);
  await assert.rejects(acceptSubmission(sub.id, ACTOR), /is declined; reopen it/);
});

// --- the gaps the Nov 20 review found in the reopen work (CR-183, CR-185, CR-220, CR-221) ---

test("a decline and a reopen racing on one file both finish, and the file ends declined with nothing out (CR-220)", { ...options, timeout: 20_000 }, async () => {
  const files: SubmissionRow[] = [];
  for (let i = 0; i < 4; i++) {
    const sub = await ratedSubmission();
    await issueQuote(sub, period(), ACTOR);
    files.push(await fresh(sub.id));
  }
  const started = Date.now();
  await Promise.all(files.map((sub) => Promise.allSettled([declineSubmission(sub, { reason: "Price" }, ACTOR), reopenIntake(sub, ACTOR)])));
  assert.ok(Date.now() - started < 10_000, "neither sat waiting on the other");
  for (const sub of files) {
    assert.equal((await fresh(sub.id)).status, "declined", "a reopen first is then declined; a decline first refuses the reopen");
    assert.equal((await policyDb.query("SELECT 1 FROM quotes WHERE submission_id = $1 AND status = 'issued'", [sub.id])).rowCount, 0);
  }
});

test("a decline or a reopen while a quote is being rated stops the quote (CR-221)", options, async () => {
  const interrupts: [string, (sub: SubmissionRow) => Promise<unknown>][] = [
    ["declined", (sub) => declineSubmission(sub, { reason: "Price" }, ACTOR)],
    ["reopened", (sub) => reopenIntake(sub, ACTOR)],
  ];
  for (const [what, interrupt] of interrupts) {
    const sub = await ratedSubmission();
    duringRating = async () => { await interrupt(await fresh(sub.id)); };
    await assert.rejects(issueQuote(sub, period(), ACTOR), what === "declined" ? /is declined/ : /reopened for corrections/);
    assert.equal((await policyDb.query("SELECT 1 FROM quotes WHERE submission_id = $1", [sub.id])).rowCount, 0, `no quote on a file ${what} mid-issue`);
  }

  // Should one exist anyway, the desk doesn't chase a quote on a declined file.
  const odd = await ratedSubmission();
  const quote = await issueQuote(odd, period(), ACTOR);
  await customerDb.query("UPDATE submissions SET status = 'declined' WHERE id = $1", [odd.id]);
  assert.equal(await taskFor(quote.id), undefined);
});

test("a file reopened after a decline is back on the desk even when it had a revised quote (CR-185)", options, async () => {
  const sub = await ratedSubmission();
  await issueQuote(sub, period(), ACTOR);
  await issueQuote(await fresh(sub.id), period(), ACTOR);   // v2 supersedes v1, and the decline closes only v2
  await declineSubmission(await fresh(sub.id), { reason: "Price" }, ACTOR);
  await reopenDeclined(await fresh(sub.id), ACTOR);
  assert.ok(await taskFor(sub.id), "a task to quote it again");
});

test("a FEIN corrected on a reopened intake keeps or moves the insured, quotes follow the file, and a bind lands on the file's insured (CR-183)", options, async () => {
  const feinOf = async (insuredId: string) => (await customerDb.query<{ fein: string }>("SELECT fein FROM insureds WHERE id = $1", [insuredId])).rows[0].fein;

  // A mistyped FEIN on a customer with no other files: the same customer, its FEIN corrected.
  const typo = await ratedSubmission();
  const typoQuote = await issueQuote(typo, period(), ACTOR);
  await reopenIntake(await fresh(typo.id), ACTOR);
  await saveReview(typo.id, { "applicant.fein": "87-0000001" }, ACTOR);
  await acceptSubmission(typo.id, ACTOR);
  assert.equal((await fresh(typo.id)).insured_id, typo.insured_id, "one customer, corrected");
  assert.equal(await feinOf(typo.insured_id!), "87-0000001");
  assert.ok((await actions("insured", typo.insured_id!)).includes("insured.corrected"));
  assert.equal((await bindQuote(typoQuote.id, new Set(), ACTOR)).insured_id, typo.insured_id);

  // A FEIN that names a company already on file: the file moves to it, and so does its quote.
  const other = await newSubmission();
  const moved = await ratedSubmission();
  const movedQuote = await issueQuote(moved, period(), ACTOR);
  await reopenIntake(await fresh(moved.id), ACTOR);
  await saveReview(moved.id, { "applicant.fein": await feinOf(other.insured_id!) }, ACTOR);
  await acceptSubmission(moved.id, ACTOR);
  const now = (await fresh(moved.id)).insured_id;
  assert.equal(now, other.insured_id, "the file belongs to the company that FEIN names");
  assert.equal((await getQuote(movedQuote.id))!.insured_id, now, "its quote moved with it");
  assert.ok((await actions("quote", movedQuote.id)).includes("quote.insured_changed"));
  assert.equal((await bindQuote(movedQuote.id, new Set(), ACTOR)).insured_id, now);
});
