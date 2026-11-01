// The review agents' history for App Tests (step 26). Each report is overwritten by its next run
// and lists only what is open plus what closed since the run before, so the history lives in a
// ledger (docs/AGENT_LEDGER.json): every finding ever reported, its last known status, and every
// run. web/scripts/agent-ledger.ts builds it from git (each committed report version and the
// commits that cite finding IDs) and folds in each new run; the page folds the reports on disk
// over it, so it is current even before the ledger is rewritten. Pure.

import { AGENTS, agentOfId, citedIds, commitTitles, localDate, runDate, type AgentInfo, type AgentKey, type ItemStatus, type ParsedReport } from "./agent-reports.ts";

const NOTE_MAX = 400;   // the reviewer's closing note; the full text stays in the report

export type LedgerCommit = { sha: string; date: string; subject: string };

export type LedgerItem = {
  key: string;            // the ID; a UAT item also by title (the tester numbers each run afresh)
  id: string;
  agent: AgentKey;
  title: string;
  severity: string;
  status: ItemStatus;
  statusText: string;     // the agent's word (Open, New, Improved) or how it closed (Resolved, Fixed, No longer reported)
  firstSeen: string;      // YYYY-MM-DD
  lastSeen: string;       // ISO: the latest run or commit that said anything about it
  closedAt: string | null;
  closedNote: string;
  commits: LedgerCommit[]; // commits whose message cites the ID
};

export type LedgerRun = { agent: AgentKey; run: string; runAt: string | null; commit: string | null; open: number; closed: number };

export type Ledger = { version: 1; updatedAt: string | null; runs: LedgerRun[]; items: Record<string, LedgerItem> };

export type CommitInfo = { sha: string; date: string; subject: string; body: string };

export const emptyLedger = (): Ledger => ({ version: 1, updatedAt: null, runs: [], items: {} });

