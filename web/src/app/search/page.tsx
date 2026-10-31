import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Empty, Pill, RowLink, Section, money, whenDate } from "@/components/ui";
import { directHit, search } from "@/lib/search";
import { parseQuery } from "@/lib/search-terms";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ q?: string; all?: string }> };

// UX-010
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q = "" } = await searchParams;
  return { title: q.trim() ? `Search: ${q.trim()}` : "Search" };
}

export default async function SearchPage({ searchParams }: Props) {
  const { q = "", all } = await searchParams;
  const query = parseQuery(q);
  const results = query ? await search(query) : null;
  // A full reference (SUB-0003, Q-2026-0001 v2, GL-26-00001) goes straight to the record.
  const hit = query && results && !all ? directHit(query, results) : null;
  if (hit) redirect(hit);
  const total = results ? results.insureds.length + results.submissions.length + results.quotes.length + results.policies.length : 0;

  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Search</h1>
      <form action="/search" className="mt-4 flex gap-2">
        <input name="q" defaultValue={q} autoFocus placeholder="Insured, FEIN, broker, class code, SUB-…, Q-…, GL-…"
          className="w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Search</button>
      </form>
      {!query && <p className="mt-4 text-sm text-slate-500">Type at least two characters.</p>}
      {results && (
        <>
          <p className="mt-4 text-sm text-slate-500">{total} result{total === 1 ? "" : "s"} for “{query!.text}”{query!.reference && ` (looks like a ${query!.reference} reference)`}</p>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Section title={`Customers · ${results.insureds.length}`}>
              {results.insureds.map((i) => (
                <Link key={i.id} href={`/insureds/${i.id}`} className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-sm first:border-0 hover:bg-slate-50">
                  <span className="font-medium">{i.name}</span>
                  <span className="ml-auto text-xs text-slate-500">{[i.fein, i.state].filter(Boolean).join(" · ")}</span>
                </Link>
              ))}
              {!results.insureds.length && <Empty>No customers</Empty>}
            </Section>
            <Section title={`Submissions · ${results.submissions.length}`}>
              {results.submissions.map((s) => (
                <Link key={s.id} href={`/submissions/${s.id}`} className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-sm first:border-0 hover:bg-slate-50">
                  <span className="font-mono text-xs">{s.reference}</span>
                  <span className="font-medium">{s.applicant_name || "unnamed"}</span>
                  <span className="text-xs text-slate-500">{[s.class_code, s.agency].filter(Boolean).join(" · ")}</span>
                  <span className="ml-auto"><Pill status={s.status} /></span>
                </Link>
              ))}
              {!results.submissions.length && <Empty>No submissions</Empty>}
            </Section>
            <Section title={`Quotes · ${results.quotes.length}`}>
              {results.quotes.map((x) => (
                <Link key={x.id} href={`/quotes/${x.id}`} className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-sm first:border-0 hover:bg-slate-50">
                  <span className="whitespace-nowrap font-mono text-xs">{x.quote_number} v{x.version}</span>
                  <span>{x.insured_name}</span>
                  <span className="ml-auto tabular-nums">{money(x.total)}</span>
                  <Pill status={x.status} />
                </Link>
              ))}
              {!results.quotes.length && <Empty>No quotes</Empty>}
            </Section>
            <Section title={`Policies · ${results.policies.length}`}>
              {results.policies.map((p) => (
                <Link key={p.id} href={`/policies/${p.id}`} className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-sm first:border-0 hover:bg-slate-50">
                  <span className="font-mono text-xs">{p.policy_number}</span>
                  <span>{p.insured_name}</span>
                  <span className="ml-auto text-xs text-slate-500">eff. {whenDate(p.effective_date)}</span>{/* UX-025 */}
                  <span className="tabular-nums">{money(p.total)}</span>
                </Link>
              ))}
              {!results.policies.length && <Empty>No policies</Empty>}
            </Section>
          </div>
          {total === 0 && <p className="mt-6 text-sm text-slate-500">Nothing found. Try part of a name, a FEIN, or a reference like <RowLink href="/search?q=SUB-0001">SUB-0001</RowLink>.</p>}
        </>
      )}
    </main>
  );
}
