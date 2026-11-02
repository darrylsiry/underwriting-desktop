import { auditByCorrelation } from "./audit";
import { journalEntry, ledgerDocument, type LedgerDocument } from "./gl-export-json";
import { ACCOUNTS, GL_TIME_ZONE, PRESET_LABEL, TRANSACTION_LABEL, periodLabel, type ExportFormat, type TransactionType } from "./gl-journal";
import { ledgerFileQuery, type LedgerQuery } from "./gl-query";
import {
  byPeriod, exportLedger, getJournal, groupJournals, ledgerTotals, listBatches, listPeriods, listPostings, renderLedger,
  type LedgerFile, type LedgerFilter, type Totals,
} from "./ledger";

// The sub-ledger as integration documents: what the REST API returns and what the MCP tools hand
// an agent, built the same way so both show the same numbers as the Accounting page.

export const GL_API_VERSION = "1.0.0";

export type GlContext = { actor: string; origin: string };

export const ledgerFilter = (q: LedgerQuery): LedgerFilter => ({ from: q.from, to: q.to, type: q.type, batch: q.batch });

const num = (v: number | string | null) => (v === null ? null : Math.round(Number(v) * 100) / 100);

const totalsDoc = (t: Totals, lines: number) => ({
  journals: t.journals, lines, debit: num(t.debit), credit: num(t.credit),
  written_premium: num(t.premium), policy_fees: num(t.fee), surplus_lines_tax: num(t.tax), premiums_receivable: num(t.receivable),
  by_type: Object.fromEntries(Object.entries(t.byType).map(([k, n]) => [k, { label: TRANSACTION_LABEL[k as TransactionType], journals: n }])),
});

const filterDoc = (q: LedgerQuery) => ({
  period: q.period, period_label: PRESET_LABEL[q.period], posting_date_from: q.from, posting_date_to: q.to,
  transaction_type: q.type || null, export_batch: q.batch || null,
});

/** The filtered journals with their lines, as the JSON export shows them but with nothing stamped. */
export async function postingsDocument(q: LedgerQuery, ctx: GlContext): Promise<LedgerDocument> {
  const rows = await listPostings(ledgerFilter(q));
  return ledgerDocument(groupJournals(rows), ledgerTotals(rows), {
    batch: null, generatedAt: new Date(), generatedBy: ctx.actor, origin: ctx.origin, timeZone: GL_TIME_ZONE,
    from: q.from, to: q.to, transactionType: q.type || null, period: q.period, batchFilter: q.batch || null,
  });
}

/** The same lines as a CSV, Excel or JSON file, without stamping a batch. */
export async function postingsFile(q: LedgerQuery, ctx: GlContext): Promise<LedgerFile> {
  const rows = await listPostings(ledgerFilter(q));
  return renderLedger(rows, ledgerFilter(q), q.format, { batch: null, actor: ctx.actor, origin: ctx.origin, period: q.period });
}

/** Totals for the filter, overall and per accounting month. Lighter than the journals when only the numbers matter. */
export async function summaryDocument(q: LedgerQuery, ctx: GlContext) {
  const rows = await listPostings(ledgerFilter(q));
  return {
    generated_at: new Date().toISOString(), generated_by: ctx.actor, time_zone: GL_TIME_ZONE, currency: "USD",
    filter: filterDoc(q),
    totals: totalsDoc(ledgerTotals(rows), rows.length),
    periods: byPeriod(rows).map((g) => ({
      period: g.period, label: periodLabel(g.period), ...totalsDoc(g.totals, g.journals.reduce((n, j) => n + j.lines.length, 0)),
      url: `${ctx.origin}/accounting?from=${g.period}-01&to=${monthEnd(g.period)}`,
    })),
  };
}

/** One journal with its policy details, lines and the audit events of the underwriting action that booked it. */
export async function journalDocument(journalNo: string, ctx: GlContext) {
  const j = await getJournal(journalNo);
  if (!j) return null;
  const events = await auditByCorrelation(j.correlation_id);
  return {
    generated_at: new Date().toISOString(), generated_by: ctx.actor, time_zone: GL_TIME_ZONE, currency: "USD",
    journal: { ...journalEntry(j, ctx.origin, null), balanced: Math.round(j.debit * 100) === Math.round(j.credit * 100), debit: num(j.debit), credit: num(j.credit), exported_at: j.exported_at?.toISOString() ?? null, exported_by: j.exported_by },
    underwriting_action: {
      correlation_id: j.correlation_id, audit_url: `${ctx.origin}/audit?submission=${j.submission_id}&correlation=${j.correlation_id}`,
      events: events.map((e) => ({ occurred_at: e.occurred_at.toISOString(), actor: e.actor, action: e.action, entity_type: e.entity_type, entity_id: e.entity_id, summary: e.summary })),
    },
  };
}

const monthEnd = (period: string) => { const [y, m] = period.split("-").map(Number); return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };

