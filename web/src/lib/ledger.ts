import { plural } from "./text.ts";
import type { PoolClient } from "pg";
import { audit } from "./audit";
import { toCsv } from "./csv";
import { policyDb } from "./db";
import {
  GL_TIME_ZONE, TRANSACTION_LABEL, accountingPeriod, bindJournal, glDate, isBalanced,
  type ExportFormat, type JournalLine, type PolicyAmounts, type TransactionType,
} from "./gl-journal";
import { ledgerJson } from "./gl-export-json";
import { toXlsx } from "./xlsx";

// The premium sub-ledger (policy DB, table gl_postings): what each underwriting action booked to
// the general ledger, and the export that pushes it there.

export type Posting = {
  id: number; journal_no: string; line_no: number; posted_at: Date; accounting_period: string; transaction_type: TransactionType;
  account_code: string; account_name: string; debit: string; credit: string; description: string;
  policy_id: string; policy_number: string; insured_name: string; effective_date: string; expiration_date: string;
  quote_ref: string; submission_id: string; submission_ref: string; underwriter: string; producer: string;
  source_action: string; correlation_id: string; export_batch: string | null; exported_at: Date | null; exported_by: string | null;
};

export type LedgerFilter = { from: string | null; to: string | null; type: TransactionType | ""; batch: string };

const POSTING_COLUMNS = `id, journal_no, line_no, posted_at, accounting_period, transaction_type, account_code, account_name, debit, credit,
  description, policy_id, policy_number, insured_name, effective_date::text, expiration_date::text, quote_ref,
  submission_id, submission_ref, underwriter, producer, source_action, correlation_id, export_batch, exported_at, exported_by`;

export async function listPostings(f: LedgerFilter): Promise<Posting[]> {
  const { rows } = await policyDb.query<Posting>(
    `SELECT ${POSTING_COLUMNS} FROM gl_postings
     WHERE ($1::date IS NULL OR (posted_at AT TIME ZONE $5)::date >= $1)
       AND ($2::date IS NULL OR (posted_at AT TIME ZONE $5)::date <= $2)
       AND ($3::text = '' OR transaction_type = $3)
       AND ($4::text = '' OR export_batch = $4)
     ORDER BY posted_at, journal_no, line_no`,
    [f.from, f.to, f.type, f.batch, GL_TIME_ZONE]);
  return rows;
}

/** One journal with its lines, or null when no such journal number was booked. */
export async function getJournal(journalNo: string): Promise<Journal | null> {
  const { rows } = await policyDb.query<Posting>(`SELECT ${POSTING_COLUMNS} FROM gl_postings WHERE journal_no = $1 ORDER BY line_no`, [journalNo]);
  return groupJournals(rows)[0] ?? null;
}

/** One booked action: its policy details and its balanced lines. */
export type Journal = Omit<Posting, "id" | "line_no" | "account_code" | "account_name" | "debit" | "credit"> & {
  lines: Posting[]; debit: number; credit: number;
};

export function groupJournals(rows: Posting[]): Journal[] {
  const out = new Map<string, Journal>();
  for (const r of rows) {
    let j = out.get(r.journal_no);
    if (!j) {
      const { id: _id, line_no: _l, account_code: _a, account_name: _n, debit: _d, credit: _c, ...head } = r;  // eslint-disable-line @typescript-eslint/no-unused-vars
      j = { ...head, lines: [], debit: 0, credit: 0 };
      out.set(r.journal_no, j);
    }
    j.lines.push(r);
    j.debit += Number(r.debit);
    j.credit += Number(r.credit);
  }
  return [...out.values()];
}

export type Totals = { debit: number; credit: number; premium: number; fee: number; tax: number; receivable: number; journals: number; byType: Record<string, number> };

export function ledgerTotals(rows: Posting[]): Totals {
  const t: Totals = { debit: 0, credit: 0, premium: 0, fee: 0, tax: 0, receivable: 0, journals: new Set(rows.map((r) => r.journal_no)).size, byType: {} };
  for (const r of rows) {
    t.debit += Number(r.debit); t.credit += Number(r.credit);
    if (r.account_code === "4100") t.premium += Number(r.credit) - Number(r.debit);
    if (r.account_code === "4200") t.fee += Number(r.credit) - Number(r.debit);
    if (r.account_code === "2300") t.tax += Number(r.credit) - Number(r.debit);
    if (r.account_code === "1200") t.receivable += Number(r.debit) - Number(r.credit);
  }
  for (const j of groupJournals(rows)) t.byType[j.transaction_type] = (t.byType[j.transaction_type] ?? 0) + 1;
  return t;
}

export type PeriodGroup = { period: string; journals: Journal[]; totals: Totals };

