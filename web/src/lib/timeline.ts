import { customerDb, policyDb } from "./db";
import { RATING_TIMEOUT_MS } from "./rating-api";
import { RATING_SERVICE_URL } from "./services";
import { DISPLAY_TIME_ZONE } from "./time";
import {
  fromDesktop, fromRateAdmin, fromRating, merge,
  type DesktopRow, type RateAdminRow, type RatingRow, type TimelineEvent,
} from "./timeline-merge";

const LIMIT = 500;

export type Timeline = {
  events: TimelineEvent[];
  labels: Map<string, string>;     // "quote:<id>" -> "Q-2026-0001 v3"
  warnings: string[];              // e.g. rating service unreachable
  scope: { submissionId: string; reference: string; applicant: string } | null;
  // UX-044 / UX-048: the desk's newest-N cap, by time, so the page can say when history was cut and offer the next page.
  capped: boolean;
  oldestDesktopAt: string | null;   // ISO instant of the oldest desk event on this page
};

/** UX-044: a From/To day range (in the display zone) and, UX-048, an "older than this instant" cursor (ISO), applied in the queries. */
export type TimelineRange = { from?: string; to?: string; before?: string };
const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isInstant = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
/** An ISO instant as the display zone's wall clock, `YYYY-MM-DDTHH:mm:ss`, for the rating service's since/until. */
function wallClock(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

async function ratingApi<T>(path: string, warnings: string[]): Promise<T[]> {
  try {
    const res = await fetch(`${RATING_SERVICE_URL}${path}`, { cache: "no-store", signal: AbortSignal.timeout(RATING_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    warnings.push(`Rating service events unavailable (${(err as Error).message}); showing UW Desktop events only`);
    return [];
  }
}

/**
 * The audit timeline across services. With `submissionId`, only that case: the submission, its
 * quotes and policies, its insured, and rating calls referencing it (SUB-… or its quote numbers).
 */
export async function loadTimeline(submissionId?: string, range: TimelineRange = {}): Promise<Timeline> {
  const warnings: string[] = [];
  let scope: Timeline["scope"] = null;
  let desktopRows: DesktopRow[];
  let ratingRows: RatingRow[] = [];
  let adminRows: RateAdminRow[] = [];

  if (submissionId) {
    const sub = (await customerDb.query<{ id: string; reference: string; applicant_name: string; insured_id: string | null }>(
      "SELECT id, reference, applicant_name, insured_id FROM submissions WHERE id = $1", [submissionId])).rows[0];
    if (!sub) return { events: [], labels: new Map(), warnings: ["Submission not found"], scope: null, capped: false, oldestDesktopAt: null };
    scope = { submissionId: sub.id, reference: sub.reference, applicant: sub.applicant_name };
    const [quotes, policies] = await Promise.all([
      policyDb.query<{ id: string; quote_number: string }>("SELECT id, quote_number FROM quotes WHERE submission_id = $1", [sub.id]),
      policyDb.query<{ id: string }>("SELECT id FROM policies WHERE submission_id = $1", [sub.id]),
    ]);
    const entities = [
      ["submission", sub.id], ...quotes.rows.map((q) => ["quote", q.id]), ...policies.rows.map((p) => ["policy", p.id]),
      ...(sub.insured_id ? [["insured", sub.insured_id]] : []),
    ];
    desktopRows = (await policyDb.query<DesktopRow>(
      `SELECT * FROM audit_events WHERE (entity_type, entity_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
       ORDER BY id DESC LIMIT ${LIMIT}`,
      [entities.map((e) => e[0]), entities.map((e) => e[1])])).rows;
    const prefixes = [sub.reference, ...new Set(quotes.rows.map((q) => q.quote_number))];
    ratingRows = (await Promise.all(prefixes.map((p) =>
      ratingApi<RatingRow>(`/ratings?reference_prefix=${encodeURIComponent(p)}&limit=${LIMIT}`, warnings)))).flat();
  } else {
    // UX-044: the day range reaches the database (in the display zone), so January is findable even when
    // the newest 500 stop in March. UX-048: newest *by time* (row ids are not time order once history is
    // seeded after live files), and `before` is an instant that cuts every feed the same way.
    const from = isDay(range.from) ? range.from! : null;
    const to = isDay(range.to) ? range.to! : null;
    const before = isInstant(range.before) ? range.before! : null;
    const qs = new URLSearchParams({ limit: String(LIMIT) });
    if (from) qs.set("since", `${from}T00:00:00`);
    if (to) qs.set("until", `${to}T23:59:59.999`);
    if (before) qs.set("until", wallClock(before, DISPLAY_TIME_ZONE));
    qs.set("tz", DISPLAY_TIME_ZONE);
    [desktopRows, ratingRows, adminRows] = await Promise.all([
      policyDb.query<DesktopRow>(
        `SELECT * FROM audit_events
          WHERE ($1::date IS NULL OR occurred_at >= ($1::date::timestamp AT TIME ZONE $4))
            AND ($2::date IS NULL OR occurred_at < (($2::date + 1)::timestamp AT TIME ZONE $4))
            AND ($3::timestamptz IS NULL OR occurred_at < $3::timestamptz)
          ORDER BY occurred_at DESC, id DESC LIMIT ${LIMIT}`,
        [from, to, before, DISPLAY_TIME_ZONE]).then((r) => r.rows),
      ratingApi<RatingRow>(`/ratings?${qs}`, warnings),
      ratingApi<RateAdminRow>(`/rate-table-audit?${qs}`, warnings),
    ]);
  }

  const events = merge(desktopRows.map(fromDesktop), adminRows.map(fromRateAdmin), ratingRows.map(fromRating));
  const oldest = desktopRows.at(-1);
  return {
    events, labels: await entityLabels(events), warnings: [...new Set(warnings)], scope,
    capped: !submissionId && desktopRows.length >= LIMIT,
    oldestDesktopAt: oldest ? new Date(oldest.occurred_at).toISOString() : null,
  };
}

/** Human labels (SUB-0001, Q-2026-0001 v3, GL-26-00001, insured name) for the entities in view. */
async function entityLabels(events: TimelineEvent[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(events.filter((e) => e.entityType === type).map((e) => e.entityId))];
  const [subs, insureds, quotes, policies, book] = await Promise.all([
    customerDb.query<{ id: string; label: string }>("SELECT id::text, reference AS label FROM submissions WHERE id::text = ANY($1)", [ids("submission")]),
    customerDb.query<{ id: string; label: string }>("SELECT id::text, name AS label FROM insureds WHERE id::text = ANY($1)", [ids("insured")]),
    policyDb.query<{ id: string; label: string }>("SELECT id::text, quote_number || ' v' || version AS label FROM quotes WHERE id::text = ANY($1)", [ids("quote")]),
    policyDb.query<{ id: string; label: string }>("SELECT id::text, policy_number AS label FROM policies WHERE id::text = ANY($1)", [ids("policy")]),
    policyDb.query<{ id: string; label: string }>("SELECT id::text, policy_number AS label FROM book_policies WHERE id::text = ANY($1)", [ids("book_policy")]),
  ]);
  const labels = new Map<string, string>();
  for (const [type, rows] of [["submission", subs], ["insured", insureds], ["quote", quotes], ["policy", policies], ["book_policy", book]] as const) {
    for (const r of rows.rows) labels.set(`${type}:${r.id}`, r.label);
  }
  return labels;
}