/** Every accounting month with bookings and its totals. */
export async function periodsDocument(ctx: GlContext) {
  const rows = await listPeriods();
  return {
    generated_at: new Date().toISOString(), time_zone: GL_TIME_ZONE, currency: "USD",
    periods: rows.map((r) => ({
      period: r.period, label: periodLabel(r.period), journals: r.journals, lines: r.lines, debit: num(r.debit), credit: num(r.credit),
      written_premium: num(r.premium), policy_fees: num(r.fee), surplus_lines_tax: num(r.tax), premiums_receivable: num(r.receivable),
      pushed_lines: r.pushed_lines, unpushed_lines: r.lines - r.pushed_lines,
      first_posted_at: r.first_posted_at.toISOString(), last_posted_at: r.last_posted_at.toISOString(),
      url: `${ctx.origin}/api/gl/postings?from=${r.period}-01&to=${monthEnd(r.period)}`,
    })),
  };
}

/** Every push to the GL: when, by whom, in which format, what the file held and which lines it stamped. */
export async function batchesDocument(ctx: GlContext) {
  const rows = await listBatches();
  return {
    generated_at: new Date().toISOString(), time_zone: GL_TIME_ZONE, currency: "USD",
    batches: rows.map((b) => ({
      batch: b.batch, exported_at: b.exported_at.toISOString(), exported_by: b.exported_by, format: b.format,
      filter: { posting_date_from: b.from, posting_date_to: b.to, transaction_type: b.type },
      lines_in_file: b.lines_in_file, journals_in_file: b.journals_in_file,
      lines_stamped: b.lines_stamped, journals_stamped: b.journals_stamped, debit_stamped: num(b.debit), credit_stamped: num(b.credit),
      url: `${ctx.origin}/api/gl/postings?batch=${b.batch}`, accounting_url: `${ctx.origin}/accounting?batch=${b.batch}`,
    })),
  };
}

/** The chart of accounts the sub-ledger posts to, and the rule it posts by. */
export function accountsDocument() {
  return {
    currency: "USD", time_zone: GL_TIME_ZONE,
    accounts: Object.values(ACCOUNTS).map((a) => ({ code: a.code, name: a.name, kind: a.kind, normal_balance: a.kind === "asset" ? "debit" : "credit" })),
    posting_rule: {
      event: "policy.bound",
      basis: "Written premium is booked in full on the day the policy is bound (cash collection and earning are not reflected)",
      lines: [
        { account_code: ACCOUNTS.receivable.code, side: "debit", amount: "total due (premium + policy fee + surplus lines tax)" },
        { account_code: ACCOUNTS.premium.code, side: "credit", amount: "premium" },
        { account_code: ACCOUNTS.fee.code, side: "credit", amount: "policy fee" },
        { account_code: ACCOUNTS.tax.code, side: "credit", amount: "surplus lines tax" },
      ],
      notes: "Lines for zero amounts are omitted. Endorsements and cancellations will post the same accounts with negative or reversed amounts.",
    },
    transaction_types: Object.entries(TRANSACTION_LABEL).map(([code, label]) => ({ code, label, in_use: code === "new_business" || code === "renewal" })),
  };
}

/** Push the filter's lines to the GL (stamps a batch, audited) and say what happened. */
export async function pushDocument(q: LedgerQuery, format: ExportFormat, ctx: GlContext) {
  const r = await exportLedger(ledgerFilter(q), format, ctx.actor, ctx.origin, q.period);
  return {
    file: r, document: {
      batch: r.batch, format, filename: r.filename, pushed_at: new Date().toISOString(), pushed_by: ctx.actor,
      filter: filterDoc(q), lines: r.lines, journals: r.journals, newly_stamped_lines: r.fresh,
      note: r.fresh === r.lines ? "Every line in the file was pushed for the first time in this batch."
        : r.fresh === 0 ? "Every line in the file had been pushed in an earlier batch; the file shows which." : `${r.fresh} of ${r.lines} lines were pushed for the first time in this batch; the rest show their earlier batch.`,
      file_url: `${ctx.origin}/api/gl/postings?${ledgerFileQuery(q, format)}`,
      batch_url: r.fresh ? `${ctx.origin}/api/gl/postings?batch=${r.batch}&format=${format}` : null,
      accounting_url: `${ctx.origin}/accounting?batch=${r.batch}`,
      audit_url: `${ctx.origin}/audit?entityType=ledger&q=${r.batch}`,
    },
  };
}

/** The API's front door: where everything is and who is calling. */
export function indexDocument(ctx: GlContext) {
  const o = ctx.origin;
  return {
    name: "Underwriting Desktop GL API", version: GL_API_VERSION, authenticated_as: ctx.actor,
    authentication: "HTTP Basic with an Underwriting Desktop login (the same user id and password as the web app); no credentials are needed on an instance that runs without the password gate.",
    documentation: `${o}/accounting/api`, openapi: `${o}/api/gl/openapi.json`,
    mcp: { endpoint: `${o}/api/mcp`, transport: "streamable-http", documentation: `${o}/accounting/mcp` },
    endpoints: {
      postings: `${o}/api/gl/postings?period=this_month`, summary: `${o}/api/gl/summary?period=ytd`, journal: `${o}/api/gl/journals/{journal_no}`,
      periods: `${o}/api/gl/periods`, batches: `${o}/api/gl/batches`, accounts: `${o}/api/gl/accounts`, exports: `POST ${o}/api/gl/exports`,
    },
    time_zone: GL_TIME_ZONE, currency: "USD",
  };
}