export function byPeriod(rows: Posting[]): PeriodGroup[] {
  const periods = [...new Set(rows.map((r) => r.accounting_period))].sort().reverse();
  return periods.map((period) => {
    const inPeriod = rows.filter((r) => r.accounting_period === period);
    return { period, journals: groupJournals(inPeriod).reverse(), totals: ledgerTotals(inPeriod) };
  });
}

export type BindPosting = {
  policyId: string; policyNumber: string; insuredName: string; effectiveDate: string; expirationDate: string;
  quoteRef: string; submissionId: string; submissionRef: string; underwriter: string; producer: string;
  transactionType: TransactionType; amounts: PolicyAmounts; postedAt: Date; correlationId: string;
};

const usDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };

/** Book a bound policy's journal, inside the bind's own transaction (`client`). */
export async function postPolicyBound(client: PoolClient, p: BindPosting): Promise<{ journal_no: string; lines: JournalLine[] }> {
  const lines = bindJournal(p.amounts);
  if (!isBalanced(lines)) throw new Error("Journal is out of balance");
  const journal_no = (await client.query<{ n: string }>("SELECT 'JE-' || lpad(nextval('gl_journal_seq')::text, 6, '0') AS n")).rows[0].n;
  const description = `${TRANSACTION_LABEL[p.transactionType]} bound: ${p.policyNumber}, ${p.insuredName} (${usDate(p.effectiveDate)} to ${usDate(p.expirationDate)})`;
  for (const l of lines) {
    await client.query(
      `INSERT INTO gl_postings (journal_no, line_no, posted_at, accounting_period, transaction_type, account_code, account_name, debit, credit,
         description, policy_id, policy_number, insured_name, effective_date, expiration_date, quote_ref, submission_id, submission_ref,
         underwriter, producer, source_action, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'policy.bound', $21)`,
      [journal_no, l.line_no, p.postedAt, accountingPeriod(p.postedAt), p.transactionType, l.account_code, l.account_name, l.debit, l.credit,
       description, p.policyId, p.policyNumber, p.insuredName, p.effectiveDate, p.expirationDate, p.quoteRef, p.submissionId, p.submissionRef,
       p.underwriter, p.producer, p.correlationId]);
  }
  return { journal_no, lines };
}

export { EXPORT_FORMATS, type ExportFormat } from "./gl-journal";

export type PeriodRow = {
  period: string; journals: number; lines: number; debit: string; credit: string; premium: string; fee: string; tax: string; receivable: string;
  pushed_lines: number; first_posted_at: Date; last_posted_at: Date;
};

/** Every accounting month with bookings, newest first, with its totals. */
export async function listPeriods(): Promise<PeriodRow[]> {
  const { rows } = await policyDb.query<PeriodRow>(
    `SELECT accounting_period AS period, count(DISTINCT journal_no)::int AS journals, count(*)::int AS lines,
            sum(debit)::text AS debit, sum(credit)::text AS credit,
            sum(CASE WHEN account_code = '4100' THEN credit - debit ELSE 0 END)::text AS premium,
            sum(CASE WHEN account_code = '4200' THEN credit - debit ELSE 0 END)::text AS fee,
            sum(CASE WHEN account_code = '2300' THEN credit - debit ELSE 0 END)::text AS tax,
            sum(CASE WHEN account_code = '1200' THEN debit - credit ELSE 0 END)::text AS receivable,
            count(*) FILTER (WHERE export_batch IS NOT NULL)::int AS pushed_lines,
            min(posted_at) AS first_posted_at, max(posted_at) AS last_posted_at
     FROM gl_postings GROUP BY accounting_period ORDER BY accounting_period DESC`);
  return rows;
}

export type BatchRow = {
  batch: string; exported_at: Date; exported_by: string; format: string | null; from: string | null; to: string | null; type: string | null;
  lines_in_file: number | null; journals_in_file: number | null; lines_stamped: number; journals_stamped: number; debit: string | null; credit: string | null;
};

/** Every push to the GL, newest first: what the file held and which lines it was the first to carry. */
export async function listBatches(): Promise<BatchRow[]> {
  const { rows } = await policyDb.query<BatchRow>(
    `SELECT a.entity_id AS batch, a.occurred_at AS exported_at, a.actor AS exported_by, a.after->>'format' AS format,
            a.after->>'from' AS "from", a.after->>'to' AS "to", a.after->>'type' AS type,
            (a.after->>'lines')::int AS lines_in_file, (a.after->>'journals')::int AS journals_in_file,
            coalesce(p.lines, 0) AS lines_stamped, coalesce(p.journals, 0) AS journals_stamped, p.debit::text AS debit, p.credit::text AS credit
     FROM audit_events a
     LEFT JOIN (SELECT export_batch, count(*)::int AS lines, count(DISTINCT journal_no)::int AS journals, sum(debit) AS debit, sum(credit) AS credit
                FROM gl_postings WHERE export_batch IS NOT NULL GROUP BY export_batch) p ON p.export_batch = a.entity_id
     WHERE a.action = 'gl.exported' AND a.entity_type = 'ledger'
     ORDER BY a.id DESC`);
  return rows;
}

