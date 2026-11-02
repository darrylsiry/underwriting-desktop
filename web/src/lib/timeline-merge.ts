// One audit timeline from three sources: UW Desktop events (policy.audit_events), rate-table
// changes (rating service) and rating calls (rating service). Pure module for node:test.
import { DISPLAY_TIME_ZONE, when, whenDate } from "./time.ts";

export type Source = "desktop" | "rate_admin" | "rating";

export type TimelineEvent = {
  key: string;                 // unique across sources
  at: string;                  // ISO timestamp
  source: Source;
  actor: string;
  action: string;
  entityType: string;          // submission | quote | policy | insured | rate_version | rating
  entityId: string;
  entityLabel?: string;
  summary: string;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  recordedAt?: string;         // CR-074: when the row was really written, only when that isn't `at` (back-dated history)
};

export type DesktopRow = {
  id: number | string; occurred_at: Date | string; actor: string; action: string; entity_type: string; entity_id: string;
  summary: string; before: unknown; after: unknown; correlation_id: string; recorded_at?: Date | string | null;
};
export type RateAdminRow = {
  id: number; created_at: string; actor: string; action: string; entity: string | null; version_id: number;
  version_label: string; before: unknown; after: unknown; reason: string;
};
export type RatingRow = {
  id: string; created_at: string; requested_by: string; reference: string | null; rate_version: string;
  class_code: string | null; premium: string | null; total: string | null; recorded_at?: string | null;
};

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const money = (v: string | null) => (v == null ? "?" : `$${Math.round(Number(v)).toLocaleString("en-US")}`);

/**
 * CR-074: when the database wrote a row, if that isn't when the row says it happened (a minute's
 * grace), else undefined. Null means the row predates recorded_at, so there is nothing to show.
 */
export function recordedApart(at: Date | string, recorded: Date | string | null | undefined): string | undefined {
  if (!recorded) return undefined;
  return Math.abs(Date.parse(iso(recorded)) - Date.parse(iso(at))) > 60_000 ? iso(recorded) : undefined;
}
const recordedField = (at: Date | string, recorded: Date | string | null | undefined) => {
  const recordedAt = recordedApart(at, recorded);
  return recordedAt ? { recordedAt } : {};
};

export function fromDesktop(r: DesktopRow): TimelineEvent {
  return {
    key: `d-${r.id}`, at: iso(r.occurred_at), source: "desktop", actor: r.actor, action: r.action,
    entityType: r.entity_type, entityId: r.entity_id, summary: r.summary, before: r.before, after: r.after,
    correlationId: r.correlation_id, ...recordedField(r.occurred_at, r.recorded_at),
  };
}

export function fromRateAdmin(r: RateAdminRow): TimelineEvent {
  const what = r.entity ? ` ${r.entity}` : "";
  return {
    key: `a-${r.id}`, at: iso(r.created_at), source: "rate_admin", actor: r.actor, action: `rate_table.${r.action}`,
    entityType: "rate_version", entityId: String(r.version_id), entityLabel: r.version_label,
    summary: `Rates ${r.version_label}: ${r.action.replaceAll("_", " ")}${what}${r.reason ? ` (${r.reason})` : ""}`,
    before: r.before, after: r.after, correlationId: null,
  };
}

export function fromRating(r: RatingRow): TimelineEvent {
  return {
    key: `r-${r.id}`, at: iso(r.created_at), source: "rating", actor: r.requested_by, action: "rating.calculated",
    entityType: "rating", entityId: r.id, entityLabel: r.reference ?? undefined,
    summary: `Rated ${r.reference ?? "(no reference)"} on ${r.rate_version}: ${money(r.premium)} premium, ${money(r.total)} total`
      + (r.class_code ? ` (class ${r.class_code})` : ""),
    before: null, after: null, correlationId: null, ...recordedField(r.created_at, r.recorded_at),
  };
}

/** Newest first; ties keep a stable order. */
export function merge(...lists: TimelineEvent[][]): TimelineEvent[] {
  return lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
}

const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed submission id: anything else would fail the uuid column's cast with a 500 (CR-018). */
export const isSubmissionId = (s: string) => SUBMISSION_ID.test(s);

/**
 * Where one page of the timeline ends (CR-095). Each source returns its newest `limit` rows under
 * the same upper bound, so a source that hit the limit may hold more, and it is complete only down
 * to its oldest row. The page therefore stops at the youngest of those: above it every source is
 * complete, and everything below it waits for the next page, so no row repeats or falls between
 * pages. The cursor is 1 ms past that row, because rows bound together can share its exact time
 * and the limit may have split them: they all go to the next page, whose bound is exclusive. Only
 * if a whole page shares one instant, so that would not move on, does the cut fall on that instant.
 */
