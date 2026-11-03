import { moneyCents as money } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoDownload } from "@/components/auto-download";
import { ConfirmingForm } from "@/components/confirm-form";
import { SubmitButton } from "@/components/submit-button";
import { Section, when, whenDate } from "@/components/ui";
import {
  EXPORT_FORMATS, GL_TIME_ZONE, PERIOD_PRESETS, PRESET_LABEL, TRANSACTION_LABEL, glDate, periodLabel, type ExportFormat, type TransactionType,
} from "@/lib/gl-journal";
import { ledgerFileQuery, parseLedgerQuery } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { byPeriod, ledgerTotals, listPostings, type Journal } from "@/lib/ledger";
import { firstParams, type RawParams } from "@/lib/http";
import { iso, isIsoDate } from "@/lib/time";
import { pushToGlAction } from "./actions";

export const dynamic = "force-dynamic";

type Params = { period?: string; from?: string; to?: string; type?: string; batch?: string; msg?: string; error?: string; pushed?: string; pushed_batch?: string; format?: string };

/** The filter by the same rules as the API and the push (CR-086): bare from/to are a custom range. A bad value falls back rather than failing the page. */
const pageQuery = (p: Params) => parseLedgerQuery(p, glDate(new Date()), p.batch ? "all" : "this_month").query;

// UX-010: the tab names the month being looked at.
export async function generateMetadata({ searchParams }: { searchParams: Promise<RawParams<Params>> }): Promise<Metadata> {
  const q = pageQuery(firstParams<Params>(await searchParams));
  const month = q.from && q.to && q.from.slice(0, 7) === q.to.slice(0, 7) ? periodLabel(q.from.slice(0, 7)) : PRESET_LABEL[q.period];
  return { title: `Accounting · ${q.batch ? `batch ${q.batch}` : month}` };
}

const amount = (n: number | string) => (Number(n) === 0 ? "" : money(n));
// UX-006: clock times through the shared `when` (one display zone, zone named); posting dates and periods stay on GL_TIME_ZONE.
const TYPES = Object.keys(TRANSACTION_LABEL) as TransactionType[];

