import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_START, SEEDED_WARNING, advanceFile, generateRisks, runSeedHistory, type SeedFile, type SeedPipeline, type SeedRisk } from "./seed-risks.ts";

const UWS = ["underwriter1", "underwriter2", "underwriter3"];
const DAY = new Date("2026-10-20T12:00:00Z");
const daysLater = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const feins = (risks: SeedRisk[]) => risks.map((r) => r.fein);

// ---- which insureds a run generates (CR-121) -----------------------------------------------------

test("the same insureds whatever day the set is generated", () => {
  const first = generateRisks(50, UWS, DAY);
  assert.equal(new Set(feins(first)).size, 50, "every file its own insured");
  for (const later of [1, 26, 60, 120, 400]) {
    const again = generateRisks(50, UWS, daysLater(DAY, later));
    assert.deepEqual(feins(again), feins(first), `FEINs ${later} days later`);
    assert.deepEqual(again.map((r) => r.name), first.map((r) => r.name), `names ${later} days later`);
  }
  // 2026-12-15 is the restart that produced 8 unknown FEINs with the old shared stream.
  assert.deepEqual(feins(generateRisks(50, UWS, new Date("2026-12-15T12:00:00Z"))), feins(first));
  assert.deepEqual(feins(generateRisks(20, UWS, DAY)).length, 20);
});

test("deterministic for a day, with bound dates in the past and a subjectivity left open only on recent files", () => {
  const risks = generateRisks(50, UWS, DAY);
  assert.deepEqual(generateRisks(50, UWS, DAY), risks);
  for (const r of risks) {
    assert.ok(r.times.bound < DAY, `${r.name} bound in the past`);
    assert.ok(r.effective >= HISTORY_START);
    assert.ok(r.times.received < r.times.accepted && r.times.accepted < r.times.rated && r.times.rated < r.times.issued);
    if (r.leaveOneSubjectivityOpen) assert.ok(DAY.getTime() - r.times.bound.getTime() < 45 * 86_400_000);
  }
  assert.ok(risks.some((r) => r.leaveOneSubjectivityOpen));
  assert.ok(risks.some((r) => !r.leaveOneSubjectivityOpen));
});

test("the marker a live database already holds doesn't change", () => {
  assert.equal(SEEDED_WARNING, "Carried over from the quoting history: the broker's documents were not kept with this file; the extracted values were confirmed at intake.");
  for (const r of generateRisks(5, UWS, DAY)) assert.deepEqual(r.extraction.warnings, [SEEDED_WARNING]);
});

test("seeded documents use the extraction contract's values (CR-075)", () => {
  for (const r of generateRisks(20, UWS, DAY)) {
    const [application, ...rest] = r.extraction.documents;
    assert.equal(application.doc_type, "acord_application");
    assert.equal(application.method, "form_field");
    for (const d of rest) assert.deepEqual([d.doc_type, d.method], ["loss_run", "claude"]);
    for (const f of Object.values(r.extraction.fields)) assert.equal(f.method, "form_field");
  }
});

// ---- what a run does, against an in-memory pipeline ----------------------------------------------

type Row = { file: SeedFile; fein: string };

