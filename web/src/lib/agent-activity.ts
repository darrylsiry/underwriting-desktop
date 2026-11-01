// Server side of App Tests (step 26): find the review agents' reports and the ledger, read them,
// and hand the parsed result to the page. Reads on every request, so the page is as current as
// the files: in a checkout that is docs/ itself, rewritten by every review run; on Fly it is the
// copy scripts/fly-deploy.sh bakes into the image (refreshed whenever a report change is pushed).

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { activityView, readLedger, type ActivityView } from "./agent-ledger";
import { AGENTS, parseReport, type AgentKey, type ParsedReport } from "./agent-reports";
import { DISPLAY_TIME_ZONE } from "./time";

/** docs/ when the app runs from a checkout; else agent-reports/ beside the server (the Fly image, or compose's mount). */
export function reportsDir(): string {
  if (process.env.AGENT_REPORTS_DIR) return process.env.AGENT_REPORTS_DIR;
  const docs = path.resolve(process.cwd(), "..", "docs");
  return existsSync(path.join(docs, AGENTS[0].file)) ? docs : path.join(process.cwd(), "agent-reports");
}

type FileRead = { text: string; mtime: Date };

async function readOptional(file: string): Promise<FileRead | null> {
  try {
    const [text, s] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { text, mtime: s.mtime };
  } catch {
    return null;
  }
}

export type AgentActivity = { view: ActivityView; written: Partial<Record<AgentKey, Date>>; ledgerUpdatedAt: string | null; source: "checkout" | "deployed copy" };

export async function loadAgentActivity(): Promise<AgentActivity> {
  const dir = reportsDir();
  const [ledgerFile, ...files] = await Promise.all([
    readOptional(path.join(dir, "AGENT_LEDGER.json")),
    ...AGENTS.map((a) => readOptional(path.join(dir, a.file))),
  ]);
  const reports: Partial<Record<AgentKey, ParsedReport>> = {};
  const written: Partial<Record<AgentKey, Date>> = {};
  AGENTS.forEach((a, i) => {
    const f = files[i];
    if (!f) return;
    reports[a.key] = parseReport(a.key, f.text, DISPLAY_TIME_ZONE);
    written[a.key] = f.mtime;
  });
  const ledger = readLedger(ledgerFile?.text ?? null);
  return { view: activityView(ledger, reports), written, ledgerUpdatedAt: ledger.updatedAt, source: dir.endsWith(`${path.sep}docs`) ? "checkout" : "deployed copy" };
}

/** One agent's report as written, with absolute paths into the checkout shortened to repository paths. */
export async function readReport(agent: AgentKey): Promise<{ text: string; mtime: Date } | null> {
  const info = AGENTS.find((a) => a.key === agent);
  if (!info) return null;
  const f = await readOptional(path.join(reportsDir(), info.file));
  return f && { text: f.text.replace(/\/(?:Users|home)\/[^\s`'"/]+\/(?:[^\s`'"/]+\/)*?underwriting-desktop\//g, ""), mtime: f.mtime };
}

/** A UX before/after mockup (docs/ux-mockups/UX-NNN.html), or null. */
export async function readMockup(id: string): Promise<string | null> {
  if (!/^UX-\d{3,4}$/.test(id)) return null;
  return (await readOptional(path.join(reportsDir(), "ux-mockups", `${id}.html`)))?.text ?? null;
}

/** Which UX findings have a mockup on file. */
export async function mockupIds(): Promise<Set<string>> {
  try {
    const { readdir } = await import("node:fs/promises");
    return new Set((await readdir(path.join(reportsDir(), "ux-mockups"))).filter((f) => /^UX-\d{3,4}\.html$/.test(f)).map((f) => f.replace(/\.html$/, "")));
  } catch {
    return new Set();
  }
}
