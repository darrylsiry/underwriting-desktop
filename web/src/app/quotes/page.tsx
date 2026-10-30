import Link from "next/link";
import { listQuotes } from "@/lib/quotes";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  issued: "bg-indigo-50 text-indigo-700", superseded: "bg-slate-100 text-slate-500", bound: "bg-emerald-50 text-emerald-700",
};

type Params = { highlight?: string };

/** Every quote version. `?highlight=<quote id>` (where issuing a quote lands) calls out that version. */
export default async function QuotesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { highlight } = await searchParams;
  const quotes = await listQuotes();
  const picked = highlight ? quotes.find((q) => q.id === highlight) : undefined;
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <p className="mt-1 text-sm text-slate-500">Every issued version, with the PDF exactly as sent.</p>
      {picked && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
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
              <tr key={q.id} id={`quote-${q.id}`} className={`border-t border-slate-100 ${hit ? "bg-amber-50 shadow-[inset_4px_0_0_0_theme(colors.amber.400)]" : q.status === "superseded" ? "text-slate-400" : ""}`}>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                  <Link href={`/quotes/${q.id}`} className="text-indigo-600 hover:underline">{q.quote_number} v{q.version}</Link>
                  {hit && <span className="ml-2 rounded-full bg-amber-500 px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-white">just issued</span>}
                </td>
                <td className="px-4 py-2"><Link href={`/submissions/${q.submission_id}/workbench`} className="hover:underline">{q.insured_name}</Link></td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums">{q.effective_date}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(q.premium)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{money(q.total)}</td>
                <td className="px-4 py-2 text-xs">{q.rate_version}</td>
                <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[q.status]}`}>{q.status}</span></td>
                <td className="px-4 py-2 text-xs text-slate-500">{q.issued_by}, {q.issued_at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-indigo-600 hover:underline">PDF</a>
                  {q.has_memo && <> · <a href={`/quotes/${q.id}/memo`} target="_blank" className="text-indigo-600 hover:underline">memo</a></>}
                </td>
              </tr>
            );
          })}
          {!quotes.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">No quotes yet. Issue one from a ready-to-quote workbench.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
