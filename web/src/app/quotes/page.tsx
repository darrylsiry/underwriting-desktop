import type { Metadata } from "next";
import Link from "next/link";
import { when, whenDate } from "@/components/ui";
import { listQuotes, type QuoteRow } from "@/lib/quotes";
import { submissionIdsReceivedBy } from "@/lib/submissions";
import { iso } from "@/lib/time";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quotes" };   // UX-010

const STATUS_STYLE: Record<string, string> = {
  issued: "bg-indigo-50 text-indigo-700", superseded: "bg-slate-100 text-slate-500", bound: "bg-emerald-50 text-emerald-700",
};

type Params = { highlight?: string; status?: string; underwriter?: string };
const STATUSES: QuoteRow["status"][] = ["issued", "superseded", "bound"];

/**
 * Every quote version. `?highlight=<quote id>` (where issuing a quote lands) calls out that version;
 * `?status=issued&underwriter=<name>` is the desk's Quotes out tile: current quotes, not yet bound or superseded, from that underwriter's submissions.
 */
export default async function QuotesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const status = STATUSES.includes(p.status as QuoteRow["status"]) ? (p.status as QuoteRow["status"]) : null;
  const underwriter = p.underwriter?.trim() || null;
  const quotes = await listQuotes({ status, submissionIds: underwriter ? await submissionIdsReceivedBy(underwriter) : null });
  const picked = p.highlight ? quotes.find((q) => q.id === p.highlight) : undefined;
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <p className="mt-1 text-sm text-slate-500">Every issued version, with the PDF exactly as sent.</p>
      {(status || underwriter) && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span className="font-medium">{status === "issued" ? "Quotes out: issued and not yet bound or superseded" : status ? `Status: ${status}` : "All statuses"}{underwriter ? `, from ${underwriter}'s submissions` : ""}</span>
          <span>{quotes.length} quote{quotes.length === 1 ? "" : "s"} · {money(quotes.reduce((n, q) => n + Number(q.total), 0))} total</span>
          <Link href="/quotes" className="ml-auto text-xs underline">Show all quotes</Link>
        </p>
      )}
      {/* UX-025: "just issued" is a done state, so emerald (amber means needs attention everywhere else). */}
      {picked && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
          <span className="font-medium">{picked.quote_number} v{picked.version} issued</span>
          <span>{picked.insured_name} · {money(picked.total)} total{picked.version > 1 ? ` · supersedes v${picked.version - 1}` : ""}</span>
          <span className="ml-auto flex gap-3 text-xs">
            <Link href={`/quotes/${picked.id}`} className="font-medium text-indigo-700 hover:underline">Open quote</Link>
            <a href={`/quotes/${picked.id}/pdf`} target="_blank" className="text-indigo-700 hover:underline">Quote PDF</a>
            {picked.has_memo && <a href={`/quotes/${picked.id}/memo`} target="_blank" className="text-indigo-700 hover:underline">Renewal memo PDF</a>}
            <Link href={picked.has_memo ? `/submissions/${picked.submission_id}/renewal` : `/submissions/${picked.submission_id}/workbench`} className="text-indigo-700 hover:underline">
              {picked.has_memo ? "Expiring vs renewing →" : "Workbench →"}
            </Link>
          </span>
        </p>
      )}
      <table className="mt-6 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Quote</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Effective</th>
            <th className="px-4 py-2 text-right">Premium</th><th className="px-4 py-2 text-right">Total</th>
            <th className="px-4 py-2">Rates</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Issued</th><th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => {
            const hit = q.id === picked?.id;
            return (
              <tr key={q.id} id={`quote-${q.id}`} className={`border-t border-slate-100 ${hit ? "bg-emerald-50 shadow-[inset_4px_0_0_0_theme(colors.emerald.400)]" : q.status === "superseded" ? "text-slate-500" : ""}`}>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                  <Link href={`/quotes/${q.id}`} className="text-indigo-600 hover:underline">{q.quote_number} v{q.version}</Link>
                  {hit && <span className="ml-2 rounded-full bg-emerald-600 px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-white">just issued</span>}
                </td>
                {/* UX-013: the insured's name opens the customer; it looks like the link it is. */}
                <td className="px-4 py-2">{q.insured_id ? <Link href={`/insureds/${q.insured_id}`} className="text-indigo-600 hover:underline">{q.insured_name}</Link> : q.insured_name}</td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums">{whenDate(q.effective_date)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(q.premium)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{money(q.total)}</td>
                <td className="px-4 py-2 text-xs">{q.rate_version}</td>
                <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[q.status]}`}>{q.status}</span></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{q.issued_by}, <time dateTime={iso(q.issued_at)}>{when(q.issued_at)}</time></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-indigo-600 hover:underline">PDF</a>
                  {q.has_memo && <> · <a href={`/quotes/${q.id}/memo`} target="_blank" className="text-indigo-600 hover:underline">memo</a></>}
                </td>
              </tr>
            );
          })}
          {!quotes.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-500">No quotes yet. Issue one from a ready-to-quote workbench.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
