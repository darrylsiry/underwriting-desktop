// Server side of App Tests (step 26): find the review agents' reports and the ledger, read them,
// and hand the parsed result to the page. Reads on every request, so the page is as current as
// its source: in a checkout that is docs/ itself, rewritten by every review run. On a deployment it
// is what the review machine last published (step 30), or the copy scripts/fly-deploy.sh bakes into
// the image when that is newer or publishing is off (no REPORTS_PUBLISH_TOKEN).
// Neither holds the security report, whose reproduction steps stay in the repository (CR-097):
// there the page shows security's findings from the ledger and /app-tests/security is a 404.

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { activityView, readLedger, type ActivityView } from "./agent-ledger.ts";
import { AGENTS, parseReport, type AgentKey, type ParsedReport } from "./agent-reports.ts";
import { LEDGER_FILE, ledgerTime, MOCKUP_FILE } from "./report-publish.ts";
import { DISPLAY_TIME_ZONE } from "./time.ts";

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

type ReportSource = {
  kind: "checkout" | "deployed copy" | "published";
  publishedAt: Date | null;
  read: (name: string) => Promise<FileRead | null>;
  mockups: () => Promise<Set<string>>;
};

function folderSource(dir: string): ReportSource {
  return {
    kind: dir.endsWith(`${path.sep}docs`) ? "checkout" : "deployed copy",
    publishedAt: null,
    read: (name) => readOptional(path.join(dir, name)),
    mockups: async () => {
      try {
        return new Set((await readdir(path.join(dir, "ux-mockups"))).filter((f) => /^UX-\d{3,4}\.html$/.test(f)).map((f) => f.replace(/\.html$/, "")));
      } catch {
        return new Set();
      }
    },
  };
}

/**
 * Where this request reads from. A checkout always reads its own docs/. A deployment takes the
 * published set unless the image's copy is newer, which a push made while publishing was failing can
 * do. If the database can't answer, the page still has the image's copy.
 */
async function reportSource(): Promise<ReportSource> {
  const dir = reportsDir();
  const folder = folderSource(dir);
  if (folder.kind === "checkout" || !process.env.REPORTS_PUBLISH_TOKEN?.trim()) return folder;
  try {
    const { loadPublished } = await import("./published-reports.ts");
    const set = await loadPublished();
    if (!set || ledgerTime(set.files.get(LEDGER_FILE)?.text) < ledgerTime((await folder.read(LEDGER_FILE))?.text)) return folder;
    return {
      kind: "published",
      publishedAt: set.publishedAt,
      read: async (name) => set.files.get(name) ?? null,
      mockups: async () => new Set([...set.files.keys()].flatMap((name) => MOCKUP_FILE.exec(name)?.[1] ?? [])),
    };
  } catch (err) {
    console.error("App Tests: couldn't read the published reports, showing the deployed copy", err);
    return folder;
  }
}

export type AgentActivity = {
  view: ActivityView;
  written: Partial<Record<AgentKey, Date>>;
  ledgerUpdatedAt: string | null;
  source: ReportSource["kind"];
  publishedAt: Date | null;
};

export async function loadAgentActivity(): Promise<AgentActivity> {
  const source = await reportSource();
  const [ledgerFile, ...files] = await Promise.all([source.read(LEDGER_FILE), ...AGENTS.map((a) => source.read(a.file))]);
  const reports: Partial<Record<AgentKey, ParsedReport>> = {};
  const written: Partial<Record<AgentKey, Date>> = {};
  AGENTS.forEach((a, i) => {
    const f = files[i];
    if (!f) return;
    reports[a.key] = parseReport(a.key, f.text, DISPLAY_TIME_ZONE);
    written[a.key] = f.mtime;
  });
  const ledger = readLedger(ledgerFile?.text ?? null);
  return { view: activityView(ledger, reports), written, ledgerUpdatedAt: ledger.updatedAt, source: source.kind, publishedAt: source.publishedAt };
}

/** One agent's report as written, with absolute paths into the checkout shortened to repository paths. */
export async function readReport(agent: AgentKey): Promise<{ text: string; mtime: Date } | null> {
  const info = AGENTS.find((a) => a.key === agent);
  if (!info) return null;
  const f = await (await reportSource()).read(info.file);
  return f && { text: f.text.replace(/\/(?:Users|home)\/[^\s`'"/]+\/(?:[^\s`'"/]+\/)*?underwriting-desktop\//g, ""), mtime: f.mtime };
}

/** A UX before/after mockup (docs/ux-mockups/UX-NNN.html), or null. */
export async function readMockup(id: string): Promise<string | null> {
  if (!/^UX-\d{3,4}$/.test(id)) return null;
  return (await (await reportSource()).read(`ux-mockups/${id}.html`))?.text ?? null;
}

/** Which UX findings have a mockup on file. */
export async function mockupIds(): Promise<Set<string>> {
  return (await reportSource()).mockups();
}
