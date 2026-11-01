// The four review agents' reports (docs/CODE_REVIEW.md, SECURITY_REVIEW.md, UX_REVIEW.md,
// UAT_REPORT.md) read into one shape for the App Tests page (step 26). Pure: no file access,
// so node:test drives it with fixtures, and web/scripts/agent-ledger.ts reuses it on old
// versions from git. The agents write Markdown, so the reader keys on the few things every
// run repeats (the Run line, `### ID — title` headings, `- **Status:**` bullets, the
// resolved / declined / accepted sections) and ignores everything else.

export type AgentKey = "code" | "security" | "ux" | "uat";

export type AgentInfo = {
  key: AgentKey;
  name: string;          // what the page calls it
  agent: string;         // the subagent's name in .claude/agents
  file: string;          // its report under docs/
  prefix: string;        // finding IDs: CR-066, SEC-001, UX-048, UAT-F1
  command: string;       // the slash command that runs it
  what: string;
  severities: string[];  // display order
};

export const AGENTS: AgentInfo[] = [
  { key: "code", name: "Code quality", agent: "code-auditor", file: "CODE_REVIEW.md", prefix: "CR", command: "/audit",
    what: "Reads the whole repository for bugs and quality issues", severities: ["Critical", "High", "Medium", "Low", "Suggestion"] },
  { key: "security", name: "Security", agent: "security-reviewer", file: "SECURITY_REVIEW.md", prefix: "SEC", command: "/security-audit",
    what: "Looks for vulnerabilities and insecure configuration", severities: ["Critical", "High", "Medium", "Low", "Informational"] },
  { key: "ux", name: "UX", agent: "ux-reviewer", file: "UX_REVIEW.md", prefix: "UX", command: "/ux-audit",
    what: "Uses every screen, form and flow as an underwriter would", severities: ["P1 Blocker", "P2 Major", "P3 Minor", "P4 Polish"] },
  { key: "uat", name: "UAT", agent: "uat-tester", file: "UAT_REPORT.md", prefix: "UAT", command: "/uat",
    what: "Tries every function end to end: writes on a sandbox, read-only on the live site", severities: ["Failure", "Observation"] },
];

export const agentInfo = (key: AgentKey) => AGENTS.find((a) => a.key === key)!;

/** The agent a finding ID belongs to (`SEC-012` → security), or null. */
export function agentOfId(id: string): AgentKey | null {
  const prefix = /^([A-Z]+)-/.exec(id)?.[1];
  return AGENTS.find((a) => a.prefix === prefix)?.key ?? null;
}

export type ItemStatus = "open" | "resolved" | "declined" | "accepted";

export type ReportItem = {
  id: string;
  title: string;
  severity: string;
  status: ItemStatus;
  statusText: string;            // as the agent wrote it: Open, New, Improved, Accepted …
  firstSeen: string | null;      // YYYY-MM-DD when the report says
  facts: Record<string, string>; // Effort, Demo risk, Classification … (short ones only)
};

export type ClosedNote = { id: string; title: string; status: Exclude<ItemStatus, "open">; note: string };

export type Table = { columns: string[]; rows: string[][] };

export type ParsedReport = {
  agent: AgentKey;
  run: string | null;          // as written: "2026-10-31 20:21"
  runAt: string | null;        // that wall-clock time in the display zone, as an ISO instant
  commit: string | null;       // the commit the run reviewed
  previousRun: string | null;
  headline: string;            // the paragraph under the summary table, or the UAT verdict
  summary: Table | null;       // the summary table as written
  items: ReportItem[];         // what the run lists (open, plus any marked Accepted/Declined in place)
  closed: ClosedNote[];        // resolved since last run, declined, accepted risks
};

const ID = String.raw`(?:CR|SEC|UX|UAT)-[A-Z]?\d+`;
const ITEM_HEADING = new RegExp(`^###\\s+(${ID})\\b[\\s:—–-]*(.*)$`);
const CLOSED_BULLET = new RegExp(`^-\\s+\\*\\*(${ID})\\s*[—–:-]*\\s*(.*?)\\*\\*\\s*[—–:-]*\\s*(.*)$`);
const FACT = /^-\s+\*\*([^*:]+):\*\*\s*(.*)$/;
const SHORT_FACTS = ["Effort", "Demo risk", "Classification"];

/** A wall-clock date and time in `timeZone` as a UTC ISO instant (`2026-10-31`, `20:21`, New York → `2026-11-01T00:21:00.000Z`). */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  const [h, m] = time.split(":").map(Number);
  const asUtc = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const v = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - t;
  };
  // The zone's offset at the guessed instant, checked once more for the DST changeover.
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}

