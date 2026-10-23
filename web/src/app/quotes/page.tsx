import Link from "next/link";
import { listQuotes } from "@/lib/quotes";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  issued: "bg-indigo-50 text-indigo-700", superseded: "bg-slate-100 text-slate-500", bound: "bg-emerald-50 text-emerald-700",
};

export default async function QuotesPage() {
  const quotes = await listQuotes();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <p className="mt-1 text-sm text-slate-500">Every issued version, with the PDF exactly as sent.</p>
      <table className="mt-6 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Quote</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Effective</th>
            <th className="px-4 py-2 text-right">Premium</th><th className="px-4 py-2 text-right">Total</th>
            <th className="px-4 py-2">Rates</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Issued</th><th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.id} className={`border-t border-slate-100 ${q.status === "superseded" ? "text-slate-400" : ""}`}>
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{q.quote_number} v{q.version}</td>
              <td className="px-4 py-2"><Link href={`/submissions/${q.submission_id}/workbench`} className="hover:underline">{q.insured_name}</Link></td>
              <td className="whitespace-nowrap px-4 py-2 tabular-nums">{q.effective_date}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(q.premium)}</td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">{money(q.total)}</td>
              <td className="px-4 py-2 text-xs">{q.rate_version}</td>
              <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[q.status]}`}>{q.status}</span></td>
              <td className="px-4 py-2 text-xs text-slate-500">{q.issued_by}, {q.issued_at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              <td className="px-4 py-2"><a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-indigo-600 hover:underline">PDF</a></td>
            </tr>
          ))}
          {!quotes.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">No quotes yet. Issue one from a ready-to-quote workbench.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
