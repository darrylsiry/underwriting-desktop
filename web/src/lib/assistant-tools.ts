// What the AI assistant can look at: read-only tools over every part of the app (customers,
// submissions, worksheets, quotes, policies, the book, renewals, the GL sub-ledger, the audit
// trail, rate tables, the inbox), each answering with the URLs of the records it names so the
// assistant can link its answers. Everyone is treated as an admin: nothing is filtered by user.
import type Anthropic from "@anthropic-ai/sdk";
import { auditSearch } from "./assistant-audit.ts";
import { listMeta } from "./assistant-lists.ts";
import { LOSS_RATIO_BASIS, claimsOnFile, teamSummary } from "./book-metrics.ts";
import { daysUntil, loadDashboard } from "./dashboard";
import { customerDb, policyDb } from "./db";
import { GL_TOOLS } from "./gl-mcp";
import { journalDocument } from "./gl-service";
import { listInbox } from "./inbox";
import { getInsured, policiesForInsured, quotesForInsured, submissionsForInsured } from "./insureds";
import { getPolicy, listPolicies, policiesForSubmission, type PolicyRow } from "./policies";
import { getQuote, listQuotes, quoteVersions, quotesForSubmission, type QuoteRow } from "./quotes";
import { expiringOf, getBookPolicy } from "./renewals";
import { search } from "./search";
import { parseQuery } from "./search-terms";
import { listRateVersions } from "./rating-api";
import type { Loss } from "./submission";
import { getSubmission, submissionIdsReceivedBy } from "./submissions";
import { isUuid } from "./text.ts";
import { loadTimeline } from "./timeline";
import { clearanceStatus } from "./referrals.ts";
import { activeRateVersion, boundFlags, flagsFor, getWorksheet, readiness } from "./worksheets";

export type AssistantContext = { actor: string; origin: string; today: string };

export type AppTool = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
  run: (input: Record<string, unknown>, ctx: AssistantContext) => Promise<unknown>;
};

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const int = (v: unknown, d: number, max = 200) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : d; };
const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

const quoteSummary = (q: QuoteRow) => ({
  quote_number: q.quote_number, version: q.version, status: q.status, insured: q.insured_name, submission: q.submission_ref,
  effective_date: q.effective_date, expiration_date: q.expiration_date, valid_until: q.valid_until, premium: money(q.premium), total: money(q.total),
  rate_version: q.rate_version, issued_by: q.issued_by, issued_at: q.issued_at.toISOString(), has_renewal_memo: q.has_memo,
  url: `/quotes/${q.id}`, pdf_url: `/quotes/${q.id}/pdf`, memo_url: q.has_memo ? `/quotes/${q.id}/memo` : null, workbench_url: `/submissions/${q.submission_id}/workbench`,
});
const policySummary = (p: PolicyRow) => ({
  policy_number: p.policy_number, binder_number: p.binder_number, insured: p.insured_name, quote: `${p.quote_number} v${p.quote_version}`,
  effective_date: p.effective_date, expiration_date: p.expiration_date, premium: money(p.premium), total: money(p.total),
  open_subjectivities: p.subjectivities.filter((s) => s.status === "open").map((s) => ({ text: s.text, due: s.due_date })),
  bound_by: p.bound_by, bound_at: p.bound_at.toISOString(), renewal_status: p.renewal_status, renewed_from: p.renewed_from?.policy_number ?? null,
  url: `/policies/${p.id}`, binder_pdf_url: `/policies/${p.id}/binder`, policy_pdf_url: `/policies/${p.id}/policy`,
  workbench_url: `/submissions/${p.submission_id}/workbench`, audit_url: `/audit?submission=${p.submission_id}`,
});

async function submissionIdFor(ref: string): Promise<string | null> {
  if (isUuid(ref)) return ref;
  const { rows } = await customerDb.query<{ id: string }>("SELECT id FROM submissions WHERE upper(reference) = upper($1)", [ref]);
  return rows[0]?.id ?? null;
}

const UNDERWRITER = { type: "string", description: "An underwriter's login (underwriter1 … underwriter9). Leave out for everyone." };

/** Every login that has picked up a submission or owns prior-system policies: everyone with a desk. */
async function underwriterNames(today: string): Promise<string[]> {
  const [subs, book] = await Promise.all([
    customerDb.query<{ name: string }>("SELECT DISTINCT received_by AS name FROM submissions"),
    policyDb.query<{ name: string }>("SELECT DISTINCT underwriter AS name FROM book_policies WHERE expiration_date >= $1::date", [today]),
  ]);
  return [...new Set([...subs.rows, ...book.rows].map((r) => r.name))].sort();
}