/** Behaves like the real steps; `ratingDown` makes rating fail, like a stopped service. */
function memoryPipeline(preexisting: { boundFiles?: number; unfinishedFiles?: number } = {}) {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  const insureds = new Set<string>();
  const ctl = { ratingDown: false, ready: 0, refer: new Set<string>() };
  let seq = 0;
  const add = (fein: string, file: Partial<SeedFile>) => {
    const id = `file-${++seq}`;
    rows.set(id, { fein, file: { accepted: false, rated: false, openReferrals: [], quote: null, policy: null, ...file } });
    return id;
  };
  for (let i = 0; i < (preexisting.boundFiles ?? 0); i++) add(`old-${i}`, { accepted: true, rated: true, policy: { policy_number: `GL-OLD-${i}`, total: "1000" } });
  for (let i = 0; i < (preexisting.unfinishedFiles ?? 0); i++) add(`old-unfinished-${i}`, { accepted: true });
  const file = (id: string) => rows.get(id)!.file;
  const p: SeedPipeline = {
    counts: async () => ({ files: rows.size, bound: [...rows.values()].filter((r) => r.file.policy).length }),
    ready: async () => { ctl.ready++; return "2026.1"; },
    findFile: async (risk) => [...rows.entries()].find(([, r]) => r.fein === risk.fein)?.[0] ?? null,
    insuredExists: async (risk) => insureds.has(risk.fein),
    store: async (risk) => { calls.push(`store ${risk.fein}`); return add(risk.fein, {}); },
    state: async (id) => structuredClone(file(id)),
    accept: async (id, risk) => { calls.push(`accept ${risk.fein}`); file(id).accepted = true; insureds.add(risk.fein); },
    rate: async (id, risk) => {
      calls.push(`rate ${risk.fein}`);
      if (ctl.ratingDown) throw new Error("Rating service unreachable");
      file(id).rated = true;
      file(id).openReferrals = ctl.refer.has(risk.fein) ? ["HEIGHT"] : [];
    },
    clear: async (id, code, risk) => { calls.push(`clear ${code} ${risk.fein}`); file(id).openReferrals = file(id).openReferrals.filter((c) => c !== code); },
    issue: async (id, risk) => {
      calls.push(`issue ${risk.fein}`);
      file(id).quote = { id: `quote-${id}`, subjectivities: ["Signed application", "Loss runs"] };
      return file(id).quote!;
    },
    bind: async (quoteId, received, risk) => {
      calls.push(`bind ${risk.fein} ${[...received].join(",")}`);
      const row = rows.get(quoteId.replace("quote-", ""))!;
      row.file.quote = null;
      row.file.policy = { policy_number: `GL-${row.fein}`, total: "5000" };
      return row.file.policy;
    },
  };
  return { p, rows, calls, ctl };
}

const quiet = () => {};

test("seeds the whole set, each file through every step exactly once", async () => {
  const { p, calls, ctl } = memoryPipeline();
  const risks = generateRisks(10, UWS, DAY);
  ctl.refer.add(risks[3].fein);
  const lines: string[] = [];
  const s = await runSeedHistory(10, risks, p, (m) => lines.push(m));
  assert.deepEqual(s, { made: 10, present: 0, failed: 0 });
  assert.deepEqual(calls.filter((c) => c.startsWith("clear")), ["clear HEIGHT " + risks[3].fein]);
  for (const step of ["store", "accept", "rate", "issue", "bind"]) assert.equal(calls.filter((c) => c.startsWith(step)).length, 10, step);
  assert.match(lines.at(-1)!, /^done: 10 bound, 0 failed/);
});

test("the live site: its 50 are bound under older FEINs, so a restart seeds nothing, and doesn't wait for rating", async () => {
  const { p, calls, ctl } = memoryPipeline({ boundFiles: 50 });
  const s = await runSeedHistory(50, generateRisks(50, UWS, DAY), p, quiet);
  assert.deepEqual(s, { made: 0, present: 50, failed: 0 });
  assert.deepEqual(calls, []);
  assert.equal(ctl.ready, 0);
});

test("restarting the next day, or sixty days later, changes nothing", async () => {
  const { p, calls } = memoryPipeline();
  await runSeedHistory(50, generateRisks(50, UWS, DAY), p, quiet);
  const before = calls.length;
  for (const later of [1, 60]) {
    assert.deepEqual(await runSeedHistory(50, generateRisks(50, UWS, daysLater(DAY, later)), p, quiet), { made: 0, present: 50, failed: 0 });
  }
  assert.equal(calls.length, before);
});

test("a file left unfinished under an older FEIN stops the count from over-seeding, whatever else happens", async () => {
  const { p, calls, rows } = memoryPipeline({ boundFiles: 49, unfinishedFiles: 1 });
  const s = await runSeedHistory(50, generateRisks(50, UWS, DAY), p, quiet);
  assert.deepEqual(calls, [], "no new customers, no new policies");
  assert.equal(rows.size, 50);
  assert.deepEqual(s, { made: 0, present: 0, failed: 0 });
});

test("a run never starts more files than asked, even with older files on record", async () => {
  const { p, rows } = memoryPipeline({ boundFiles: 30 });
  await runSeedHistory(50, generateRisks(50, UWS, DAY), p, quiet);
  assert.equal(rows.size, 50);
  assert.equal((await p.counts()).bound, 50);
});

