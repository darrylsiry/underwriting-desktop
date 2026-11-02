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