/** Accounting: the premium sub-ledger by accounting month, and the push to the general ledger. */
export default async function AccountingPage({ searchParams }: { searchParams: Promise<RawParams<Params>> }) {
  const p = firstParams<Params>(await searchParams);
  const query = pageQuery(p);
  const preset = query.period;
  const today = glDate(new Date());
  const range = { from: query.from, to: query.to };
  const filter = ledgerFilter(query);
  const rows = await listPostings(filter);
  const periods = byPeriod(rows);
  const t = ledgerTotals(rows);
  const rangeText = range.from || range.to ? `${range.from ? whenDate(range.from) : "start"} to ${whenDate(range.to ?? today)}` : "all periods";
  const pushed = rows.filter((r) => r.export_batch).length;
  // UX-022: the push just made (from the redirect), the batch most recently stamped among the lines shown.
  const justPushed = /^\d+$/.test(p.pushed ?? "") ? Number(p.pushed) : null;
  const format: ExportFormat = (EXPORT_FORMATS as readonly string[]).includes(p.format ?? "") ? (p.format as ExportFormat) : "xlsx";
  const last = rows.filter((r) => r.exported_at).sort((a, b) => b.exported_at!.getTime() - a.exported_at!.getTime())[0];
  const fileHref = `/api/gl/postings?${ledgerFileQuery(filter, format, { download: format === "json" })}`;   // a read: renders the same file without stamping

  return (
    <main className="mx-auto max-w-7xl p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Accounting</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Premium sub-ledger: what each underwriting action booked to the general ledger, by accounting month. Premium is booked in full
            when a policy is bound; cash collection and earning are not tracked here. Books are kept in {GL_TIME_ZONE.replace("_", " ")} time.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/accounting/api" title="REST API for other systems: documentation, OpenAPI spec and try-it links" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-center shadow-sm hover:bg-slate-50">
            <span className="block font-semibold">API</span><span className="block text-[11px] text-slate-500">for other systems</span>
          </Link>
          <Link href="/accounting/mcp" title="MCP server for agents: the spec, how to connect, and a live session" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-center shadow-sm hover:bg-slate-50">
            <span className="block font-semibold">MCP</span><span className="block text-[11px] text-slate-500">for agents</span>
          </Link>
        </div>
      </div>

      {p.msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{p.msg}</p>}
      {p.error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{p.error}</p>}
      {/* UX-022: the push just made, confirmed on the page; the file follows on its own. */}
      {justPushed !== null && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {justPushed > 0 && p.pushed_batch
            ? <><span className="font-medium">Pushed batch <code className="text-xs">{p.pushed_batch}</code></span><span>{justPushed} of {rows.length} line{rows.length === 1 ? "" : "s"} newly marked; the file holds all {rows.length}</span></>
            : <><span className="font-medium">Nothing new to push</span><span>every line in the file had been pushed in an earlier batch; the file shows which</span></>}
          <a href={fileHref} className="font-medium underline">Download .{format}</a>
          <span className="text-xs text-emerald-700">(downloading now)</span>
          {p.pushed_batch && <Link href={`/accounting?batch=${encodeURIComponent(p.pushed_batch)}`} className="ml-auto text-xs underline">Show only this batch</Link>}
          <AutoDownload href={fileHref} strip={["pushed", "pushed_batch", "format"]} />
        </p>
      )}
      {filter.batch && (
        <p className="mt-4 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
          Showing the lines pushed in batch <code className="text-xs">{filter.batch}</code>. <Link href="/accounting" className="underline">Show all</Link>
        </p>
      )}

      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {filter.batch && <input type="hidden" name="batch" value={filter.batch} />}
        <label className="flex flex-col gap-1 text-xs text-slate-500">Period
          <select name="period" defaultValue={preset} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            {PERIOD_PRESETS.map((k) => <option key={k} value={k}>{PRESET_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">From (custom)
          <input type="date" name="from" defaultValue={isIsoDate(p.from) ? p.from : ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">To (custom)
          <input type="date" name="to" defaultValue={isIsoDate(p.to) ? p.to : ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Transaction type
          <select name="type" defaultValue={filter.type} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="">All</option>
            {TYPES.map((k) => <option key={k} value={k}>{TRANSACTION_LABEL[k]}</option>)}
          </select>
        </label>
        <button className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">Show</button>
        <span className="py-1.5 text-xs text-slate-500">Posting dates {rangeText}{filter.type ? ` · ${TRANSACTION_LABEL[filter.type]} only` : ""} · {GL_TIME_ZONE.replace("_", " ")} days</span>
      </form>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Written premium (4100)" value={money(t.premium)} />
        <Tile label="Policy fees (4200)" value={money(t.fee)} />
        <Tile label="Surplus lines tax payable (2300)" value={money(t.tax)} />
        <Tile label="Booked to receivable (1200)" value={money(t.receivable)} sub={`debits ${money(t.debit)} = credits ${money(t.credit)}`} />
        <Tile label="Journals" value={String(t.journals)} sub={Object.entries(t.byType).map(([k, n]) => `${n} ${TRANSACTION_LABEL[k as TransactionType].toLowerCase()}`).join(" · ") || "none"} />
      </div>

      <div className="mt-6">
      <Section title="Push to the general ledger">
        {/* UX-022 / UX-009: a server action (same push as POST /api/gl/exports) so the buttons can show their pending state. */}
        <ConfirmingForm action={pushToGlAction} className="flex flex-wrap items-center gap-3 p-4 text-sm"
          confirmText={rows.length > pushed ? `Push ${rows.length - pushed} line${rows.length - pushed === 1 ? "" : "s"} as a new GL batch? They will be marked pushed.` : undefined}>
          <input type="hidden" name="period" value={preset} />
          <input type="hidden" name="from" value={isIsoDate(p.from) ? p.from : ""} />
          <input type="hidden" name="to" value={isIsoDate(p.to) ? p.to : ""} />
          <input type="hidden" name="type" value={filter.type} />
          <input type="hidden" name="batch" value={filter.batch} />
          <SubmitButton pending="Preparing file…" name="format" value="xlsx" disabled={!rows.length} className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Push &amp; download Excel</SubmitButton>
          <SubmitButton pending="Preparing file…" name="format" value="csv" disabled={!rows.length} className="rounded-md border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-50">Push &amp; download CSV</SubmitButton>
          <SubmitButton pending="Preparing file…" name="format" value="json" disabled={!rows.length} className="rounded-md border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-50">Push &amp; download JSON</SubmitButton>
          <span className="text-xs text-slate-500">
            Downloads the {rows.length} line{rows.length === 1 ? "" : "s"} shown: Excel and CSV as one row per journal line, JSON as journals with their lines, each with the policy details and a link to the underwriting action.{" "}
            {rows.length > 0 && pushed === rows.length
              ? <>All {rows.length} line{rows.length === 1 ? "" : "s"} shown were pushed{last?.export_batch ? <> (last batch <code>{last.export_batch}</code> on {whenDate(last.exported_at!)})</> : ""}. Exporting again re-stamps nothing; the file names each line&apos;s batch.</>
              : <>Lines not pushed before are marked with this batch ({pushed} of {rows.length} already pushed).</>}{" "}
            Other systems can pull the same data from the <Link href="/accounting/api" className="text-indigo-600 hover:underline">API</Link>; agents through the <Link href="/accounting/mcp" className="text-indigo-600 hover:underline">MCP server</Link>.
          </span>
          {rows.length > 0 && (
            <span className="basis-full text-xs text-slate-500">
              Download without pushing:{" "}
              {EXPORT_FORMATS.map((f, i) => (
                <span key={f}>{i > 0 && " · "}<a href={`/api/gl/postings?${ledgerFileQuery(filter, f, { download: f === "json" })}`} className="text-indigo-600 hover:underline">{f === "xlsx" ? "Excel" : f.toUpperCase()}</a></span>
              ))}
            </span>
          )}
        </ConfirmingForm>
      </Section>
      </div>

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
                {g.journals.map((j) => <JournalRows key={j.journal_no} j={j} highlight={justPushed ? p.pushed_batch : undefined} />)}
              </tbody>
            </table>
          </section>
        ))}
        {!rows.length && (
          <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
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
      {sub && <p className="mt-0.5 truncate text-xs text-slate-500" title={sub}>{sub}</p>}
    </div>
  );
}

/** `highlight`: the batch just pushed (UX-022), called out on its journals. */
function JournalRows({ j, highlight }: { j: Journal; highlight?: string }) {
  return (
    <>
      <tr className="border-t border-slate-200 bg-slate-50/60">
        <td colSpan={4} className="px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs font-semibold">{j.journal_no}</span>
            <time dateTime={iso(j.posted_at)} className="text-xs text-slate-500">{when(j.posted_at)}</time>
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">{TRANSACTION_LABEL[j.transaction_type]}</span>
            <Link href={`/policies/${j.policy_id}`} className="font-medium text-indigo-600 hover:underline">{j.policy_number}</Link>
            <span>{j.insured_name}</span>
            <span className="text-xs text-slate-500">{whenDate(j.effective_date)} → {whenDate(j.expiration_date)} · {j.quote_ref} · {j.submission_ref} · UW {j.underwriter}{j.producer ? ` · ${j.producer}` : ""}</span>
            <Link href={`/audit?submission=${j.submission_id}&correlation=${j.correlation_id}`} className="text-xs text-indigo-600 hover:underline">UW action →</Link>
            <span className={`ml-auto text-[11px] ${j.export_batch && j.export_batch === highlight ? "rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800" : "text-slate-500"}`}>
              {j.export_batch ? <>pushed · {j.export_batch} · {j.exported_at && <time dateTime={iso(j.exported_at)}>{when(j.exported_at)}</time>}</> : "not yet pushed"}
            </span>
          </div>
        </td>
      </tr>
      {j.lines.map((l) => (
        <tr key={l.id} className="border-t border-slate-100">
          <td className="px-4 py-1 pl-10 text-xs text-slate-500">line {l.line_no}</td>
          <td className="px-4 py-1"><span className="font-mono text-xs text-slate-500">{l.account_code}</span> <span>{l.account_name}</span></td>
          <td className="px-4 py-1 text-right tabular-nums">{amount(l.debit)}</td>
          <td className="px-4 py-1 text-right tabular-nums">{amount(l.credit)}</td>
        </tr>
      ))}
    </>
  );
}
