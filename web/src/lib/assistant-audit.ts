// The assistant's audit_search tool, apart from the databases so node:test can exercise it: the
// timeline and the reference lookup come in as arguments.
import { isIsoDate } from "./time.ts";
import { applyFilters, type TimelineEvent } from "./timeline-merge.ts";

type LoadedTimeline = {
  events: TimelineEvent[];
  labels: Map<string, string>;
  warnings: string[];
  scope: { submissionId: string; reference: string; applicant: string } | null;
  capped: boolean;
  cappedBy: string[];
  olderCursor: string | null;
};

export type AuditSearchDeps = {
  submissionIdFor: (ref: string) => Promise<string | null>;
  loadTimeline: (submissionId: string | undefined, range: { from?: string; to?: string }) => Promise<LoadedTimeline>;
};

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const limitOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 50; };

export const entityUrl = (type: string, id: string) => ({
  submission: `/submissions/${id}`, quote: `/quotes/${id}`, policy: `/policies/${id}`, insured: `/insureds/${id}`,
  book_policy: `/policies/book/${id}`, ledger: `/accounting?batch=${id}`, rate_version: `/admin/versions/${id}`,
} as Record<string, string>)[type] ?? `/audit?q=${encodeURIComponent(id)}`;

/** Tells the model what wasn't searched, so it reports a cut history as cut and not as "nothing happened" (CR-103). */
function cutNote(t: LoadedTimeline): string | undefined {
  if (!t.capped) return undefined;
  const where = t.olderCursor ? `nothing before ${t.olderCursor} was searched` : "older rows of this case were not searched";
  return `The history was cut: ${t.cappedBy.join(" and ")} reached the 500-row limit, so ${where}. Say so in the answer, and narrow from/to to look further back.`;
}

export async function auditSearch(a: Record<string, unknown>, deps: AuditSearchDeps) {
  const ref = str(a.submission_id);
  const notFound = { error: `No submission ${ref}. search_app finds a submission by name or reference.` };
  const subId = ref ? await deps.submissionIdFor(ref) : undefined;
  if (ref && !subId) return notFound;   // not the global timeline, which would pass for this file's history (CR-092)

  const from = str(a.from) || undefined;
  const to = str(a.to) || undefined;
  for (const day of [from, to]) if (day && !isIsoDate(day)) return { error: `${day} is not a date; use YYYY-MM-DD` };

  const t = await deps.loadTimeline(subId ?? undefined, { from, to });   // the dates reach the queries, so old events are findable (CR-103)
  if (subId && !t.scope) return notFound;

  const matching = applyFilters(t.events, { q: str(a.q) || undefined, actor: str(a.actor) || undefined, entityType: str(a.entity_type) || undefined, from, to });
  const events = matching.slice(0, limitOf(a.limit));
  return {
    scope: t.scope, warnings: t.warnings, count: events.length, total_matching: matching.length,
    capped: t.capped, capped_sources: t.cappedBy, oldest_loaded_at: t.olderCursor, note: cutNote(t),
    events: events.map((e) => ({ at: e.at, source: e.source, actor: e.actor, action: e.action, entity: `${e.entityType} ${t.labels.get(`${e.entityType}:${e.entityId}`) ?? e.entityLabel ?? e.entityId}`, summary: e.summary, url: entityUrl(e.entityType, e.entityId), correlation_id: e.correlationId })),
    audit_url: subId ? `/audit?submission=${subId}` : "/audit",
  };
}