/**
 * Who owns each submission. A policy written here belongs to the underwriter who picked its
 * submission up, as on the desk, whoever clicked Bind (CR-089). The two live in different databases.
 */
async function submissionOwners(ids: string[]): Promise<Map<string, { owner: string; claims: ReturnType<typeof claimsOnFile> }>> {
  if (!ids.length) return new Map();
  const { rows } = await customerDb.query<{ id: string; received_by: string; losses: Loss[] | null; carried: { claims: number; incurred: number; open_claims: number } | null }>(
    "SELECT id::text AS id, received_by, data->'loss_history' AS losses, renewal_of->'losses' AS carried FROM submissions WHERE id = ANY($1::uuid[])", [[...new Set(ids)]]);
  return new Map(rows.map((r) => [r.id, { owner: r.received_by, claims: claimsOnFile({ data: { loss_history: r.losses }, renewal_of: { losses: r.carried } }) }]));
}

export const APP_TOOLS: AppTool[] = [
  {
    name: "work_queue",
    description: "What to work on next: the open work across the whole pipeline, most urgent first. Broker submissions still in the inbox (unextracted and unassigned: whoever clicks Extract becomes their underwriter), submissions in intake review, accepted files not yet rated, open referrals, files ready to quote, quotes waiting for a bind order or about to expire, policies with open subjectivities, and renewals to start or finish. For one underwriter (their desk plus the shared inbox) or for everyone. Use this for any 'what should I work on / what's next / what's waiting / what's overdue' question.",
    input_schema: { type: "object", properties: { underwriter: UNDERWRITER } },
    run: async (a, ctx) => {
      const uw = str(a.underwriter) || null;
      const names = uw ? [uw] : await underwriterNames(ctx.today);
      const [desks, inbox] = await Promise.all([Promise.all(names.map(async (n) => ({ n, d: await loadDashboard(n) }))), listInbox()]);
      const tasks = desks.flatMap(({ n, d }) => d.tasks.filter((t) => t.kind !== "inbox").map((t) => {
        const days = t.due ? daysUntil(t.due, ctx.today) : null;
        return { underwriter: n, kind: t.kind, title: t.title, detail: t.detail, due: t.due, days_left: days, overdue: days !== null && days < 0, expiring_premium: t.expiringPremium === undefined ? undefined : money(t.expiringPremium), urgency: t.urgency, url: t.href };
      })).sort((x, y) => x.urgency - y.urgency);
      const oldestFirst = [...inbox].sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
      return {
        as_of: ctx.today, scope: uw ?? "everyone",
        inbox: {
          count: inbox.length,
          note: "Not yet extracted. These belong to nobody until someone clicks Extract on /submissions; extracting one is the first step of the workflow and makes it that underwriter's submission.",
          oldest_first: oldestFirst.slice(0, 25).map((f) => ({ title: f.title, documents: f.files.map((x) => x.name), received_at: f.receivedAt.toISOString(), url: "/submissions" })),
        },
        tasks: { count: tasks.length, overdue: tasks.filter((t) => t.overdue).length, items: tasks.slice(0, 60) },
        how_to_prioritise: "Overdue items first (negative days_left), then the smallest days_left, then the rest in urgency order. A file that is ready to quote comes before one that still needs rating. When an underwriter's own queue is empty, or nothing on it is urgent, the next step is to extract the oldest submission in the inbox.",
      };
    },
  },
  {
    name: "search_app",
    description: "Find anything by name or identifier: insureds (customers), submissions (SUB-0012), quotes (Q-2026-0004, optionally with a version like 'Q-2026-0004 v2'), policies (GL-26-00020), binders (BND-26-00020), producers, FEINs or class codes. Returns the matching records with their URLs. Start here whenever a question names a company or a number.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "A name, part of a name, or an identifier" } }, required: ["query"] },
    run: async ({ query }) => {
      const q = parseQuery(str(query));
      if (!q) return { error: "Give a name or an identifier to search for" };
      const r = await search(q);
      return {
        insureds: r.insureds.map((i) => ({ name: i.name, fein: i.fein, state: i.state, url: `/insureds/${i.id}` })),
        submissions: r.submissions.map((s) => ({ reference: s.reference, applicant: s.applicant_name, status: s.status, class_code: s.class_code, agency: s.agency, received_at: s.received_at.toISOString(), url: `/submissions/${s.id}`, workbench_url: `/submissions/${s.id}/workbench` })),
        quotes: r.quotes.map((x) => ({ quote: `${x.quote_number} v${x.version}`, status: x.status, insured: x.insured_name, submission: x.submission_ref, total: money(x.total), issued_at: x.issued_at.toISOString(), url: `/quotes/${x.id}` })),
        policies: r.policies.map((p) => ({ policy_number: p.policy_number, binder_number: p.binder_number, insured: p.insured_name, effective_date: p.effective_date, total: money(p.total), url: `/policies/${p.id}` })),
      };
    },
  },
  {
    name: "list_submissions",
    description: "Submissions (new business and renewals) newest first, with where each one stands: intake review, accepted, rated, quoted or bound. Filter by status, kind or underwriter.",
    input_schema: { type: "object", properties: {
      status: { type: "string", enum: ["needs_review", "accepted"], description: "needs_review = still in intake review; accepted = with underwriting" },
      kind: { type: "string", enum: ["new", "renewal"] }, underwriter: UNDERWRITER, limit: { type: "integer", description: "Default 50, max 200" } } },
    run: async (a) => {
      const { rows } = await customerDb.query<{ id: string; reference: string; applicant_name: string; status: string; kind: string; received_by: string; received_at: Date; class_code: string | null; state: string | null; gross_receipts: string | null; agency: string | null; rated_total: string | null; rate_version: string | null; total_matching: number }>(
        `SELECT count(*) OVER ()::int AS total_matching, s.id, s.reference, s.applicant_name, s.status, s.kind, s.received_by, s.received_at,
                s.data->'operations'->>'class_code' AS class_code, s.data->'applicant'->>'state' AS state, s.data->'operations'->>'gross_receipts' AS gross_receipts,
                s.data->'producer'->>'agency' AS agency, w.last_rating->>'total' AS rated_total, w.last_rating->>'rate_version' AS rate_version
         FROM submissions s LEFT JOIN worksheets w ON w.submission_id = s.id
         WHERE ($1::text IS NULL OR s.status = $1) AND ($2::text IS NULL OR s.kind = $2) AND ($3::text IS NULL OR s.received_by = $3)
         ORDER BY s.received_at DESC LIMIT $4`, [str(a.status) || null, str(a.kind) || null, str(a.underwriter) || null, int(a.limit, 50)]);
      const ids = rows.map((r) => r.id);
      const [quotes, policies] = await Promise.all([
        policyDb.query<{ submission_id: string; issued: number; bound: number }>("SELECT submission_id, count(*) FILTER (WHERE status = 'issued')::int AS issued, count(*) FILTER (WHERE status = 'bound')::int AS bound FROM quotes WHERE submission_id::text = ANY($1) GROUP BY 1", [ids]),
        policyDb.query<{ submission_id: string; policy_number: string; id: string }>("SELECT submission_id, policy_number, id FROM policies WHERE submission_id::text = ANY($1)", [ids]),
      ]);
      const q = new Map(quotes.rows.map((r) => [r.submission_id, r]));
      const p = new Map(policies.rows.map((r) => [r.submission_id, r]));
      return {
        ...listMeta(rows.length, rows[0]?.total_matching ?? 0, "submissions"),
        submissions: rows.map((s) => ({
          reference: s.reference, applicant: s.applicant_name, kind: s.kind, status: s.status,
          stage: p.has(s.id) ? `bound as ${p.get(s.id)!.policy_number}` : q.get(s.id)?.issued ? "quoted" : s.rated_total ? "rated" : s.status === "accepted" ? "accepted, not rated" : "intake review",
          class_code: s.class_code, state: s.state, gross_receipts: s.gross_receipts ? Number(s.gross_receipts) : null, agency: s.agency,
          rated_total: s.rated_total ? money(s.rated_total) : null, rate_version: s.rate_version, underwriter: s.received_by, received_at: s.received_at.toISOString(),
          url: `/submissions/${s.id}`, workbench_url: `/submissions/${s.id}/workbench`, policy_url: p.has(s.id) ? `/policies/${p.get(s.id)!.id}` : null,
        })),
      };
    },
  },
  {
    name: "get_submission",
    description: "Everything about one submission: the applicant, operations, coverage requested, producer, losses, intake warnings, the underwriting worksheet (rating inputs, schedule, last rating with its factor-by-factor worksheet, referrals open or cleared, ready to quote?), its quotes, its policy, and for a renewal the expiring policy. A referral marked raised_since_bind comes from a rule added after the file was bound and needs no action. Use to explain how a risk was rated or what is holding it up.",
    input_schema: { type: "object", properties: { reference_or_id: { type: "string", description: "SUB-0012 or the submission id" } }, required: ["reference_or_id"] },
    run: async (a, ctx) => {
      const id = await submissionIdFor(str(a.reference_or_id));
      const sub = id ? await getSubmission(id) : null;
      if (!sub) return { error: `No submission ${str(a.reference_or_id)}` };
      const [ws, active, quotes, policies] = await Promise.all([getWorksheet(sub.id), activeRateVersion(), quotesForSubmission(sub.id), policiesForSubmission(sub.id)]);
      const exp = expiringOf(sub);
      let worksheet: unknown = null;
      if (ws) {
        const st = readiness(sub, ws, active);
        // A bound file reads as the workbench shows it: the terms that were bound, not a worksheet edited since (CR-155).
        const boundQuote = policies[0] ? await getQuote(policies[0].quote_id) : null;
        const shownRating = boundQuote?.rating ?? ws.last_rating;
        worksheet = {
          rating_inputs: boundQuote?.rating_inputs ?? ws.rating_inputs, schedule: boundQuote?.schedule ?? ws.schedule,
          last_rating: shownRating ? { premium: money(shownRating.premium), policy_fee: money(shownRating.policy_fee), surplus_lines_tax: money(shownRating.surplus_lines_tax), total: money(shownRating.total), rate_version: shownRating.rate_version, minimum_premium_applied: shownRating.minimum_premium_applied, steps: shownRating.worksheet } : null,
          ...(boundQuote ? { bound: true } : { rating_is_current: st.rated, rates_changed_since: st.staleRates, ready_to_quote: st.ready }),
          active_rate_version: active,
          referrals: (boundQuote ? boundFlags(sub, ws, boundQuote) : flagsFor(sub, ws)).map((f) => ({ code: f.code, severity: f.severity, title: f.title, detail: f.detail, status: f.severity === "warn" ? "note" : clearanceStatus(f, ws.referral_clearances[f.code], !!boundQuote) === "cleared" ? "cleared" : boundQuote ? "raised_since_bind" : "open", clearance: ws.referral_clearances[f.code] ?? null })),
          bridge_rating_on_expiring_rates: ws.bridge_rating ? { premium: money(ws.bridge_rating.premium), total: money(ws.bridge_rating.total), rate_version: ws.bridge_rating.rate_version } : null,
          updated_by: ws.updated_by, updated_at: ws.updated_at.toISOString(),
        };
      }
      return {
        reference: sub.reference, status: sub.status, kind: sub.kind, applicant: sub.data.applicant, operations: sub.data.operations, coverage_requested: sub.data.policy,
        producer: sub.data.producer, prior_insurance: sub.data.prior, loss_history: sub.data.loss_history,
        intake: { warnings: sub.extraction.warnings, missing_for_rating: sub.extraction.missing_for_rating, corrected_fields: sub.corrected_fields, documents: sub.extraction.documents.map((d) => d.filename), reviewed_by: sub.reviewed_by },
        underwriter: sub.received_by, received_at: sub.received_at.toISOString(), insured_url: sub.insured_id ? `/insureds/${sub.insured_id}` : null,
        worksheet,
        renewal_of: exp ? { policy_number: exp.policy_number, expiring_premium: money(exp.premium), expiring_rate_version: exp.rate_version, effective_date: exp.effective_date, expiration_date: exp.expiration_date, url: exp.source === "book" ? `/policies/book/${exp.policy_id}` : `/policies/${exp.policy_id}` } : null,
        quotes: quotes.map(quoteSummary), policies: policies.map(policySummary),
        urls: { intake: `/submissions/${sub.id}`, workbench: `/submissions/${sub.id}/workbench`, renewal_comparison: exp ? `/submissions/${sub.id}/renewal` : null, case_history: `/audit?submission=${sub.id}` },
        as_of: ctx.today,
      };
    },
  },
  {
    name: "list_quotes",
    description: "Quote versions newest first. status=issued are not yet bound or superseded; add live=true for the quotes out, those still inside their valid-until date. Bound and superseded are history. `total` and `total_matching` cover every match even when the rows are cut by limit. Filter by the underwriter whose submissions they came from.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["issued", "superseded", "bound"] }, live: { type: "boolean", description: "Only quotes still inside their valid-until date" }, underwriter: UNDERWRITER, limit: { type: "integer", description: "Default 50, max 200" } } },
    run: async (a) => {
      const ids = str(a.underwriter) ? await submissionIdsReceivedBy(str(a.underwriter)) : null;
      const rows = await listQuotes({ status: (str(a.status) || null) as QuoteRow["status"] | null, live: a.live === true, submissionIds: ids });
      const shown = rows.slice(0, int(a.limit, 50));
      return { ...listMeta(shown.length, rows.length, "quote versions"), total: money(rows.reduce((n, q) => n + Number(q.total), 0)), quotes: shown.map(quoteSummary) };
    },
  },
  {
    name: "get_quote",
    description: "One quote in full: terms, limits, the rating worksheet step by step (why it is priced as it is), schedule credits and debits, subjectivities, status, who issued it and when, and for a renewal quote the premium change versus the expiring policy. Give a quote number (latest version) or 'Q-2026-0004 v1' for a specific version.",
    input_schema: { type: "object", properties: { quote: { type: "string", description: "Q-2026-0004, Q-2026-0004 v2, or the quote id" } }, required: ["quote"] },
    run: async (a) => {
      const ref = str(a.quote);
      let id: string | null = isUuid(ref) ? ref : null;
      if (!id) {
        const m = ref.toUpperCase().match(/^(Q-\d{4}-\d+)(?:\s*V(\d+))?$/);
        const versions = m ? await quoteVersions(m[1]) : [];
        id = (m?.[2] ? versions.find((v) => v.version === Number(m[2])) : versions[0])?.id ?? null;
      }
      const q = id ? await getQuote(id) : null;
      if (!q) return { error: `No quote ${ref}` };
      return {
        ...quoteSummary(q), policy_fee: money(q.policy_fee), surplus_lines_tax: money(q.surplus_lines_tax), subjectivities: q.subjectivities,
        terms: q.terms, rating_inputs: q.rating_inputs, schedule: q.schedule,
        rating: { rate_version: q.rating.rate_version, class: q.rating.class_description, minimum_premium_applied: q.rating.minimum_premium_applied, steps: q.rating.worksheet },
        renewal_summary: q.renewal_summary ? { premium_change: q.renewal_summary.bridge, changed_terms: q.renewal_summary.terms.filter((t) => t.changed), changed_factors: q.renewal_summary.factors.filter((f) => f.changed) } : null,
        intake_url: `/submissions/${q.submission_id}`, insured_url: q.insured_id ? `/insureds/${q.insured_id}` : null,
      };
    },
  },
  {
    name: "list_policies",
    description: "Policies bound in the UW Desktop, newest first, with premium, period, open subjectivities and renewal status. in_force=true keeps those in force today (effective and unexpired); underwriter keeps those from that underwriter's submissions. (Policies from the prior policy system are in renewals_due and book_summary.)",
    input_schema: { type: "object", properties: { in_force: { type: "boolean" }, underwriter: UNDERWRITER, limit: { type: "integer", description: "Default 50, max 200" } } },
    run: async (a) => {
      const ids = str(a.underwriter) ? await submissionIdsReceivedBy(str(a.underwriter)) : null;
      const rows = await listPolicies({ submissionIds: ids, inForce: a.in_force === true });
      const shown = rows.slice(0, int(a.limit, 50));
      return { ...listMeta(shown.length, rows.length, "policies"), premium: money(rows.reduce((n, p) => n + Number(p.premium), 0)), policies: shown.map(policySummary) };
    },
  },
  {
    name: "get_policy",
    description: "One policy in full, by policy or binder number: terms, subjectivities and whether they were received, who bound it and when, its renewal status, the quote it was bound from, and the general-ledger journal it booked (debits and credits, accounting period, whether it has been pushed to the GL). Also finds prior-system policies (GL-25-…).",
    input_schema: { type: "object", properties: { policy: { type: "string", description: "GL-26-00020, BND-26-00020, or the policy id" } }, required: ["policy"] },
    run: async (a, ctx) => {
      const ref = str(a.policy);
      let id: string | null = isUuid(ref) ? ref : null;
      if (!id) id = (await policyDb.query<{ id: string }>("SELECT id FROM policies WHERE upper(policy_number) = upper($1) OR upper(binder_number) = upper($1)", [ref])).rows[0]?.id ?? null;
      const p = id ? await getPolicy(id) : null;
      if (!p) {
        const bookId = isUuid(ref) ? ref : (await policyDb.query<{ id: string }>("SELECT id FROM book_policies WHERE upper(policy_number) = upper($1)", [ref])).rows[0]?.id;
        const b = bookId ? await getBookPolicy(bookId) : null;
        if (!b) return { error: `No policy ${ref}` };
        return { source: "prior policy system", ...b, premium: money(b.premium), url: `/policies/book/${b.id}`, note: "Written in the prior system: no quote, documents or GL journal here; it can be renewed in the UW Desktop." };
      }
      const [quote, journalNo] = await Promise.all([
        getQuote(p.quote_id),
        policyDb.query<{ journal_no: string }>("SELECT journal_no FROM gl_postings WHERE policy_id = $1 ORDER BY journal_no LIMIT 1", [p.id]).then((r) => r.rows[0]?.journal_no ?? null),
      ]);
      const journal = journalNo ? await journalDocument(journalNo, { actor: ctx.actor, origin: ctx.origin }) : null;
      return {
        source: "UW Desktop", ...policySummary(p), status: p.status, policy_fee: money(p.policy_fee), surplus_lines_tax: money(p.surplus_lines_tax),
        subjectivities: p.subjectivities, insured_url: p.insured_id ? `/insureds/${p.insured_id}` : null,
        terms: quote ? { ...quote.terms, rate_version: quote.rate_version, rating_inputs: quote.rating_inputs } : null, quote_url: `/quotes/${p.quote_id}`,
        gl_journal: journal ? { journal_no: journal.journal.journal_no, accounting_period: journal.journal.accounting_period, posted_at: journal.journal.posted_at, transaction_type: journal.journal.transaction_type, lines: journal.journal.lines, export_batch: journal.journal.export_batch, url: `/accounting?period=all` } : null,
      };
    },
  },
  {
    name: "book_summary",
    description: "The numbers on the desk: in-force premium and policy count (effective today and unexpired: prior-system book plus policies bound here), policies bound but not yet effective (reported separately, not in force), renewals still to do in 90 days (policies already renewed are left out), book loss ratio (five years of incurred over five years of current premium, prior-system book), new business bound in the UW Desktop (renewals are left out), quotes out. For one underwriter, exactly their desk; without one, the whole operation as the sum of the desks, with a per-underwriter breakdown.",
    input_schema: { type: "object", properties: { underwriter: UNDERWRITER } },
    run: async (a, ctx) => {
      const uw = str(a.underwriter);
      if (uw) {
        const d = await loadDashboard(uw);
        return { underwriter: uw, as_of: d.today, kpis: d.kpis, loss_ratio_basis: LOSS_RATIO_BASIS, premium_by_class: d.premiumByClass, next_up: d.tasks.slice(0, 10), renewals_in_window: d.renewals.slice(0, 25).map((p) => ({ policy_number: p.policy_number, insured: p.insured_name, expiration_date: p.expiration_date, premium: money(p.premium), renewal_status: p.renewal_status, url: p.href })),
          urls: { desk: "/", in_force_book: "/book", renewals_90_days: "/book?due=90", bound_not_effective: "/book#bound-not-effective", loss_ratio: "/book?view=losses", new_business: `/policies?underwriter=${encodeURIComponent(uw)}&new_business=1`, quotes_out: `/quotes?status=issued&live=1&underwriter=${encodeURIComponent(uw)}` } };
      }
      const names = await underwriterNames(ctx.today);
      const [desks, quotes] = await Promise.all([
        Promise.all(names.map(loadDashboard)),
        policyDb.query<{ n: number; total: number }>("SELECT count(*)::int AS n, coalesce(sum(total), 0)::float8 AS total FROM quotes WHERE status = 'issued' AND valid_until >= $1::date", [ctx.today]),
      ]);
      return {
        scope: "everyone", as_of: ctx.today, ...teamSummary(desks), quotes_out: quotes.rows[0].n, quotes_out_total: money(quotes.rows[0].total),
        urls: { in_force_book: "/book", bound_not_effective: "/book#bound-not-effective", renewals: "/book?due=90", losses: "/book?view=losses", policies: "/policies?in_force=1", quotes_out: "/quotes?status=issued&live=1" },
      };
    },
  },
  {
    name: "renewals_due",
    description: "Policies expiring within N days (default 90) that still need renewing, prior-system and UW Desktop, with premium, losses, renewal status (not started, in progress) and the link to start or continue the renewal. Policies already renewed are left out and counted in already_renewed, matching the list on /book?due=N. Optionally one underwriter.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "Window in days from today; default 90" }, underwriter: UNDERWRITER } },
    run: async (a, ctx) => {
      const days = int(a.days, 90, 400);
      const uw = str(a.underwriter) || null;
      const [book, desk] = await Promise.all([
        policyDb.query<{ id: string; policy_number: string; insured_name: string; underwriter: string; class_description: string; states: string[]; producer: string; effective_date: string; expiration_date: string; premium: number; claims: number; incurred: number; open_claims: number; renewal_status: string; renewal_submission_id: string | null }>(
          `SELECT id, policy_number, insured_name, underwriter, class_description, states, producer, effective_date::text, expiration_date::text, premium::float8 AS premium, claims, incurred::float8 AS incurred, open_claims, renewal_status, renewal_submission_id
           FROM book_policies WHERE expiration_date BETWEEN $3::date AND $3::date + $1::int AND ($2::text IS NULL OR underwriter = $2) ORDER BY expiration_date`, [days, uw, ctx.today]),
        policyDb.query<{ id: string; policy_number: string; insured_name: string; effective_date: string; expiration_date: string; premium: number; renewal_status: string; renewal_submission_id: string | null; submission_id: string }>(
          `SELECT id, policy_number, insured_name, effective_date::text, expiration_date::text, premium::float8 AS premium, renewal_status, renewal_submission_id, submission_id
           FROM policies WHERE expiration_date BETWEEN $2::date AND $2::date + $1::int ORDER BY expiration_date`, [days, ctx.today]),
      ]);
      const owners = await submissionOwners(desk.rows.map((p) => p.submission_id));
      const all = [
        ...book.rows.map((p) => ({ source: "prior system", policy_number: p.policy_number, insured: p.insured_name, underwriter: p.underwriter, class: p.class_description, states: p.states, producer: p.producer, effective_date: p.effective_date, expiration_date: p.expiration_date, days_left: daysUntil(p.expiration_date, ctx.today), premium: money(p.premium), claims: p.claims, incurred: money(p.incurred), open_claims: p.open_claims, renewal_status: p.renewal_status, renewal_url: p.renewal_submission_id ? `/submissions/${p.renewal_submission_id}/renewal` : null, url: `/policies/book/${p.id}` })),
        ...desk.rows.filter((p) => !uw || owners.get(p.submission_id)?.owner === uw).map((p) => ({ source: "UW Desktop", policy_number: p.policy_number, insured: p.insured_name, underwriter: owners.get(p.submission_id)?.owner ?? "", class: null, states: null, producer: null, effective_date: p.effective_date, expiration_date: p.expiration_date, days_left: daysUntil(p.expiration_date, ctx.today), premium: money(p.premium), ...(owners.get(p.submission_id)?.claims ?? claimsOnFile(null)), renewal_status: p.renewal_status, renewal_url: p.renewal_submission_id ? `/submissions/${p.renewal_submission_id}/renewal` : null, url: `/policies/${p.id}` })),
      ].sort((x, y) => x.expiration_date.localeCompare(y.expiration_date));
      const rows = all.filter((r) => r.renewal_status !== "renewed");
      return { window_days: days, as_of: ctx.today, count: rows.length, already_renewed: all.length - rows.length, expiring_premium: money(rows.reduce((s, r) => s + r.premium, 0)), policies: rows, list_url: `/book?due=${days}` };
    },
  },
  ...GL_TOOLS.filter((t) => t.annotations?.readOnlyHint).map<AppTool>((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    run: (input, ctx) => t.run(input, { actor: ctx.actor, origin: ctx.origin, today: ctx.today }),
  })),
  {
    name: "audit_search",
    description: "The audit trail across the UW Desktop, the rating engine and the rate tables: who did what and when. Filter by free text, actor, entity type (submission, quote, policy, insured, rate_version, rating, ledger), dates, or one submission's case history. Use for 'who changed', 'when was', 'what happened to' questions. Each source returns its newest 500 rows: when capped is true the history was cut at oldest_loaded_at, so say so rather than reporting that nothing happened, and narrow from/to to look further back.",
    input_schema: { type: "object", properties: {
      q: { type: "string", description: "Text to look for in summaries and references" }, actor: { type: "string" },
      entity_type: { type: "string", enum: ["submission", "quote", "policy", "insured", "rate_version", "rating", "ledger", "book_policy"] },
      submission_id: { type: "string", description: "Only this submission's case history (id or SUB- reference)" },
      from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "integer", description: "Default 50, max 200" } } },
    run: (a) => auditSearch(a, { submissionIdFor, loadTimeline }),
  },
  {
    name: "rate_versions",
    description: "The rate tables: every rate version (label, status active/draft/retired, when activated, notes) and which one new ratings use.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const versions = await listRateVersions();
      return { active: versions.find((v) => v.status === "active")?.label ?? null, versions: versions.map((v) => ({ ...v, url: `/admin/versions/${v.id}` })), rate_tables_url: "/admin" };
    },
  },
  {
    name: "inbox",
    description: "Broker submissions in the drop folder that nobody has picked up yet, with their documents.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const items = await listInbox();
      return { count: items.length, submissions: items.map((f) => ({ title: f.title, folder: f.folder, documents: f.files.map((x) => x.name), received_at: f.receivedAt.toISOString() })), url: "/submissions" };
    },
  },
  {
    name: "get_insured",
    description: "A customer (insured) with every submission, quote and policy on file. Give a name (or part of one) or the insured id.",
    input_schema: { type: "object", properties: { name_or_id: { type: "string" } }, required: ["name_or_id"] },
    run: async (a) => {
      const ref = str(a.name_or_id);
      let insured = isUuid(ref) ? await getInsured(ref) : null;
      if (!insured) {
        const { rows } = await customerDb.query<{ id: string; name: string; state: string }>("SELECT id, name, state FROM insureds WHERE name ILIKE $1 ORDER BY (lower(name) = lower($2)) DESC, name LIMIT 6", [`%${ref}%`, ref]);
        if (!rows.length) return { error: `No insured matching "${ref}"` };
        if (rows.length > 1 && rows[0].name.toLowerCase() !== ref.toLowerCase()) return { candidates: rows.map((r) => ({ name: r.name, state: r.state, url: `/insureds/${r.id}` })), note: "Several customers match; pick one by name or id" };
        insured = await getInsured(rows[0].id);
      }
      if (!insured) return { error: `No insured ${ref}` };
      const [subs, quotes, policies] = await Promise.all([submissionsForInsured(insured.id), quotesForInsured(insured.id), policiesForInsured(insured.id)]);
      const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
      return {
        name: insured.name, fein: insured.fein, state: insured.state, customer_since: insured.created_at.toISOString(), url: `/insureds/${insured.id}`,
        submissions: (subs as Record<string, unknown>[]).map((s) => ({ ...pick(s, ["reference", "status", "kind", "received_at", "received_by"]), url: `/submissions/${s.id}` })),
        quotes: (quotes as Record<string, unknown>[]).map((q) => ({ ...pick(q, ["quote_number", "version", "status", "total", "effective_date"]), url: `/quotes/${q.id}` })),
        policies: (policies as Record<string, unknown>[]).map((p) => ({ ...pick(p, ["policy_number", "status", "effective_date", "expiration_date", "total", "renewal_status"]), url: `/policies/${p.id}` })),
      };
    },
  },
  {
    name: "underwriters",
    description: "Who works here: every underwriter login with their submissions, prior-system book and UW Desktop policies.",
    input_schema: { type: "object", properties: {} },
    run: async (_a, ctx) => {
      const [subs, book, written] = await Promise.all([
        customerDb.query<{ name: string; n: number }>("SELECT received_by AS name, count(*)::int AS n FROM submissions GROUP BY 1"),
        policyDb.query<{ name: string; n: number; premium: number }>("SELECT underwriter AS name, count(*)::int AS n, sum(premium)::float8 AS premium FROM book_policies WHERE effective_date <= $1::date AND expiration_date > $1::date GROUP BY 1", [ctx.today]),
        policyDb.query<{ submission_id: string; premium: number }>("SELECT submission_id, premium::float8 AS premium FROM policies"),
      ]);
      const [names, owners] = await Promise.all([underwriterNames(ctx.today), submissionOwners(written.rows.map((p) => p.submission_id))]);
      const mine = (n: string) => written.rows.filter((p) => owners.get(p.submission_id)?.owner === n);
      return { underwriters: names.map((n) => ({ login: n, submissions: subs.rows.find((r) => r.name === n)?.n ?? 0, prior_system_policies_in_force: book.rows.find((r) => r.name === n)?.n ?? 0, prior_system_premium: money(book.rows.find((r) => r.name === n)?.premium ?? 0), uw_desktop_policies: mine(n).length, uw_desktop_premium: money(mine(n).reduce((s, p) => s + p.premium, 0)), desk_url: "/" })) };
    },
  },
];
