import { money } from "./format.ts";
import { plural } from "./text.ts";
export { plural };
import { RENEWAL_WINDOW_DAYS, daysUntil, lossTotals, summarizeBook } from "./book-metrics.ts";
export { RENEWAL_WINDOW_DAYS, daysUntil };
import { customerDb, policyDb } from "./db";
import { listInbox } from "./inbox";
import { producerOf, type ProducerFields } from "./quote-terms";
import { missingForRating, type SubmissionRow } from "./submissions";
import { stageOf, type Stage } from "./stage";
import { todayIso, whenDate } from "./time";
import { readiness, recentRateVersion, type WorksheetRow } from "./worksheets";

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
  is_renewal?: boolean;   // bound in the UW Desktop as the renewal of an expiring policy
};

export type Task = {
  kind: "review" | "rate" | "referral" | "quote" | "bind" | "subjectivity" | "renewal" | "inbox";
  title: string; detail: string; href: string;
  due: string | null;      // YYYY-MM-DD the task is due, if it has a date
  expiringPremium?: number; // a renewal's expiring premium, shown beside its days chip
  urgency: number;         // lower is more urgent; sorts the list
  pinned?: boolean;        // always shown first, ahead of the urgency order (the inbox)
};

export type Dashboard = {
  user: string;
  today: string;
  book: BookPolicy[];                 // in force today: effective and unexpired (CR-102)
  boundNotEffective: BookPolicy[];    // bound ahead of its effective date, such as a renewal waiting for its start
  unexpired: BookPolicy[];            // both of the above: the wider list renewal work runs on
  renewals: BookPolicy[];
  tasks: Task[];
  premiumByClass: { code: string; description: string; premium: number; policies: number }[];
  kpis: {
    inForcePremium: number; policies: number; boundNotEffectivePremium: number; boundNotEffectivePolicies: number;
    renewalsDue90: number; renewalPremium90: number;
    lossRatio: number | null; openClaims: number; newBusinessPremium: number; newBusinessPolicies: number;
    quotesOut: number; hitRatio: number | null;
  };
  activity: { occurred_at: Date; action: string; summary: string }[];
};