/** The calendar date of an instant in `timeZone` (`2026-11-01T01:55Z` → `2026-10-31` in New York). */
export function localDate(iso: string, timeZone = "America/New_York"): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

/** The date a run's header names (`2026-10-31 20:21`, `2026-10-31, 21:55–22:01 EDT`), if any. */
export const runDate = (run: string | null) => (run && /(\d{4}-\d{2}-\d{2})/.exec(run)?.[1]) || null;

function runInstant(run: string | null, timeZone: string): string | null {
  const m = run && /(\d{4}-\d{2}-\d{2})[,\sT]+(\d{1,2}:\d{2})/.exec(run);
  return m ? zonedInstant(m[1], m[2], timeZone) : null;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function readTable(lines: string[], start: number): { table: Table; end: number } {
  let i = start;
  const rows: string[][] = [];
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    if (!/^\|?[\s:|-]+\|?$/.test(lines[i].trim())) rows.push(cells(lines[i]));   // skip the |---| rule
    i++;
  }
  return { table: { columns: rows[0] ?? [], rows: rows.slice(1) }, end: i };
}

function statusOf(text: string): { status: ItemStatus; label: string; firstSeen: string | null } {
  const word = text.replace(/\s*[(—–:;,].*$/, "").trim() || "Open";
  const firstSeen = /first seen (\d{4}-\d{2}-\d{2})/i.exec(text)?.[1] ?? null;
  const status: ItemStatus = /^accepted/i.test(word) ? "accepted" : /^declined/i.test(word) ? "declined"
    : /^(resolved|fixed|closed)/i.test(word) ? "resolved" : "open";
  // A chip, not a sentence: "Declined on 2026-10-31 by …" reads "Declined"; open items keep the agent's word (New, Improved).
  const label = status === "open" ? word.split(/\s+/).slice(0, 3).join(" ").slice(0, 24) : status[0].toUpperCase() + status.slice(1);
  return { status, label, firstSeen };
}

function severityOf(agent: AgentKey, section: string, id: string): string {
  if (agent === "uat") return /^UAT-F/.test(id) ? "Failure" : "Observation";
  const s = section.trim();
  return s === "Suggestions" ? "Suggestion" : s;
}

/** Read one agent's report. Anything the reader doesn't recognise is skipped, never fatal. */
export function parseReport(agent: AgentKey, markdown: string, timeZone = "America/New_York"): ParsedReport {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedReport = { agent, run: null, runAt: null, commit: null, previousRun: null, headline: "", summary: null, items: [], closed: [] };
  let section = "";
  let item: ReportItem | null = null;
  const firstSeenById = new Map<string, string>();
  const paragraphs = new Map<string, string>();   // first paragraph of each ## section

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Header block: "- **Run:** 2026-10-31 20:21" (reviews) or "Run: 2026-10-31, 21:55–22:01 EDT · code 9afd8c7 …" (UAT).
    if (!section) {
      const fact = FACT.exec(trimmed);
      if (fact) {
        const [, key, value] = fact;
        if (/^run$/i.test(key)) out.run = value.trim();
        else if (/^commit reviewed$/i.test(key)) out.commit = /`?([0-9a-f]{7,40})`?/.exec(value)?.[1] ?? null;
        else if (/^previous run$/i.test(key)) out.previousRun = value.replace(/\s*\(.*$/, "").trim();
        continue;
      }
      const uatRun = /^Run:\s*(.+)$/.exec(trimmed);
      if (uatRun) {
        out.run = uatRun[1].split("·")[0].trim();
        out.commit = /\bcode\s+`?([0-9a-f]{7,40})/.exec(uatRun[1])?.[1] ?? null;
        continue;
      }
    }

    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).trim();
      item = null;
      continue;
    }

    const heading = ITEM_HEADING.exec(trimmed);
    if (heading) {
      let title = heading[2].trim();
      const facts: Record<string, string> = {};
      if (agent === "uat") {
        const cls = /\s*\(([^()]*)\)\s*$/.exec(title);
        if (cls) { facts.Classification = cls[1]; title = title.slice(0, cls.index).trim(); }
      }
      item = { id: heading[1], title, severity: severityOf(agent, section, heading[1]), status: "open", statusText: "Open", firstSeen: null, facts };
      out.items.push(item);
      continue;
    }
    if (trimmed.startsWith("### ") || trimmed.startsWith("# ")) { item = null; continue; }

    // Resolved / declined / accepted bullets: "- **CR-069 — title** — resolved in `aa32db3` …".
    const closedKind = /^resolved/i.test(section) ? "resolved" : /^declined/i.test(section) ? "declined" : /^accepted/i.test(section) ? "accepted" : null;
    if (closedKind) {
      const b = CLOSED_BULLET.exec(trimmed);
      if (b) out.closed.push({ id: b[1], title: b[2].trim(), status: closedKind, note: b[3].trim() });
      continue;
    }

    if (trimmed.startsWith("|")) {
      const { table, end } = readTable(lines, i);
      i = end - 1;
      if (/^summary$/i.test(section) && !out.summary) out.summary = table;
      const idCol = table.columns.findIndex((c) => /^id$/i.test(c));
      const seenCol = table.columns.findIndex((c) => /first seen/i.test(c));
      if (idCol >= 0 && seenCol >= 0) for (const r of table.rows) if (r[idCol] && r[seenCol]) firstSeenById.set(r[idCol], r[seenCol]);
      continue;
    }

    if (item && !line.startsWith(" ") && !line.startsWith("\t")) {
      const fact = FACT.exec(trimmed);
      if (fact) {
        const [, key, value] = fact;
        if (/^status$/i.test(key)) {
          const s = statusOf(value);
          item.status = s.status;
          item.statusText = s.label;
          item.firstSeen = s.firstSeen;
        } else if (SHORT_FACTS.includes(key)) item.facts[key] = value.replace(/\s*\(.*$/, "").trim();
      }
      continue;
    }

    if (!item && section && trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("```") && !paragraphs.has(section)) {
      paragraphs.set(section, trimmed);
    }
  }

  for (const it of out.items) if (!it.firstSeen && firstSeenById.has(it.id)) it.firstSeen = firstSeenById.get(it.id)!;
  out.runAt = runInstant(out.run, timeZone);
  out.headline = (agent === "uat" ? paragraphs.get("Verdict") : paragraphs.get("Summary")) ?? "";
  return out;
}

/**
 * What a commit message says each finding was, for findings no report on record names:
 * subject segments that start with one ID ("fix: CR-077 whole-word claim statuses; CR-079 …")
 * and body paragraphs that start with an ID list ("CR-051, CR-065: refuse cross-site form posts (…").
 */
export function commitTitles(subject: string, body: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = (s: string) => s.replace(/\([^()]*\)/g, "").replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1")
    .replace(/[;(].*$/, "").replace(/[.:,\s]+$/, "").trim().replace(/^(.{139}).{2,}$/, "$1…");
  for (const seg of subject.replace(/^[a-z-]+(\([^)]*\))?:\s*/i, "").split(";")) {
    const m = new RegExp(`^\\s*(${ID})\\b[\\s:—–-]+(.+)$`).exec(seg);
    if (m && !new RegExp(ID).test(m[2])) out.set(m[1], clean(m[2]));
  }
  const head = new RegExp(`^(?:[-*]\\s+)?((?:${ID})(?:\\s*,\\s*(?:${ID}))*)\\s*:\\s*(.+)$`);
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i].trim());
    if (!m) continue;
    let text = m[2];
    while (i + 1 < lines.length && lines[i + 1].trim() && !head.test(lines[i + 1].trim())) text += " " + lines[++i].trim();
    // "CR-062, CR-055, CR-030: a; b; c" gives each ID its own clause, as written; otherwise they share one.
    const ids = m[1].split(/\s*,\s*/);
    const clauses = text.replace(/\([^()]*\)/g, "").split(";").map(clean).filter(Boolean);
    ids.forEach((id, n) => { if (!out.has(id)) out.set(id, clauses.length === ids.length ? clauses[n] : clean(text)); });
  }
  return out;
}

/**
 * Finding IDs a commit message cites, ranges included: "UX-042..047" and "CR-001 … CR-016"
 * expand to every number between (at most 60, so a typo can't explode).
 */
export function citedIds(text: string): string[] {
  const ids = new Set<string>();
  const range = /\b(CR|SEC|UX)-(\d{3})\s*(?:\.\.|…|–|—|-|to)\s*(?:\1-)?(\d{3})\b/g;
  for (const m of text.matchAll(range)) {
    const [from, to] = [Number(m[2]), Number(m[3])];
    if (to > from && to - from <= 60) for (let n = from; n <= to; n++) ids.add(`${m[1]}-${String(n).padStart(3, "0")}`);
  }
  for (const m of text.matchAll(new RegExp(`\\b${ID}\\b`, "g"))) ids.add(m[0]);
  return [...ids];
}
