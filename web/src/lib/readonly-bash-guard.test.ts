import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

// The hook that keeps the review agents read-only, run for real. CR-096 let through the checks they're
// told to run and output sent to /dev/null. Nothing that writes may come through with them.

const GUARD = path.resolve("../scripts/readonly-bash-guard.sh");
const run = (command: string, tool = "Bash") => spawnSync("bash", [GUARD], { input: JSON.stringify({ tool_name: tool, tool_input: { command } }), encoding: "utf8" });
const allowed = (command: string) => { const r = run(command); assert.equal(r.status, 0, `should pass: ${command}\n${r.stderr}`); };
const blocked = (command: string) => {
  const r = run(command);
  assert.equal(r.status, 2, `should be blocked: ${command}`);
  assert.match(r.stderr, /^Blocked by scripts\/readonly-bash-guard\.sh/);
};

test("the checks the reviewers are told to run pass, alone or chained", () => {
  for (const c of [
    "npx tsc --noEmit", "npx eslint .", "npm run lint", "npm test", "uv run --frozen pytest", "uv run --frozen pytest -q",
    "cd web && npx tsc --noEmit", "cd web && npm run lint", "cd web && npm test", "cd web && npx tsc --noEmit && npm run lint && npm test",
    "cd services/rating && uv run --frozen pytest -q", "cd services/ingestion && uv run --frozen pytest -q",
    "cd web && npm test 2>&1 | tail -20", "cd web; npx eslint . | head -40", "npm test 2>/dev/null",
  ]) allowed(c);
});

test("discarded output is not a write", () => {
  for (const c of [
    "grep -rn SEED web/src 2>/dev/null | head", "ls web >/dev/null", "ls web > /dev/null 2>&1", "git log --oneline 2>/dev/null",
    "find . -name x 2>/dev/null", "cat a &>/dev/null", "cat a >> /dev/null", "ls web 1>/dev/null; wc -l README.md", "(ls web 2>/dev/null)",
  ]) allowed(c);
});

test("what was already allowed still is", () => {
  for (const c of ["git log -5", "git status", "git diff HEAD", "grep -n x file", "wc -l f", "npm audit", "sed -n 1,5p f", 'python3 -c "print(1)"', "cat a 2>&1"]) allowed(c);
  assert.equal(run("rm -rf /", "Read").status, 0, "only Bash is the guard's business");
});

test("a check with anything added, or anything else beside it, is still refused", () => {
  for (const c of [
    "npm test > out.txt", "npm test 2> err.txt", "npm test >> out.txt", "npm test | tee out.txt", "npm test; rm -rf web", "npm test && git push",
    "cd web && npm test; touch x", "npm test\nrm x", "rm x && npm test", "npm test & rm x", "npx tsc --noEmit > types.txt", "npx tsc --noEmit && mv a b",
    "npm test -- --watch", "npm run lint -- --fix", "npx eslint . --fix", "npx eslint --fix .", "npx eslint web", "npx tsc", "npx tsc --outDir out", "npx tsc --noEmit --build",
    "npx prettier --write .", "npx rimraf web", "npm run build", "npm run dev", "npm install", "npm ci", "npm publish",
    "uv run --frozen pytest --cache-clear > x", "uv run --frozen python x.py", "uv run pytest", "uv sync", "uv add x", "$(npm test) > x",
  ]) blocked(c);
});

test("only /dev/null itself is exempt", () => {
  for (const c of [
    "echo x > /dev/null.txt", "echo x >/dev/nullfile", "echo x > /dev/null/../../tmp/x", "ls > /dev/null > out.txt", "ls 2>/dev/null >out.txt",
    "ls 2>/dev/null>out", "ls >/dev/null; rm x", "ls >/dev/null && git commit -m x", "echo x >/dev/null | tee out", "echo x > dev/null", "echo x > /tmp/dev/null", "echo x >/dev/null2",
  ]) blocked(c);
});

test("every other write stays blocked", () => {
  for (const c of [
    "echo x > f", "echo x >> notes.md", "cat a > b", "tee x", "sed -i s/a/b/ f", "sed -i.bak s/a/b/ f", "rm x", "mv a b", "cp a b", "mkdir d", "touch f", "chmod +x f",
    "ls | xargs rm", "sudo rm x", "git add .", "git commit -m x", "git push", "git checkout main", "git stash", "git reset --hard", "git worktree add x",
    "docker compose up", "docker run x", "fly deploy", "fly secrets set A=1", "gh pr create", "curl -X POST http://x", "curl -o f http://x", "wget http://x", "ssh host",
    "pip install x", "brew install x", `python3 -c "open('f','w').write('x')"`, `node -e "require('fs').writeFileSync('f','x')"`,
  ]) blocked(c);
});