test("rating stops mid-seed: the next run finishes every file and repeats nothing (CR-076)", async () => {
  const { p, calls, ctl } = memoryPipeline();
  const risks = generateRisks(50, UWS, DAY);
  const realRate = p.rate;
  let rated = 0;
  p.rate = async (id, risk) => { if (++rated === 21) ctl.ratingDown = true; return realRate(id, risk); };

  const lines: string[] = [];
  const first = await runSeedHistory(50, risks, p, (m) => lines.push(m));
  assert.equal(first.made, 20);
  assert.equal(first.failed, 30);
  assert.equal((await p.counts()).files, 50);
  assert.match(lines.at(-1)!, /^done: 20 bound, 30 failed/);

  ctl.ratingDown = false;
  calls.length = 0;
  const lines2: string[] = [];
  const second = await runSeedHistory(50, risks, p, (m) => lines2.push(m));
  assert.deepEqual(second, { made: 30, present: 20, failed: 0 });
  assert.match(lines2.at(-1)!, /^done: 50 bound, 0 failed/);
  assert.equal(calls.filter((c) => c.startsWith("store")).length, 0, "nothing new is stored");
  assert.equal(calls.filter((c) => c.startsWith("accept")).length, 0, "accepted files aren't accepted twice");
  assert.equal(calls.filter((c) => c.startsWith("rate")).length, 30);
  assert.equal(calls.filter((c) => c.startsWith("bind")).length, 30);

  assert.deepEqual(await runSeedHistory(50, risks, p, quiet), { made: 0, present: 50, failed: 0 }, "and then it's done");
});

test("a file resumes from the step it stopped at", async () => {
  const risk = generateRisks(1, UWS, DAY)[0];
  const stopped: [string, Partial<SeedFile>, string[]][] = [
    ["received", {}, ["accept", "rate", "issue", "bind"]],
    ["accepted", { accepted: true }, ["rate", "issue", "bind"]],
    ["rated", { accepted: true, rated: true }, ["issue", "bind"]],
    ["rated with a referral open", { accepted: true, rated: true, openReferrals: ["HEIGHT"] }, ["clear", "issue", "bind"]],
    ["quoted", { accepted: true, rated: true, quote: { id: "quote-file-1", subjectivities: ["a"] } }, ["bind"]],
  ];
  for (const [label, state, expected] of stopped) {
    const { p, rows, calls } = memoryPipeline();
    await p.store(risk);
    Object.assign(rows.get("file-1")!.file, state);
    calls.length = 0;
    assert.ok(await advanceFile("file-1", risk, p), label);
    assert.deepEqual(calls.map((c) => c.split(" ")[0]), expected, label);
  }
});

test("a bound file is left alone, and only the last subjectivity stays open when the file says so", async () => {
  const risk = { ...generateRisks(1, UWS, DAY)[0], leaveOneSubjectivityOpen: true };
  const { p, calls } = memoryPipeline();
  const id = await p.store(risk);
  await advanceFile(id, risk, p);
  assert.equal(calls.at(-1), `bind ${risk.fein} 0`, "of two subjectivities, the first is received and the second stays open");
  calls.length = 0;
  assert.equal(await advanceFile(id, risk, p), null);
  assert.deepEqual(calls, []);
});

test("a file that still can't be quoted fails with the reason, and the run carries on", async () => {
  const { p, calls, ctl } = memoryPipeline();
  p.clear = async () => {};   // the referral stays open
  const risks = generateRisks(5, UWS, DAY);
  ctl.refer.add(risks[0].fein);
  const lines: string[] = [];
  const s = await runSeedHistory(5, risks, p, (m) => lines.push(m));
  assert.equal(s.failed, 1);
  assert.equal(s.made, 4);
  assert.ok(lines.some((l) => /FAILED .*not ready to quote \(rated true, open HEIGHT\)/.test(l)));
  assert.ok(!calls.includes("issue " + risks[0].fein));
});

test("an insured that isn't one of ours is not given a seeded policy", async () => {
  const { p, calls } = memoryPipeline();
  const risks = generateRisks(3, UWS, DAY);
  p.insuredExists = async (risk) => risk.fein === risks[1].fein;
  const s = await runSeedHistory(3, risks, p, quiet);
  assert.deepEqual(s, { made: 2, present: 1, failed: 0 });
  assert.ok(!calls.some((c) => c.includes(risks[1].fein)));
});
