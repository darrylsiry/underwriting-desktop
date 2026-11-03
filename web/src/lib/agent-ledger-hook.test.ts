import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// The hook behind App Tests' history, run for real against a throwaway project whose rebuild is a
// stand-in. It first shipped listening for Write and Edit, and never fired: the scheduled reviews
// copy their reports with a shell command. So nothing here depends on the tool or the input.

const HOOK = path.resolve("../scripts/agent-ledger-hook.sh");
const REPORTS = ["CODE_REVIEW", "SECURITY_REVIEW", "UX_REVIEW", "UAT_REPORT"];
const NOW = Math.floor(Date.now() / 1000);

function project(rebuild = "") {
  const root = mkdtempSync(path.join(tmpdir(), "ledger-hook-"));
  mkdirSync(path.join(root, "docs"));
  mkdirSync(path.join(root, "web/scripts"), { recursive: true });
  writeFileSync(path.join(root, "web/scripts/agent-ledger.ts"),
    `import { appendFileSync, utimesSync } from "node:fs";\nappendFileSync("rebuilds.txt", "x");\n${rebuild}\n`);
  const at = (file: string, secondsAgo: number) => utimesSync(path.join(root, file), NOW - secondsAgo, NOW - secondsAgo);
  for (const r of REPORTS) { writeFileSync(path.join(root, `docs/${r}.md`), "report"); at(`docs/${r}.md`, 3600); }
  writeFileSync(path.join(root, "docs/AGENT_LEDGER.json"), "{}");
  at("docs/AGENT_LEDGER.json", 1800);
  const run = (input = '{"tool_name":"Bash","tool_input":{"command":"cp a b"}}') => {
    const r = spawnSync("sh", [HOOK], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    return { status: r.status, stdout: r.stdout };
  };
  const rebuilds = () => (existsSync(path.join(root, "rebuilds.txt")) ? readFileSync(path.join(root, "rebuilds.txt"), "utf8").length : 0);
  return { root, at, run, rebuilds, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("no report newer than the ledger: nothing runs, whatever the tool", () => {
  const p = project();
  for (const tool of ["Bash", "Read", "Write", "Agent"]) assert.deepEqual(p.run(`{"tool_name":"${tool}"}`), { status: 0, stdout: "" });
  assert.equal(p.rebuilds(), 0);
  p.done();
});

test("any report newer than the ledger rebuilds once, however it got there", () => {
  for (const r of REPORTS) {
    const p = project();
    p.at(`docs/${r}.md`, 60);   // as `cp "$F" docs/…` leaves it: the hook never sees a file path
    assert.deepEqual(p.run(), { status: 0, stdout: "" });
    assert.equal(p.rebuilds(), 1, r);
    p.run();
    assert.equal(p.rebuilds(), 1, `${r}: dealt with, not rebuilt on every later tool`);
    p.done();
  }
});

test("a rebuild that writes nothing still counts as dealt with; a missing ledger is built", () => {
  const p = project();
  p.at("docs/UX_REVIEW.md", 60);
  p.run();
  p.run();
  assert.equal(p.rebuilds(), 1);
  rmSync(path.join(p.root, "docs/AGENT_LEDGER.json"));
  p.run();
  assert.equal(p.rebuilds(), 2);
  p.done();
});

test("a report written during the rebuild is caught by the next tool", () => {
  const p = project(`const t = ${NOW} + 60; utimesSync("docs/CODE_REVIEW.md", t, t);`);
  p.at("docs/UX_REVIEW.md", 60);
  p.run();
  assert.equal(p.rebuilds(), 1);
  p.run();
  assert.equal(p.rebuilds(), 2, "the code review arrived after the rebuild began");
  p.done();
});

test("a failed rebuild warns once as valid JSON, never blocks, and waits for the next report", () => {
  const p = project(`console.error("something \\"broke\\" badly"); process.exit(3);`);
  p.at("docs/CODE_REVIEW.md", 60);
  const first = p.run();
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).systemMessage, /^App Tests ledger not updated: .*broke/);
  assert.deepEqual(p.run(), { status: 0, stdout: "" }, "no warning on every later tool");
  assert.equal(p.rebuilds(), 1);
  p.at("docs/CODE_REVIEW.md", -60);
  assert.equal(JSON.parse(p.run().stdout).systemMessage.length > 0, true, "the next report tries again");
  p.done();
});

// Sending the reports to the deployment (step 30): after the rebuild, in the background, only where it is turned on.
const SENDS = "sends.txt";
function publishing(send = "") {
  const p = project();
  writeFileSync(path.join(p.root, "web/scripts/publish-reports.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync("${SENDS}", "x");\n${send}\n`);
  const sends = () => (existsSync(path.join(p.root, SENDS)) ? readFileSync(path.join(p.root, SENDS), "utf8").length : 0);
  const conf = path.join(p.root, ".fly-reports-publish");
  return { ...p, conf, sends, on: () => writeFileSync(conf, "url=https://example.test\ntoken=x\n") };
}
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(done(), "the background send never finished");
}

test("with publishing off nothing is sent, however the reports change", async () => {
  const p = publishing();
  p.at("docs/CODE_REVIEW.md", 60);
  assert.deepEqual(p.run(), { status: 0, stdout: "" });
  assert.equal(p.rebuilds(), 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.sends(), 0);
  p.done();
});

test("with publishing on a new report is sent once, without holding up the session", async () => {
  const p = publishing();
  p.on();
  p.at("docs/CODE_REVIEW.md", 60);
  assert.deepEqual(p.run(), { status: 0, stdout: "" });
  await until(() => existsSync(`${p.conf}.sent`));
  assert.equal(p.sends(), 1);
  assert.ok(!existsSync(`${p.conf}.try`), "a send that worked doesn't hold back the next");
  p.run();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.sends(), 1, "dealt with, not sent on every later tool");

  utimesSync(`${p.conf}.sent`, NOW - 60, NOW - 60);   // macOS's sh compares these to the second
  utimesSync(path.join(p.root, "docs/CODE_REVIEW.md"), NOW + 60, NOW + 60);
  p.run();
  await until(() => p.sends() === 2);
  p.done();
});

test("a failed send says why and waits five minutes before trying again", async () => {
  const p = publishing(`console.error("no route to host"); process.exit(1);`);
  p.on();
  p.at("docs/CODE_REVIEW.md", 60);
  p.run();
  await until(() => p.sends() === 1 && readFileSync(`${p.conf}.log`, "utf8").includes("no route to host"));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!existsSync(`${p.conf}.sent`));
  assert.deepEqual(p.run(), { status: 0, stdout: "" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.sends(), 1, "not on every tool while the site is unreachable");

  utimesSync(`${p.conf}.try`, NOW - 360, NOW - 360);
  p.run();
  await until(() => p.sends() === 2);
  p.done();
});
