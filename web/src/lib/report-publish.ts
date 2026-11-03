// What may be published to App Tests on a deployment (step 30). Pure, so node:test drives it, and
// web/scripts/publish-reports.ts applies the same rules before it sends anything.

import { createHash, timingSafeEqual } from "node:crypto";
import { AGENTS, agentOfReport } from "./agent-reports.ts";

export const LEDGER_FILE = "AGENT_LEDGER.json";
export const MAX_PUBLISH_BYTES = 4 * 1024 * 1024;   // today's whole set is about 350 KB
export const MOCKUP_FILE = /^ux-mockups\/(UX-\d{3,4})\.html$/;

/** The reports a deployment may hold: what scripts/fly-deploy.sh copies, so never the security report (CR-097). */
export const PUBLISHABLE_REPORTS = AGENTS.filter((a) => !a.repositoryOnly);

export type PublishedFile = { name: string; text: string; written_at: string };

/** True when `header` ("Bearer <token>") carries exactly this token. Compares digests, so the length isn't given away either. */
export function bearerOk(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

/** When a ledger last changed, or 0 if it can't say. It is rebuilt whenever a report changes, so it dates the whole set. */
export function ledgerTime(json: string | null | undefined): number {
  try {
    return Date.parse((JSON.parse(json ?? "") as { updatedAt?: string }).updatedAt ?? "") || 0;
  } catch {
    return 0;
  }
}

function fileProblem(name: string, text: string): string | null {
  if (name === LEDGER_FILE) {
    try {
      const l = JSON.parse(text) as { version?: unknown; updatedAt?: unknown; runs?: unknown; items?: unknown };
      return l.version === 1 && typeof l.updatedAt === "string" && Array.isArray(l.runs) && typeof l.items === "object" && l.items ? null : `${name} isn't a ledger`;
    } catch {
      return `${name} isn't valid JSON`;
    }
  }
  if (MOCKUP_FILE.test(name)) return null;
  const agent = PUBLISHABLE_REPORTS.find((a) => a.file === name);
  if (!agent) return `${name} can't be published`;
  return agentOfReport(text) === agent.key ? null : `${name} isn't that agent's report`;
}

/** The files in a publish, or why the whole of it is refused. A bad file never reaches the page, and neither does half a set. */
export function checkPublish(payload: unknown): { files: PublishedFile[] } | { error: string } {
  const files = (payload as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return { error: "Send { files: [{ name, text, written_at }] }" };
  const seen = new Set<string>();
  for (const f of files as Partial<PublishedFile>[]) {
    if (typeof f?.name !== "string" || typeof f.text !== "string" || typeof f.written_at !== "string") return { error: "Each file needs a name, text and written_at" };
    if (seen.has(f.name)) return { error: `${f.name} appears twice` };
    seen.add(f.name);
    if (!f.text.trim()) return { error: `${f.name} is empty` };
    if (f.text.includes("\u0000")) return { error: `${f.name} holds a NUL` };   // Postgres text can't store one
    if (Number.isNaN(Date.parse(f.written_at))) return { error: `${f.name} has an unreadable written_at` };
    const problem = fileProblem(f.name, f.text);
    if (problem) return { error: problem };
  }
  if (!seen.has(LEDGER_FILE)) return { error: `A publish needs ${LEDGER_FILE}` };
  return { files: files as PublishedFile[] };
}