/** A ledger read from JSON, or an empty one when it is missing or unreadable. */
export function readLedger(json: string | null): Ledger {
  if (!json) return emptyLedger();
  try {
    const l = JSON.parse(json) as Ledger;
    return l && l.version === 1 && l.items && Array.isArray(l.runs) ? l : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (agent: AgentKey, id: string, title: string) => (agent === "uat" ? `${id}|${norm(title)}` : id);

/** A commit that only refreshes a report ("docs: UX review after batch 4 …") is evidence, not a fix. */
const isReportRefresh = (subject: string) => /^docs[:(]/i.test(subject);

/** The last commit citing the item that landed after `after` and no later than `until`, if it is a fix. */
function fixBetween(item: LedgerItem, after: string, until: string): LedgerCommit | undefined {
  return item.commits.filter((c) => c.date > after && c.date <= until && !isReportRefresh(c.subject)).at(-1);
}

function close(item: LedgerItem, status: Exclude<ItemStatus, "open">, at: string, statusText: string, note: string) {
  const fix = status === "resolved" ? fixBetween(item, item.lastSeen, at) : undefined;
  item.status = status;
  item.statusText = fix && statusText === "No longer reported" ? "Fixed" : statusText;
  item.closedAt = fix ? fix.date : at;
  item.closedNote = (note || (fix ? `Fixed in ${fix.sha}: ${fix.subject}` : "")).slice(0, NOTE_MAX);
  item.lastSeen = at;
}

/**
 * Fold one run's report into the ledger, as of `at` (the run's time). What it lists updates the
 * item; what it closes is closed; anything this agent had open before and the run no longer
 * mentions is closed as "No longer reported" (or "Fixed", with the commit, when a commit citing
 * it landed in between). Older information never overwrites newer, so folding is idempotent.
 */
export function foldReport(l: Ledger, r: ParsedReport, at: string): Ledger {
  const mentioned = new Set<string>();
  const runDay = runDate(r.run) ?? localDate(at);

  for (const it of r.items) {
    const key = keyOf(r.agent, it.id, it.title);
    mentioned.add(key);
    const firstSeen = it.firstSeen ?? runDay;
    const cur = l.items[key];
    if (!cur) {
      l.items[key] = {
        key, id: it.id, agent: r.agent, title: it.title, severity: it.severity, status: it.status, statusText: it.statusText,
        firstSeen, lastSeen: at, closedAt: it.status === "open" ? null : at, closedNote: "", commits: [],
      };
      continue;
    }
    if (firstSeen < cur.firstSeen) cur.firstSeen = firstSeen;
    if (at < cur.lastSeen) continue;
    cur.title = it.title || cur.title;
    cur.severity = it.severity || cur.severity;
    if (it.status === "open") {
      Object.assign(cur, { status: "open", statusText: it.statusText, closedAt: null, closedNote: "", lastSeen: at });
    } else if (cur.status !== it.status) close(cur, it.status, at, it.statusText, "");
    else cur.lastSeen = at;
  }

  for (const c of r.closed) {
    const key = r.agent === "uat" ? keyOf("uat", c.id, c.title) : c.id;
    mentioned.add(key);
    const cur = l.items[key];
    const label = c.status === "resolved" ? "Resolved" : c.status === "declined" ? "Declined" : "Accepted";
    if (!cur) {
      l.items[key] = {
        key, id: c.id, agent: r.agent, title: c.title, severity: "", status: c.status, statusText: label,
        firstSeen: runDay, lastSeen: at, closedAt: at, closedNote: c.note.slice(0, NOTE_MAX), commits: [],
      };
      continue;
    }
    cur.title ||= c.title;
    if (at < cur.lastSeen) continue;
    if (cur.status === c.status) { cur.closedNote ||= c.note.slice(0, NOTE_MAX); cur.lastSeen = at; continue; }
    close(cur, c.status, at, label, c.note);
  }

  for (const item of Object.values(l.items)) {
    if (item.agent !== r.agent || mentioned.has(item.key) || item.status !== "open" || item.lastSeen >= at) continue;
    close(item, "resolved", at, "No longer reported", "");
  }

  if (r.run && !l.runs.some((x) => x.agent === r.agent && x.run === r.run)) {
    l.runs.push({ agent: r.agent, run: r.run, runAt: r.runAt ?? at, commit: r.commit, open: r.items.filter((i) => i.status === "open").length, closed: r.closed.length });
    l.runs.sort((a, b) => (a.runAt ?? "").localeCompare(b.runAt ?? ""));
  }
  return l;
}

/**
 * Fold one commit: it is attached to every finding its message cites. A fix commit (anything but
 * a report refresh) citing an ID no report version on record shows is entered as fixed by it, so
 * findings that opened and closed between committed reports still appear in the history.
 */
export function foldCommit(l: Ledger, c: CommitInfo): Ledger {
  const ref: LedgerCommit = { sha: c.sha.slice(0, 7), date: c.date, subject: c.subject };
  const titles = isReportRefresh(c.subject) ? new Map<string, string>() : commitTitles(c.subject, c.body);
  for (const id of citedIds(`${c.subject}\n${c.body}`)) {
    const agent = agentOfId(id);
    if (!agent) continue;
    const target = Object.values(l.items).filter((i) => i.id === id).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
    if (target) {
      if (!target.commits.some((x) => x.sha === ref.sha)) target.commits.push(ref);
      target.title ||= titles.get(id) ?? "";
      continue;
    }
    if (isReportRefresh(c.subject) || agent === "uat") continue;
    l.items[id] = {
      key: id, id, agent, title: titles.get(id) ?? "", severity: "", status: "resolved", statusText: "Fixed",
      firstSeen: localDate(c.date), lastSeen: c.date, closedAt: c.date, closedNote: `Fixed in ${ref.sha}: ${c.subject}`, commits: [ref],
    };
  }
  return l;
}

// ---- What the page shows -------------------------------------------------------------------

export type AgentView = {
  info: AgentInfo;
  report: ParsedReport | null;
  open: LedgerItem[];
  resolved: LedgerItem[];
  declined: LedgerItem[];
  accepted: LedgerItem[];
  runs: LedgerRun[];
  openBySeverity: { severity: string; count: number }[];
  /** Fix commits that landed after the latest run for items it still lists: the next run will check them. */
  pendingFixes: Record<string, LedgerCommit[]>;
};

export type ActivityView = {
  agents: AgentView[];
  totals: { raised: number; open: number; resolved: number; declinedOrAccepted: number; runs: number; since: string | null };
};

const severityRank = (info: AgentInfo, s: string) => {
  const i = info.severities.indexOf(s);
  return i < 0 ? info.severities.length : i;
};
const idNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

/** Fold the reports on disk over the stored ledger and arrange it per agent for the page. */
export function activityView(stored: Ledger, reports: Partial<Record<AgentKey, ParsedReport>>, now: Date = new Date()): ActivityView {
  const l: Ledger = structuredClone(stored);
  for (const a of AGENTS) {
    const r = reports[a.key];
    if (r) foldReport(l, r, r.runAt ?? now.toISOString());
  }
  const items = Object.values(l.items);
  const agents = AGENTS.map((info): AgentView => {
    const mine = items.filter((i) => i.agent === info.key);
    const report = reports[info.key] ?? null;
    const open = mine.filter((i) => i.status === "open")
      .sort((a, b) => severityRank(info, a.severity) - severityRank(info, b.severity) || idNumber(a.id) - idNumber(b.id));
    const byClosed = (a: LedgerItem, b: LedgerItem) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "") || idNumber(a.id) - idNumber(b.id);
    const pendingFixes: Record<string, LedgerCommit[]> = {};
    const runAt = report?.runAt ?? null;
    if (runAt) for (const i of open) {
      const later = i.commits.filter((c) => c.date > runAt && !isReportRefresh(c.subject));
      if (later.length) pendingFixes[i.key] = later;
    }
    return {
      info, report, open, pendingFixes,
      resolved: mine.filter((i) => i.status === "resolved").sort(byClosed),
      declined: mine.filter((i) => i.status === "declined").sort(byClosed),
      accepted: mine.filter((i) => i.status === "accepted").sort(byClosed),
      runs: l.runs.filter((x) => x.agent === info.key),
      openBySeverity: info.severities.map((severity) => ({ severity, count: open.filter((i) => i.severity === severity).length })).filter((s) => s.count),
    };
  });
  const firstDates = [...items.map((i) => i.firstSeen), ...l.runs.map((r) => (r.runAt ?? "").slice(0, 10))].filter(Boolean).sort();
  return {
    agents,
    totals: {
      raised: items.length,
      open: items.filter((i) => i.status === "open").length,
      resolved: items.filter((i) => i.status === "resolved").length,
      declinedOrAccepted: items.filter((i) => i.status === "declined" || i.status === "accepted").length,
      runs: l.runs.length,
      since: firstDates[0] ?? null,
    },
  };
}
