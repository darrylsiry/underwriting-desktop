// Build docs/AGENT_LEDGER.json: the review agents' history for the App Tests page (step 26).
//
//   node web/scripts/agent-ledger.ts              rebuild from git plus the reports on disk, write if changed
//   node web/scripts/agent-ledger.ts --check      print the totals, write nothing
//   node web/scripts/agent-ledger.ts report.md …  also fold earlier reports kept elsewhere: a run that
//                                                 was overwritten before the ledger saw it
//
// Each agent's report is overwritten by its next run, so history is folded together here in time
// order: every committed version of each report, every commit whose message cites a finding ID,
// then the reports on disk. It starts from the stored ledger, which remembers runs that were never
// committed. scripts/agent-ledger-hook.sh runs it as soon as a report is newer than the ledger
// (the PostToolUse hook in .claude/settings.json), so no run is lost. Rebuilding is idempotent.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { foldCommit, foldReport, readLedger, type CommitInfo, type Ledger } from "../src/lib/agent-ledger.ts";
import { AGENTS, agentOfReport, parseReport } from "../src/lib/agent-reports.ts";

const check = process.argv.includes("--check");
const earlierReports = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const docs = path.join(root, "docs");
const ledgerPath = path.join(docs, "AGENT_LEDGER.json");
const timeZone = process.env.DISPLAY_TZ || "America/New_York";

type Event = { at: string; order: number; apply: (l: Ledger) => void };
const events: Event[] = [];

// Every committed version of every report, dated by the run it records.
for (const a of AGENTS) {
  const rel = `docs/${a.file}`;
  const log = git("log", "--reverse", "--format=%H%x09%aI", "--", rel).trim();
  for (const line of log ? log.split("\n") : []) {
    const [sha, committed] = line.split("\t");
    let text: string;
    try { text = git("show", `${sha}:${rel}`); } catch { continue; }   // the commit that removed it
    const r = parseReport(a.key, text, timeZone);
    const at = r.runAt ?? new Date(committed).toISOString();
    events.push({ at, order: 1, apply: (l) => foldReport(l, r, at) });
  }
}

// Every commit whose message cites a finding (fixes carry the ID by convention).
const RS = "\x1e", US = "\x1f";
for (const rec of git("log", "--reverse", `--format=%H${US}%aI${US}%s${US}%b${RS}`).split(RS)) {
  const [sha, date, subject = "", body = ""] = rec.replace(/^\s+/, "").split(US);
  if (!sha || !/\b(CR|SEC|UX|UAT)-[A-Z]?\d/.test(`${subject}\n${body}`)) continue;
  const c: CommitInfo = { sha, date: new Date(date).toISOString(), subject, body };
  events.push({ at: c.date, order: 0, apply: (l) => foldCommit(l, c) });
}

// Earlier reports named on the command line, dated by the run each records.
for (const file of earlierReports) {
  const text = readFileSync(file, "utf8");
  const agent = agentOfReport(text);
  const r = agent && parseReport(agent, text, timeZone);
  if (!r?.runAt) {
    console.error(`agent ledger: ${file} is not a review report with a Run line; nothing written`);
    process.exit(1);
  }
  const at = r.runAt;
  events.push({ at, order: 1, apply: (l) => foldReport(l, r, at) });
}

// The reports on disk, usually newer than anything committed.
for (const a of AGENTS) {
  const file = path.join(docs, a.file);
  if (!existsSync(file)) continue;
  const r = parseReport(a.key, readFileSync(file, "utf8"), timeZone);
  const at = r.runAt ?? statSync(file).mtime.toISOString();
  events.push({ at, order: 2, apply: (l) => foldReport(l, r, at) });
}

const stored = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : null;
const ledger = readLedger(stored);
events.sort((x, y) => x.at.localeCompare(y.at) || x.order - y.order);
for (const e of events) e.apply(ledger);

// Stable output (items by agent, then ID number; commits by date) so the file diffs cleanly.
const agentOrder = (k: string) => AGENTS.findIndex((a) => a.key === k);
const num = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
const items = Object.values(ledger.items)
  .map((i) => ({ ...i, commits: [...i.commits].sort((a, b) => a.date.localeCompare(b.date)) }))
  .sort((a, b) => agentOrder(a.agent) - agentOrder(b.agent) || num(a.id) - num(b.id) || a.key.localeCompare(b.key));
const body = (updatedAt: string | null) => JSON.stringify({ ...ledger, updatedAt, items: Object.fromEntries(items.map((i) => [i.key, i])) }, null, 2) + "\n";

const previous = readLedger(stored);
const changed = body(null) !== JSON.stringify({ ...previous, updatedAt: null }, null, 2) + "\n";
const count = (s: string) => items.filter((i) => i.status === s).length;
const summary = `${items.length} findings (${count("open")} open, ${count("resolved")} resolved, ${count("declined") + count("accepted")} declined or accepted) across ${ledger.runs.length} runs`;

if (check) console.log(`agent ledger: ${summary}${changed ? " (would update)" : " (no change)"}`);
else if (changed) {
  // Whole or not at all: the page reads this file on every request, and two sessions may rebuild at once.
  const tmp = `${ledgerPath}.${process.pid}.tmp`;
  writeFileSync(tmp, body(new Date().toISOString()));
  renameSync(tmp, ledgerPath);
  console.log(`agent ledger: ${summary} → docs/AGENT_LEDGER.json`);
} else console.log(`agent ledger: ${summary} (no change)`);
