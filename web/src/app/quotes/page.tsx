import type { Metadata } from "next";
import Link from "next/link";
import { DaysChip, Pill, when, whenDate } from "@/components/ui";
import { quoteState } from "@/lib/bind-rules";
import { daysUntil } from "@/lib/book-metrics";
import { firstParams, type RawParams } from "@/lib/http";
import { listQuotes, type QuoteRow } from "@/lib/quotes";
import { submissionIdsReceivedBy } from "@/lib/submissions";
import { iso, todayIso } from "@/lib/time";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quotes" };   // UX-010

type Params = { highlight?: string; status?: string; underwriter?: string; live?: string };

/** The pills: what each one holds, in the words the pages use (UX-062). `issued` alone is everything not yet bound or superseded, expired included. */
const PILLS: { key: string; label: string; query: string; holds: (q: QuoteRow, today: string) => boolean }[] = [
  { key: "out", label: "Out", query: "status=issued&live=1", holds: (q, t) => quoteState(q, t) === "issued" },
  { key: "expired", label: "Expired", query: "status=expired", holds: (q, t) => quoteState(q, t) === "expired" },
  { key: "bound", label: "Bound", query: "status=bound", holds: (q) => q.status === "bound" },
  { key: "not_taken", label: "Not taken", query: "status=not_taken", holds: (q) => q.status === "not_taken" },
  { key: "superseded", label: "Superseded", query: "status=superseded", holds: (q) => q.status === "superseded" },
];

/**
 * Every quote version. `?highlight=<quote id>` (where issuing a quote lands) calls out that version;
 * `?status=issued&live=1&underwriter=<name>` is the desk's Quotes out tile: still valid, not yet bound or superseded, from that underwriter's submissions.
 */
export default async function QuotesPage({ searchParams }: { searchParams: Promise<RawParams<Params>> }) {
  const p = firstParams<Params>(await searchParams);
  const today = todayIso();
  const underwriter = p.underwriter?.trim() || null;
  const live = p.live === "1";
  const all = await listQuotes({ submissionIds: underwriter ? await submissionIdsReceivedBy(underwriter) : null });
  const active = p.status === "issued" && live ? "out" : PILLS.find((x) => x.key === p.status)?.key ?? null;
  const issuedAny = p.status === "issued" && !live;   // a link from before the pills: not yet bound or superseded, expired included
  const pill = PILLS.find((x) => x.key === active);
  const quotes = pill ? all.filter((q) => pill.holds(q, today)) : issuedAny ? all.filter((q) => q.status === "issued") : all;
  const filtered = !!pill || issuedAny;
  const scope = underwriter ? `&underwriter=${encodeURIComponent(underwriter)}` : "";
  const picked = p.highlight ? quotes.find((q) => q.id === p.highlight) : undefined;
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <p className="mt-1 text-sm text-slate-500">Every issued version, with the PDF exactly as sent.</p>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{quotes.length} version{quotes.length === 1 ? "" : "s"} · newest first</span>
        <span className="flex flex-wrap gap-1">
          <Link href={underwriter ? `/quotes?${scope.slice(1)}` : "/quotes"} className={`rounded-full border px-2 py-0.5 ${!filtered ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>All {all.length}</Link>
          {PILLS.map((x) => (
            <Link key={x.key} href={`/quotes?${x.query}${scope}`} className={`rounded-full border px-2 py-0.5 ${active === x.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
              {x.label} {all.filter((q) => x.holds(q, today)).length}
            </Link>
          ))}
        </span>
      </p>
      {(filtered || underwriter) && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span className="font-medium">{p.status === "issued" ? (live ? "Quotes out: issued, still valid and not yet bound or superseded" : "Issued and not yet bound or superseded, expired ones included") : pill ? `${pill.label} quotes` : "Quotes"}{underwriter ? ` from ${underwriter}'s submissions` : ""}</span>
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
            <th className="px-4 py-2">Rates</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Valid until</th><th className="px-4 py-2">Issued</th><th className="px-4 py-2" />
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
                <td className="px-4 py-2"><Pill status={quoteState(q, today)} /></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums">{whenDate(q.valid_until)}{q.status === "issued" && <span className="ml-2"><DaysChip days={daysUntil(q.valid_until, today)} /></span>}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{q.issued_by}, <time dateTime={iso(q.issued_at)}>{when(q.issued_at)}</time></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-indigo-600 hover:underline">PDF</a>
                  {q.has_memo && <> · <a href={`/quotes/${q.id}/memo`} target="_blank" className="text-indigo-600 hover:underline">memo</a></>}
                </td>
              </tr>
            );
          })}
          {!quotes.length && <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">
            {filtered ? <>No quotes match this filter. <Link href="/quotes" className="text-indigo-600 hover:underline">Show all</Link></> : "No quotes yet. Issue one from a ready-to-quote workbench."}
          </td></tr>}
        </tbody>
      </table>
    </main>
  );
}
