// The locks and multi-database orderings, against a throwaway Postgres (CR-014). Skipped when none is
// reachable, like services/rating/tests/conftest.py. Two databases are created for this process and
// dropped after; the rating service is stubbed, so no test depends on its rates.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
const { loadAgentActivity, mockupIds, readMockup, readReport } = await import("./agent-activity.ts");
const { addDays } = await import("./quote-terms.ts");
const { loadDashboard } = await import("./dashboard.ts");
const { migrate } = await import("./migrate.ts");
const { APP_TOOLS } = await import("./assistant-tools.ts");
const { bindQuote } = await import("./policies.ts");
const { storePublished } = await import("./published-reports.ts");
const { issueQuote } = await import("./quotes.ts");
const { startRenewal } = await import("./renewals.ts");
const { acceptSubmission, dataFingerprint, getSubmission, saveReview, storeSubmission } = await import("./submissions.ts");
const { todayIso } = await import("./time.ts");
const { StaleWorksheetError, worksheetFingerprint } = await import("./worksheet.ts");
const { clearReferral, flagsFor, getWorksheet, openWorksheet, saveAndRate } = await import("./worksheets.ts");

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