export async function loadDashboard(user: string): Promise<Dashboard> {
  const today = todayIso();
  const { rows: subs } = await customerDb.query<SubmissionRow & { ws: WorksheetRow | null }>(
    `SELECT s.*, to_jsonb(w) AS ws FROM submissions s LEFT JOIN worksheets w ON w.submission_id = s.id
     WHERE s.received_by = $1 ORDER BY s.received_at`, [user]);
  const mine = subs.map((s) => s.id);
  const [legacy, policies, quotes, activity, inbox, activeVersion] = await Promise.all([
    policyDb.query<BookPolicy>(
      `SELECT id, policy_number, insured_name, class_code, class_description, states, producer,
              effective_date::text, expiration_date::text, premium::float8 AS premium, claims,
              incurred::float8 AS incurred, open_claims, renewal_status, renewal_submission_id
       FROM book_policies WHERE underwriter = $1 AND expiration_date >= $2::date`, [user, today]),
    policyDb.query<{ id: string; policy_number: string; insured_name: string; submission_id: string; effective_date: string;
      expiration_date: string; premium: number; terms: { class_code?: string; class_description?: string; producer?: string[]; producer_fields?: ProducerFields };
      states: string[] | null; subjectivities: { text: string; status: string; due_date: string }[];
      renewal_status: BookPolicy["renewal_status"]; renewal_submission_id: string | null; is_renewal: boolean }>(
      `SELECT p.id, p.policy_number, p.insured_name, p.submission_id, p.effective_date::text, p.expiration_date::text,
              p.premium::float8 AS premium, q.terms, q.rating_inputs->'states' AS states, p.subjectivities,
              p.renewal_status, p.renewal_submission_id, (p.renewed_from IS NOT NULL) AS is_renewal
       FROM policies p JOIN quotes q ON q.id = p.quote_id WHERE p.submission_id = ANY($1)`, [mine]),
    policyDb.query<{ id: string; quote_number: string; version: number; status: string; submission_id: string;
      insured_name: string; valid_until: string; total: number }>(
      `SELECT id, quote_number, version, status, submission_id, insured_name, valid_until::text, total::float8 AS total
       FROM quotes WHERE submission_id = ANY($1)`, [mine]),
    policyDb.query<{ occurred_at: Date; action: string; summary: string }>(
      "SELECT occurred_at, action, summary FROM audit_events WHERE actor = $1 ORDER BY occurred_at DESC, id DESC LIMIT 8", [user]),
    listInbox(),
    recentRateVersion(),
  ]);

  // Every unexpired policy: prior-system ones plus those written here, in force or still to start.
  const subById = new Map(subs.map((s) => [s.id, s]));
  const written: BookPolicy[] = policies.rows.filter((p) => p.expiration_date >= today).map((p) => ({
    id: p.id, policy_number: p.policy_number, insured_name: p.insured_name,
    class_code: p.terms?.class_code ?? "", class_description: p.terms?.class_description ?? "",
    states: p.states ?? [], producer: producerOf(p.terms ?? {}).agency,
    effective_date: p.effective_date, expiration_date: p.expiration_date, premium: p.premium,
    ...lossTotals(subById.get(p.submission_id)?.data.loss_history), renewal_status: p.renewal_status, renewal_submission_id: p.renewal_submission_id,
    source: "uw desktop", href: `/policies/${p.id}`, is_renewal: p.is_renewal,
  }));
  const unexpired = [...legacy.rows.map((p) => ({ ...p, source: "prior system" as const, href: `/policies/book/${p.id}` })), ...written]
    .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));
  const { book, boundNotEffective, renewals, premiumByClass, kpis } = summarizeBook(unexpired, today);

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
        detail: `${s.reference} · received ${whenDate(s.received_at)}${missing ? ` · ${plural(missing, "rating field")} missing` : ""}` });   // UX-025
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
      tasks.push({ kind: "referral", title: `Clear ${plural(r.openReferrals.length, "referral")}: ${name}`,
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
      detail: `${q.quote_number} v${q.version} · ${money(q.total)} · ${left < 0 ? `expired ${plural(-left, "day")} ago` : `valid for ${left} more day${left === 1 ? "" : "s"}`}`,
      href: `/quotes/${q.id}`, due: q.valid_until, urgency: left });
  }
  for (const p of policies.rows) {
    const open = (p.subjectivities ?? []).filter((x) => x.status === "open");
    if (!open.length) continue;
    const next = open.map((x) => x.due_date).sort()[0];
    const left = daysUntil(next, today);
    tasks.push({ kind: "subjectivity", title: `Chase ${open.length} open subjectivit${open.length === 1 ? "y" : "ies"}: ${p.insured_name}`,
      detail: `${p.policy_number} · ${left < 0 ? `overdue by ${plural(-left, "day")}` : `next due in ${plural(left, "day")}`}`,
      href: `/policies/${p.id}`, due: next, urgency: left });
  }
  for (const p of renewals) {
    const left = daysUntil(p.expiration_date, today);
    if (p.renewal_status === "in_progress" && left <= 30) {
      tasks.push({ kind: "renewal", title: `Finish renewal: ${p.insured_name}`,
        detail: `${p.policy_number} · in progress · expires in ${plural(left, "day")}`,
        href: p.renewal_submission_id ? `/submissions/${p.renewal_submission_id}/renewal` : p.href ?? "#renewals",
        due: p.expiration_date, expiringPremium: p.premium, urgency: left - 30 });
      continue;
    }
    if (left > 60 || p.renewal_status !== "not_started") continue;
    tasks.push({ kind: "renewal", title: `Start renewal: ${p.insured_name}`,
      detail: `${p.policy_number} · expires in ${plural(left, "day")}`,
      href: p.href ?? "#renewals", due: p.expiration_date, expiringPremium: p.premium, urgency: left - 30 });
  }
  if (inbox.length) {
    tasks.push({ kind: "inbox", title: `${inbox.length} new submission${inbox.length === 1 ? "" : "s"} in the inbox`,
      detail: "Not yet picked up by anyone · extract one to start its intake", href: "/submissions", due: null, urgency: 40, pinned: true });
  }
  // The inbox stays on top so new work is never buried; everything else by urgency.
  tasks.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.urgency - b.urgency);

  const quoteNumbers = [...latestQuote.values()];
  const decided = quoteNumbers.filter((q) => q.status === "bound" || (q.status === "issued" && q.valid_until < today));

  return {
    user, today, book, boundNotEffective, unexpired, renewals, tasks, premiumByClass,
    kpis: {
      ...kpis,
      quotesOut: quoteNumbers.filter((q) => q.status === "issued" && q.valid_until >= today).length,   // an expired one is lost, below (CR-137)
      // Only decided quotes count: bound (won) or past their valid-until date unbound (lost).
      hitRatio: decided.length ? decided.filter((q) => q.status === "bound").length / decided.length : null,
    },
    activity: activity.rows,
  };
}

/**
 * Where each submission stands (UX-005), for the Received table: intake review, worksheet and
 * referrals, the latest quote, or the bound policy. One query per table, not per row.
 */
export async function submissionStages(subs: SubmissionRow[]): Promise<Map<string, Stage>> {
  const ids = subs.map((s) => s.id);
  const [worksheets, quotes, policies, activeVersion] = await Promise.all([
    customerDb.query<WorksheetRow>("SELECT * FROM worksheets WHERE submission_id = ANY($1)", [ids]),
    policyDb.query<{ submission_id: string; version: number; total: string; status: string }>(
      "SELECT DISTINCT ON (submission_id) submission_id, version, total, status FROM quotes WHERE submission_id = ANY($1) ORDER BY submission_id, version DESC", [ids]),
    policyDb.query<{ id: string; submission_id: string; policy_number: string }>("SELECT id, submission_id, policy_number FROM policies WHERE submission_id = ANY($1)", [ids]),
    recentRateVersion(),
  ]);
  const ws = new Map(worksheets.rows.map((w) => [w.submission_id, w]));
  const quote = new Map(quotes.rows.map((q) => [q.submission_id, q]));
  const policy = new Map(policies.rows.map((p) => [p.submission_id, p]));
  return new Map(subs.map((s) => {
    const w = ws.get(s.id);
    const r = w ? readiness(s, w, activeVersion) : null;
    return [s.id, stageOf({
      status: s.status, missing: missingForRating(s.data).length,
      worksheet: r ? { rated: r.rated, openReferrals: r.openReferrals.length } : null,
      quote: quote.get(s.id) ?? null, policy: policy.get(s.id) ?? null,
    })];
  }));
}


/** UX-034: stages for rows that are not full SubmissionRows (search hits, a customer's files). */
export async function submissionStagesById(ids: string[]): Promise<Map<string, Stage>> {
  if (!ids.length) return new Map();
  const { rows } = await customerDb.query<SubmissionRow>("SELECT * FROM submissions WHERE id = ANY($1)", [ids]);
  return submissionStages(rows);
}