export function pageEnd(sources: { label: string; events: TimelineEvent[] }[], limit: number, before: string | null = null): { cappedBy: string[]; cursor: string | null } {
  const capped = sources.filter((s) => s.events.length >= limit);
  if (!capped.length) return { cappedBy: [], cursor: null };
  const oldest = (events: TimelineEvent[]) => Math.min(...events.map((e) => Date.parse(e.at)));
  const youngest = Math.max(...capped.map((s) => oldest(s.events)));
  const stuck = before !== null && youngest + 1 >= Date.parse(before);
  return { cappedBy: capped.map((s) => s.label), cursor: new Date(stuck ? youngest : youngest + 1).toISOString() };
}

/** The events of the page between `cursor` (inclusive) and `before` (exclusive). */
export function onPage(events: TimelineEvent[], cursor: string | null, before: string | null): TimelineEvent[] {
  const low = cursor ? Date.parse(cursor) : -Infinity;
  const high = before ? Date.parse(before) : Infinity;
  return events.filter((e) => { const at = Date.parse(e.at); return at >= low && at < high; });
}

export type Change = { field: string; before: unknown; after: unknown };

/** Field-level changes between two audit snapshots (objects compared key by key, anything else as a whole). */
export function changes(before: unknown, after: unknown): Change[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(before) || isObj(after)) {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
      .map((k) => ({ field: k, before: b[k], after: a[k] }));
  }
  if (before == null && after == null) return [];
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ field: "", before, after }];
}

export type Group = { correlationId: string | null; events: TimelineEvent[] };

const SANDWICH_MS = 5000;

/**
 * Consecutive events from the same user action (same correlation id) shown as one group. An
 * uncorrelated event (a rating engine call) that falls between two events of the same action,
 * within a few seconds, belongs to that action too: Save & rate logs a schedule change, calls the
 * engine, then logs the rating.
 */
export function groupByCorrelation(events: TimelineEvent[]): Group[] {
  const groups: Group[] = [];
  for (const [i, e] of events.entries()) {
    const last = groups[groups.length - 1];
    const next = events[i + 1];
    const sandwiched = !e.correlationId && last?.correlationId && next?.correlationId === last.correlationId
      && Math.abs(Date.parse(last.events[last.events.length - 1].at) - Date.parse(e.at)) <= SANDWICH_MS
      && Math.abs(Date.parse(next.at) - Date.parse(e.at)) <= SANDWICH_MS;
    if (last && ((e.correlationId && last.correlationId === e.correlationId) || sandwiched)) last.events.push(e);
    else groups.push({ correlationId: e.correlationId, events: [e] });
  }
  return groups;
}

/** Short display of an audit value: schedules as "safety -5%", subjectivities as "text: open (due …)", else compact JSON. */
export function display(v: unknown, max = 140): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? when(v) : v;   // UX-025
  if (Array.isArray(v) && v.length && v.every((i) => i && typeof i === "object" && "category" in i && "pct" in i)) {
    return (v as { category: string; pct: number }[]).map((i) => `${i.category} ${i.pct > 0 ? "+" : ""}${i.pct}%`).join(", ");
  }
  if (Array.isArray(v) && v.length && v.every((i) => i && typeof i === "object" && "text" in i && "status" in i)) {
    return (v as { text: string; status: string; due_date?: string | null }[])
      .map((i) => `${i.text}: ${i.status}${i.due_date ? ` (due ${whenDate(i.due_date)})` : ""}`).join("; ");
  }
  if (Array.isArray(v) && !v.length) return "none";
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export type Filters = { source?: string; entityType?: string; actor?: string; q?: string; from?: string; to?: string; correlation?: string };

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone` (UX-006: the From/To filters bucket days as the page shows them). */
export function dayIn(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function applyFilters(events: TimelineEvent[], f: Filters, timeZone = DISPLAY_TIME_ZONE): TimelineEvent[] {
  const q = f.q?.trim().toLowerCase();
  const day = (e: TimelineEvent) => dayIn(e.at, timeZone);
  return events.filter((e) =>
    (!f.correlation || e.correlationId === f.correlation)
    && (!f.source || e.source === f.source)
    && (!f.entityType || e.entityType === f.entityType)
    && (!f.actor || e.actor.toLowerCase() === f.actor.toLowerCase())
    && (!f.from || day(e) >= f.from)
    && (!f.to || day(e) <= f.to)
    && (!q || `${e.summary} ${e.action} ${e.actor} ${e.entityLabel ?? ""}`.toLowerCase().includes(q)));
}
