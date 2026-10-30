import { customerDb, policyDb } from "./db";
import { listInbox } from "./inbox";
import { missingForRating, type SubmissionRow } from "./submissions";
import { activeRateVersion, readiness, type WorksheetRow } from "./worksheets";

// Everything the home page shows for one underwriter. An underwriter owns the submissions they
// picked up (received_by), and through them the quotes and policies written in the UW Desktop;
// book_policies holds what they already wrote in the prior policy system.

export type BookPolicy = {
  id: string; policy_number: string; insured_name: string; class_code: string; class_description: string;
  states: string[]; producer: string; effective_date: string; expiration_date: string;
  premium: number; claims: number; incurred: number; open_claims: number;
  renewal_status: "not_started" | "in_progress" | "renewed" | "non_renewed"; source: "prior system" | "uw desktop";
  renewal_submission_id: string | null;
  href: string | null;
};

export type Task = {
  kind: "review" | "rate" | "referral" | "quote" | "bind" | "subjectivity" | "renewal" | "inbox";
  title: string; detail: string; href: string;
  due: string | null;      // YYYY-MM-DD the task is due, if it has a date
  urgency: number;         // lower is more urgent; sorts the list
  pinned?: boolean;        // always shown first, ahead of the urgency order (the inbox)
};

export type Dashboard = {
  user: string;
  today: string;
  book: BookPolicy[];
  renewals: BookPolicy[];
  tasks: Task[];
  premiumByClass: { code: string; description: string; premium: number; policies: number }[];
  kpis: {
    inForcePremium: number; policies: number; renewalsDue90: number; renewalPremium90: number;
    lossRatio: number | null; openClaims: number; newBusinessPremium: number; newBusinessPolicies: number;
    quotesOut: number; hitRatio: number | null;
  };
  activity: { occurred_at: Date; action: string; summary: string }[];
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => iso(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000));
export const daysUntil = (date: string, today: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

export const RENEWAL_WINDOW_DAYS = 120;

export async function loadDashboard(user: string): Promise<Dashboard> {
  const today = iso(new Date());
  const { rows: subs } = await customerDb.query<SubmissionRow & { ws: WorksheetRow | null }>(
    `SELECT s.*, to_jsonb(w) AS ws FROM submissions s LEFT JOIN worksheets w ON w.submission_id = s.id
     WHERE s.received_by = $1 ORDER BY s.received_at`, [user]);
  const mine = subs.map((s) => s.id);
  const [legacy, policies, quotes, activity, inbox, activeVersion] = await Promise.all([
    policyDb.query<BookPolicy>(
      `SELECT id, policy_number, insured_name, class_code, class_description, states, producer,
              effective_date::text, expiration_date::text, premium::float8 AS premium, claims,
              incurred::float8 AS incurred, open_claims, renewal_status, renewal_submission_id
       FROM book_policies WHERE underwriter = $1 AND expiration_date >= CURRENT_DATE`, [user]),
    policyDb.query<{ id: string; policy_number: string; insured_name: string; submission_id: string; effective_date: string;
      expiration_date: string; premium: number; terms: { class_code?: string; class_description?: string; producer?: string[] };
      states: string[] | null; subjectivities: { text: string; status: string; due_date: string }[];
      renewal_status: BookPolicy["renewal_status"]; renewal_submission_id: string | null }>(
      `SELECT p.id, p.policy_number, p.insured_name, p.submission_id, p.effective_date::text, p.expiration_date::text,
              p.premium::float8 AS premium, q.terms, q.rating_inputs->'states' AS states, p.subjectivities,
              p.renewal_status, p.renewal_submission_id
       FROM policies p JOIN quotes q ON q.id = p.quote_id WHERE p.submission_id = ANY($1)`, [mine]),
    policyDb.query<{ id: string; quote_number: string; version: number; status: string; submission_id: string;
      insured_name: string; valid_until: string; total: number }>(
      `SELECT id, quote_number, version, status, submission_id, insured_name, valid_until::text, total::float8 AS total
       FROM quotes WHERE submission_id = ANY($1)`, [mine]),
    policyDb.query<{ occurred_at: Date; action: string; summary: string }>(
      "SELECT occurred_at, action, summary FROM audit_events WHERE actor = $1 ORDER BY id DESC LIMIT 8", [user]),
    listInbox(),
    activeRateVersion(),
  ]);

  // The book: prior-system policies plus in-force policies written here.
  const written: BookPolicy[] = policies.rows.filter((p) => p.expiration_date >= today).map((p) => ({
    id: p.id, policy_number: p.policy_number, insured_name: p.insured_name,
    class_code: p.terms?.class_code ?? "", class_description: p.terms?.class_description ?? "",
    states: p.states ?? [], producer: p.terms?.producer?.[0] ?? "",
    effective_date: p.effective_date, expiration_date: p.expiration_date, premium: p.premium,
    claims: 0, incurred: 0, open_claims: 0, renewal_status: p.renewal_status, renewal_submission_id: p.renewal_submission_id,
    source: "uw desktop", href: `/policies/${p.id}`,
  }));
  const book = [...legacy.rows.map((p) => ({ ...p, source: "prior system" as const, href: `/policies/book/${p.id}` })), ...written]
    .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));
  const renewalCutoff = addDays(today, RENEWAL_WINDOW_DAYS);
  const renewals = book.filter((p) => p.expiration_date <= renewalCutoff && p.renewal_status !== "renewed");

  const tasks: Task[] = [];
  const latestQuote = new Map<string, (typeof quotes.rows)[number]>();
  for (const q of quotes.rows) {
    const cur = latestQuote.get(q.quote_number);
    if (!cur || q.version > cur.version) latestQuote.set(q.quote_number, q);
  }
  const quotedSubs = new Set(quotes.rows.map((q) => q.submission_id));

  for (const s of subs) {
    const name = s.applicant_name || s.reference;
    if (s.status === "needs_review") {
      const missing = missingForRating(s.data).length;
      tasks.push({ kind: "review", title: `Review intake: ${name}`, href: `/submissions/${s.id}`, due: null, urgency: 20,
        detail: `${s.reference} · received ${s.received_at.toISOString().slice(0, 10)}${missing ? ` · ${missing} rating field(s) missing` : ""}` });
      continue;
    }
    if (quotedSubs.has(s.id)) continue;
    if (!s.ws) {
      tasks.push({ kind: "rate", title: `Rate ${name}`, detail: `${s.reference} · intake accepted, no worksheet yet`,
        href: `/submissions/${s.id}/workbench`, due: null, urgency: 30 });
      continue;
    }
    const r = readiness(s, s.ws, activeVersion);
    if (r.openReferrals.length) {
      tasks.push({ kind: "referral", title: `Clear ${r.openReferrals.length} referral(s): ${name}`,
        detail: r.openReferrals.map((f) => f.title).join(" · "), href: `/submissions/${s.id}/workbench`, due: null, urgency: 25 });
    } else if (!r.rated) {
      const never = !s.ws.last_rating;
      tasks.push({ kind: "rate", title: `${never ? "Rate" : "Re-rate"} ${name}`,
        detail: never ? `${s.reference} · worksheet open, not rated yet`
          : r.staleRates ? `rates moved ${r.staleRates.from} → ${r.staleRates.to}` : "inputs changed since the last rating",
        href: `/submissions/${s.id}/workbench`, due: null, urgency: 30 });
    } else {
      tasks.push({ kind: "quote", title: `Issue quote: ${name}`, detail: `${s.reference} · rated and ready to quote`,
        href: `/submissions/${s.id}/workbench`, due: null, urgency: 28 });
    }
  }
  for (const q of latestQuote.values()) {
    if (q.status !== "issued") continue;
    const left = daysUntil(q.valid_until, today);
    tasks.push({ kind: "bind", title: `${left < 0 ? "Expired quote" : "Chase bind order"}: ${q.insured_name}`,
      detail: `${q.quote_number} v${q.version} · $${Math.round(q.total).toLocaleString("en-US")} · ${left < 0 ? `expired ${-left} day(s) ago` : `valid ${left} more day(s)`}`,
      href: `/quotes/${q.id}`, due: q.valid_until, urgency: left });
  }
  for (const p of policies.rows) {
    const open = (p.subjectivities ?? []).filter((x) => x.status === "open");
    if (!open.length) continue;
    const next = open.map((x) => x.due_date).sort()[0];
    const left = daysUntil(next, today);
    tasks.push({ kind: "subjectivity", title: `Chase ${open.length} open subjectivit${open.length === 1 ? "y" : "ies"}: ${p.insured_name}`,
      detail: `${p.policy_number} · ${left < 0 ? `overdue by ${-left} day(s)` : `next due in ${left} day(s)`}`,
      href: `/policies/${p.id}`, due: next, urgency: left });
  }
  for (const p of renewals) {
    const left = daysUntil(p.expiration_date, today);
    if (p.renewal_status === "in_progress" && left <= 30) {
      tasks.push({ kind: "renewal", title: `Finish renewal: ${p.insured_name}`,
        detail: `${p.policy_number} · in progress · expires in ${left} day(s) · $${Math.round(p.premium).toLocaleString("en-US")} expiring`,
        href: p.renewal_submission_id ? `/submissions/${p.renewal_submission_id}/renewal` : p.href ?? "#renewals",
        due: p.expiration_date, urgency: left - 30 });
      continue;
    }
    if (left > 60 || p.renewal_status !== "not_started") continue;
    tasks.push({ kind: "renewal", title: `Start renewal: ${p.insured_name}`,
      detail: `${p.policy_number} · expires in ${left} day(s) · $${Math.round(p.premium).toLocaleString("en-US")} expiring`,
      href: p.href ?? "#renewals", due: p.expiration_date, urgency: left - 30 });
  }
  if (inbox.length) {
    tasks.push({ kind: "inbox", title: `${inbox.length} new submission${inbox.length === 1 ? "" : "s"} in the inbox`,
      detail: "Not yet picked up by anyone · extract one to start its intake", href: "/submissions", due: null, urgency: 40, pinned: true });
  }
  // The inbox stays on top so new work is never buried; everything else by urgency.
  tasks.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.urgency - b.urgency);

  const byClass = new Map<string, { code: string; description: string; premium: number; policies: number }>();
  for (const p of book) {
    const c = byClass.get(p.class_code) ?? { code: p.class_code, description: p.class_description, premium: 0, policies: 0 };
    c.premium += p.premium;
    c.policies += 1;
    byClass.set(p.class_code, c);
  }
  const quoteNumbers = [...latestQuote.values()];
  const decided = quoteNumbers.filter((q) => q.status === "bound" || (q.status === "issued" && q.valid_until < today));
  const premium = book.reduce((n, p) => n + p.premium, 0);
  const priorPremium = legacy.rows.reduce((n, p) => n + p.premium, 0);

  return {
    user, today, book, renewals, tasks,
    premiumByClass: [...byClass.values()].sort((a, b) => b.premium - a.premium),
    kpis: {
      inForcePremium: premium,
      policies: book.length,
      renewalsDue90: book.filter((p) => daysUntil(p.expiration_date, today) <= 90).length,
      renewalPremium90: book.filter((p) => daysUntil(p.expiration_date, today) <= 90).reduce((n, p) => n + p.premium, 0),
      lossRatio: priorPremium ? legacy.rows.reduce((n, p) => n + p.incurred, 0) / priorPremium : null,
      openClaims: legacy.rows.reduce((n, p) => n + p.open_claims, 0),
      // Everything written in the UW Desktop is new business; the prior-system book is renewal business.
      newBusinessPremium: written.reduce((n, p) => n + p.premium, 0),
      newBusinessPolicies: written.length,
      quotesOut: quoteNumbers.filter((q) => q.status === "issued").length,
      // Only decided quotes count: bound (won) or past their valid-until date unbound (lost).
      hitRatio: decided.length ? decided.filter((q) => q.status === "bound").length / decided.length : null,
    },
    activity: activity.rows,
  };
}