const EXPORT_HEADER = [
  "Journal", "Line", "Posting date", "Posted at (UTC)", "Accounting period", "Transaction type", "Account code", "Account name",
  "Debit", "Credit", "Description", "Policy number", "Insured", "Effective date", "Expiration date", "Underwriter", "Producer",
  "Quote", "Submission", "Source action", "UW action (audit)", "Policy", "Export batch",
];
const EXPORT_WIDTHS = [11, 5, 12, 22, 10, 13, 9, 34, 12, 12, 60, 13, 34, 12, 12, 13, 28, 16, 10, 13, 60, 50, 20];

export type LedgerFile = { filename: string; contentType: string; body: Uint8Array };

export type RenderMeta = {
  /** The push's batch, which lines not pushed before take; null renders a read, where they stay blank. */
  batch: string | null; actor: string; origin: string; period?: string | null; generatedAt?: Date;
};

/** The filtered lines as a file in `format`. Touches no batch stamps: the push does that before calling this. */
export function renderLedger(rows: Posting[], f: LedgerFilter, format: ExportFormat, meta: RenderMeta): LedgerFile {
  const data = rows.map((r) => [
    r.journal_no, r.line_no, glDate(r.posted_at), r.posted_at.toISOString(), r.accounting_period, TRANSACTION_LABEL[r.transaction_type],
    r.account_code, r.account_name, Number(r.debit), Number(r.credit), r.description, r.policy_number, r.insured_name,
    r.effective_date, r.expiration_date, r.underwriter, r.producer, r.quote_ref, r.submission_ref, r.source_action,
    `${meta.origin}/audit?submission=${r.submission_id}&correlation=${r.correlation_id}`, `${meta.origin}/policies/${r.policy_id}`, r.export_batch ?? meta.batch ?? "",
  ]);
  const stem = `gl-subledger-${f.from ?? "all"}-${f.to ?? "to-date"}${meta.batch ? `-${meta.batch}` : f.batch ? `-${f.batch}` : ""}`;
  const enc = new TextEncoder();
  if (format === "csv") return { filename: `${stem}.csv`, contentType: "text/csv; charset=utf-8", body: enc.encode(toCsv(EXPORT_HEADER, data)) };
  if (format === "json") {
    return {
      filename: `${stem}.json`, contentType: "application/json; charset=utf-8",
      body: enc.encode(ledgerJson(groupJournals(rows), ledgerTotals(rows), {
        batch: meta.batch, generatedAt: meta.generatedAt ?? new Date(), generatedBy: meta.actor, origin: meta.origin, timeZone: GL_TIME_ZONE,
        from: f.from, to: f.to, transactionType: f.type || null, period: meta.period ?? null, batchFilter: f.batch || null,
      })),
    };
  }
  return {
    filename: `${stem}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: toXlsx("Sub-ledger", EXPORT_HEADER, data, EXPORT_WIDTHS),
  };
}

/**
 * Push the filtered sub-ledger to the GL as a file. Lines not pushed before are stamped with this
 * batch; lines pushed earlier keep their batch (the file shows which). Audited.
 */
export async function exportLedger(f: LedgerFilter, format: ExportFormat, actor: string, origin: string, period: string | null = null) {
  const rows = await listPostings(f);
  const batch = (await policyDb.query<{ b: string }>(
    "SELECT 'GLX-' || to_char(now() AT TIME ZONE $1, 'YYYYMMDD') || '-' || lpad(nextval('gl_export_seq')::text, 3, '0') AS b", [GL_TIME_ZONE])).rows[0].b;
  const fresh = (await policyDb.query<{ id: number }>(
    "UPDATE gl_postings SET export_batch = $1, exported_at = now(), exported_by = $2 WHERE id = ANY($3) AND export_batch IS NULL RETURNING id",
    [batch, actor, rows.map((r) => r.id)])).rows.length;
  const file = renderLedger(rows, f, format, { batch, actor, origin, period });
  const t = ledgerTotals(rows);
  const range = `${f.from ?? "start"} to ${f.to ?? "today"}`;

  await audit({
    actor, action: "gl.exported", entityType: "ledger", entityId: batch,
    summary: `Sub-ledger pushed to the GL as ${format.toUpperCase()} (${batch}): ${rows.length} lines in ${t.journals} journals, `
      + `$${Math.round(t.debit).toLocaleString("en-US")} debits, ${range}${f.type ? `, ${TRANSACTION_LABEL[f.type]} only` : ""}; ${plural(fresh, "line")} newly marked as pushed`,
    after: { format, from: f.from, to: f.to, type: f.type || null, lines: rows.length, journals: t.journals, debit: t.debit, credit: t.credit, newly_stamped: fresh },
  });
  return { ...file, batch, lines: rows.length, journals: t.journals, fresh };
}
