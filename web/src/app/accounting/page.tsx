import Link from "next/link";
import { Section } from "@/components/ui";
import {
  GL_TIME_ZONE, PERIOD_PRESETS, PRESET_LABEL, TRANSACTION_LABEL, glDate, periodLabel, presetRange, type PeriodPreset, type TransactionType,
} from "@/lib/gl-journal";
import { byPeriod, ledgerTotals, listPostings, type Journal, type LedgerFilter } from "@/lib/ledger";

export const dynamic = "force-dynamic";

type Params = { period?: string; from?: string; to?: string; type?: string; batch?: string; msg?: string; error?: string };

const money = (n: number | string) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amount = (n: number | string) => (Number(n) === 0 ? "" : money(n));
const when = (d: Date) => d.toLocaleString("en-US", { timeZone: GL_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const TYPES = Object.keys(TRANSACTION_LABEL) as TransactionType[];

/** Accounting: the premium sub-ledger by accounting month, and the push to the general ledger. */
export default async function AccountingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const preset: PeriodPreset = (PERIOD_PRESETS as readonly string[]).includes(p.period ?? "") ? (p.period as PeriodPreset) : p.batch ? "all" : "this_month";
  const today = glDate(new Date());
  const range = presetRange(preset, today, { from: isDate(p.from) ? p.from! : null, to: isDate(p.to) ? p.to! : null });
  const filter: LedgerFilter = { from: range.from, to: range.to, type: TYPES.includes(p.type as TransactionType) ? (p.type as TransactionType) : "", batch: p.batch ?? "" };
  const rows = await listPostings(filter);
  const periods = byPeriod(rows);
  const t = ledgerTotals(rows);
  const rangeText = range.from || range.to ? `${range.from ?? "start"} to ${range.to ?? today}` : "all periods";
  const pushed = rows.filter((r) => r.export_batch).length;

  return (
    <main className="mx-auto max-w-7xl p-8">
      <h1 className="text-2xl font-semibold">Accounting</h1>
      <p className="mt-1 text-sm text-slate-500">
        Premium sub-ledger: what each underwriting action booked to the general ledger, by accounting month. Premium is booked in full
        when a policy is bound; cash collection and earning are not tracked here. Books are kept in {GL_TIME_ZONE.replace("_", " ")} time.
      </p>

      {p.msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{p.msg}</p>}
      {p.error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{p.error}</p>}
      {p.batch && (
        <p className="mt-4 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
          Showing the lines pushed in batch <code className="text-xs">{p.batch}</code>. <Link href="/accounting" className="underline">Show all</Link>
        </p>
      )}

      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {p.batch && <input type="hidden" name="batch" value={p.batch} />}
        <label className="flex flex-col gap-1 text-xs text-slate-500">Period
          <select name="period" defaultValue={preset} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            {PERIOD_PRESETS.map((k) => <option key={k} value={k}>{PRESET_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">From (custom)
          <input type="date" name="from" defaultValue={isDate(p.from) ? p.from : ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">To (custom)
          <input type="date" name="to" defaultValue={isDate(p.to) ? p.to : ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Transaction type
          <select name="type" defaultValue={filter.type} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="">All</option>
            {TYPES.map((k) => <option key={k} value={k}>{TRANSACTION_LABEL[k]}</option>)}
          </select>
        </label>
        <button className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">Show</button>
        <span className="py-1.5 text-xs text-slate-500">Posting dates {rangeText}{filter.type ? ` · ${TRANSACTION_LABEL[filter.type]} only` : ""}</span>
      </form>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Written premium (4100)" value={money(t.premium)} />
        <Tile label="Policy fees (4200)" value={money(t.fee)} />
        <Tile label="Surplus lines tax payable (2300)" value={money(t.tax)} />
        <Tile label="Booked to receivable (1200)" value={money(t.receivable)} sub={`debits ${money(t.debit)} = credits ${money(t.credit)}`} />
        <Tile label="Journals" value={String(t.journals)} sub={Object.entries(t.byType).map(([k, n]) => `${n} ${TRANSACTION_LABEL[k as TransactionType].toLowerCase()}`).join(" · ") || "none"} />
      </div>

      <Section title="Push to the general ledger">
        <form method="post" action="/accounting/export" className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <input type="hidden" name="period" value={preset} />
          <input type="hidden" name="from" value={isDate(p.from) ? p.from : ""} />
          <input type="hidden" name="to" value={isDate(p.to) ? p.to : ""} />
          <input type="hidden" name="type" value={filter.type} />
          <input type="hidden" name="batch" value={filter.batch} />
          <button name="format" value="xlsx" disabled={!rows.length} className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Export Excel (.xlsx)</button>
          <button name="format" value="csv" disabled={!rows.length} className="rounded-md border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-50">Export CSV</button>
          <span className="text-xs text-slate-500">
            Downloads the {rows.length} line{rows.length === 1 ? "" : "s"} shown, one row per journal line with the policy details and a link to the underwriting action.
            Lines not pushed before are marked with this batch ({pushed} of {rows.length} already pushed).
          </span>
        </form>
      </Section>

      <div className="mt-6 space-y-6">
        {periods.map((g) => (
          <section key={g.period} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-2">
              <h2 className="text-sm font-semibold">{periodLabel(g.period)} <span className="font-mono text-xs font-normal text-slate-500">{g.period}</span></h2>
              <span className="text-xs text-slate-500">{g.totals.journals} journal{g.totals.journals === 1 ? "" : "s"}</span>
              <span className="ml-auto text-xs text-slate-600">written premium {money(g.totals.premium)} · fees {money(g.totals.fee)} · SL tax {money(g.totals.tax)} · debits {money(g.totals.debit)} = credits {money(g.totals.credit)}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2 font-medium">Journal · posted</th><th className="px-4 py-2 font-medium">Account</th><th className="px-4 py-2 text-right font-medium">Debit</th><th className="px-4 py-2 text-right font-medium">Credit</th></tr>
              </thead>
              <tbody>
                {g.journals.map((j) => <JournalRows key={j.journal_no} j={j} />)}
              </tbody>
            </table>
          </section>
        ))}
        {!rows.length && (
          <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
            Nothing booked for {rangeText}. Try <Link href="/accounting?period=ytd" className="text-indigo-600 hover:underline">year to date</Link> or{" "}
            <Link href="/accounting?period=all" className="text-indigo-600 hover:underline">all periods</Link>.
          </p>
        )}
      </div>
      {rows.length > 0 && (
        <p className="mt-4 text-right text-sm font-semibold tabular-nums">
          Total for {rangeText}: debits {money(t.debit)} · credits {money(t.credit)}
        </p>
      )}
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-slate-400" title={sub}>{sub}</p>}
    </div>
  );
}

function JournalRows({ j }: { j: Journal }) {
  return (
    <>
      <tr className="border-t border-slate-200 bg-slate-50/60">
        <td colSpan={4} className="px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs font-semibold">{j.journal_no}</span>
            <span className="text-xs text-slate-500">{when(j.posted_at)}</span>
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">{TRANSACTION_LABEL[j.transaction_type]}</span>
            <Link href={`/policies/${j.policy_id}`} className="font-medium text-indigo-600 hover:underline">{j.policy_number}</Link>
            <span>{j.insured_name}</span>
            <span className="text-xs text-slate-500">{j.effective_date} → {j.expiration_date} · {j.quote_ref} · {j.submission_ref} · UW {j.underwriter}{j.producer ? ` · ${j.producer}` : ""}</span>
            <Link href={`/audit?submission=${j.submission_id}&correlation=${j.correlation_id}`} className="text-xs text-indigo-600 hover:underline">UW action →</Link>
            <span className="ml-auto text-[11px] text-slate-500">
              {j.export_batch ? `pushed · ${j.export_batch} · ${j.exported_at ? when(j.exported_at) : ""}` : "not yet pushed"}
            </span>
          </div>
        </td>
      </tr>
      {j.lines.map((l) => (
        <tr key={l.id} className="border-t border-slate-100">
          <td className="px-4 py-1 pl-10 text-xs text-slate-400">line {l.line_no}</td>
          <td className="px-4 py-1"><span className="font-mono text-xs text-slate-500">{l.account_code}</span> <span>{l.account_name}</span></td>
          <td className="px-4 py-1 text-right tabular-nums">{amount(l.debit)}</td>
          <td className="px-4 py-1 text-right tabular-nums">{amount(l.credit)}</td>
        </tr>
      ))}
    </>
  );
}
