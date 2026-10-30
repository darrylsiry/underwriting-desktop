import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { Pill, RowLink, Section, money, when } from "@/components/ui";
import { policiesForSubmission } from "@/lib/policies";
import { addYears, suggestedSubjectivities } from "@/lib/quote-terms";
import { quotesForSubmission } from "@/lib/quotes";
import { changeSummary, compareRenewal, pctText, signed, type Comparison, type Side } from "@/lib/renewal-compare";
import { expiringOf } from "@/lib/renewals";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { activeRateVersion, openWorksheet, readiness } from "@/lib/worksheets";
import { IssueQuoteForm } from "../issue-quote-form";
import { issueRenewalQuoteAction, reRateAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> };

const CAUSE: Record<string, { label: string; style: string }> = {
  terms: { label: "terms", style: "bg-sky-50 text-sky-700" },
  rates: { label: "rates", style: "bg-amber-50 text-amber-800" },
  both: { label: "terms + rates", style: "bg-violet-50 text-violet-700" },
};

/** Side-by-side: the expiring policy and the renewing terms, with the rate comparison and the premium bridge. */
export default async function RenewalPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { msg, error } = await searchParams;
  const sub = await getSubmission(id);
  if (!sub) notFound();
  const exp = expiringOf(sub);
  if (!exp) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="rounded bg-amber-50 px-4 py-3 text-amber-800">
          {sub.reference} is new business, not a renewal. <Link href={`/submissions/${id}/workbench`} className="underline">Open its workbench</Link>.
        </p>
      </main>
    );
  }
  const ws = await openWorksheet(sub, await currentUser());
  const { flags, openReferrals, rated, ready, staleRates } = readiness(sub, ws, await activeRateVersion());
  const [quotes, policies] = await Promise.all([quotesForSubmission(id), policiesForSubmission(id)]);
  const latest = quotes[0];
  const policy = policies[0];
  const effective = latest?.effective_date ?? String(sub.data.policy?.effective_date ?? exp.expiration_date);
  const expiration = latest?.expiration_date ?? addYears(effective, 1);
  const subjectivities = latest?.subjectivities ?? ["Signed renewal application or no-change confirmation", ...suggestedSubjectivities(flags, sub.data).slice(1)];
  const expiringHref = exp.source === "book" ? `/policies/book/${exp.policy_id}` : `/policies/${exp.policy_id}`;

  const expiringSide: Side = { inputs: exp.rating_inputs, schedule: exp.schedule, rating: exp.rating, effective_date: exp.effective_date, expiration_date: exp.expiration_date };
  const comparison: Comparison | null = ws.last_rating
    ? compareRenewal(expiringSide, { inputs: ws.rating_inputs, schedule: ws.schedule, rating: ws.last_rating, effective_date: effective, expiration_date: expiration }, ws.bridge_rating)
    : null;
  const b = comparison?.bridge;
  const status = policy ? `Renewed · ${policy.policy_number}` : latest ? `Quoted · ${latest.quote_number} v${latest.version}` : ready ? "Ready to quote"
    : !rated ? (ws.last_rating ? "Rating out of date" : "Not rated") : `${openReferrals.length} referral${openReferrals.length === 1 ? "" : "s"} open`;

  return (
    <main className="mx-auto max-w-7xl p-8">
      <RowLink href={expiringHref}>← Expiring policy {exp.policy_number}</RowLink>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Renewal · {sub.applicant_name}</h1>
        <span className="font-mono text-sm text-slate-500">{sub.reference}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${policy || ready || latest ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>{status}</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Expiring {exp.policy_number} ({exp.effective_date} → {exp.expiration_date}, {money(exp.premium)} on rates {exp.rate_version})
        {" · "}<RowLink href={`/submissions/${id}/workbench`}>Adjust &amp; re-rate on the workbench →</RowLink>
        {" · "}<RowLink href={`/audit?submission=${id}`}>case history</RowLink>
      </p>

      {msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {!ws.last_rating && <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">The renewing terms haven&apos;t been rated yet. Rate them to see the comparison.</p>}
      {ws.last_rating && !rated && (
        <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {staleRates ? `Rates changed since this rating (${staleRates.from} → ${staleRates.to}).` : "Inputs changed since this rating."} Re-rate to refresh the comparison.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {comparison && b && (
            <Section title="Rate comparison">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr><th className="px-4 py-2 font-medium" /><th className="px-4 py-2 text-right font-medium">Expiring</th><th className="px-4 py-2 text-right font-medium">Renewing</th><th className="px-4 py-2 text-right font-medium">Change</th></tr>
                </thead>
                <tbody>
                  {comparison.money.map((r) => (
                    <tr key={r.label} className={`border-t border-slate-100 ${r.label === "Total" ? "font-semibold" : ""}`}>
                      <td className="px-4 py-1.5">{r.label}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{money(r.expiring)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{money(r.renewing)}</td>
                      <td className={`px-4 py-1.5 text-right tabular-nums ${r.change > 0 ? "text-rose-700" : r.change < 0 ? "text-emerald-700" : "text-slate-400"}`}>{signed(r.change)} {r.pct !== null && <span className="text-xs">({pctText(r.pct)})</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-slate-100 p-4 text-sm">
                <p className="font-medium">Premium {changeSummary(b)}</p>
                {b.termsImpact !== null && b.ratesImpact !== null ? (
                  <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                    <dt className="text-slate-500">Expiring premium (rates {b.rateVersionFrom})</dt><dd className="text-right tabular-nums">{money(b.expiringPremium)}</dd>
                    <dt className="text-slate-500">Changes to terms, exposure and schedule</dt><dd className="text-right tabular-nums">{signed(b.termsImpact)}</dd>
                    <dt className="text-slate-500">Changes to rates ({b.rateVersionFrom} → {b.rateVersionTo})</dt><dd className="text-right tabular-nums">{signed(b.ratesImpact)}</dd>
                    <dt className="font-medium">Renewing premium (rates {b.rateVersionTo})</dt><dd className="text-right font-semibold tabular-nums">{money(b.renewingPremium)}</dd>
                  </dl>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">Rate version {b.rateVersionFrom} couldn&apos;t be rated on, so the change can&apos;t be split between terms and rates.</p>
                )}
              </div>
            </Section>
          )}

          <Section title="Terms · expiring vs renewing">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2 font-medium">Variable</th><th className="px-4 py-2 text-right font-medium">Expiring</th><th className="px-4 py-2 text-right font-medium">Renewing</th></tr>
              </thead>
              <tbody>
                {(comparison?.terms ?? []).map((t) => (
                  <tr key={t.key} className={`border-t border-slate-100 ${t.changed && t.key !== "period" ? "bg-amber-50/60" : ""}`}>
                    <td className="px-4 py-1.5 text-slate-700">{t.label}{t.changed && t.key !== "period" && <span className="ml-2 rounded bg-amber-100 px-1 text-[10px] text-amber-800">changed</span>}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-slate-500">{t.expiring}</td>
                    <td className={`px-4 py-1.5 text-right tabular-nums ${t.changed ? "font-medium" : ""}`}>{t.renewing}</td>
                  </tr>
                ))}
                {!comparison && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">Rate the renewing terms to compare them.</td></tr>}
              </tbody>
            </table>
          </Section>

          {comparison && (
            <Section title={`Rating factors · ${exp.rate_version} vs ${ws.last_rating!.rate_version}`}>
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr><th className="px-4 py-2 font-medium">Step</th><th className="px-4 py-2 font-medium">Expiring</th><th className="px-4 py-2 font-medium">Renewing</th><th className="px-4 py-2 font-medium">Moved by</th></tr>
                </thead>
                <tbody>
                  {comparison.factors.map((f) => (
                    <tr key={f.step} className={`border-t border-slate-100 align-top ${f.changed ? "bg-amber-50/60" : ""}`}>
                      <td className="px-4 py-1.5 font-medium">{f.step}</td>
                      {[f.expiring, f.renewing].map((l, i) => (
                        <td key={i} className="px-4 py-1.5">
                          {l ? (
                            <>
                              <span className="text-slate-600">{l.detail}</span>
                              <span className="ml-2 whitespace-nowrap tabular-nums">{l.factor !== null ? `× ${l.factor}` : ""} → {money(l.premium)}</span>
                            </>
                          ) : <span className="text-slate-400">—</span>}
                        </td>
                      ))}
                      <td className="px-4 py-1.5">{f.cause && <span className={`rounded px-1.5 py-0.5 ${CAUSE[f.cause].style}`}>{CAUSE[f.cause].label}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
        </div>

        <aside className="space-y-6">
          <Section title="Rate">
            <div className="space-y-3 p-4 text-sm">
              <form action={reRateAction.bind(null, id)}>
                <button className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Re-rate</button>
                <p className="mt-1 text-xs text-slate-500">Rates the renewing terms as saved on current rates, then returns to the rating page.</p>
              </form>
              <Link href={`/submissions/${id}/workbench`} className="block rounded-md border border-slate-300 px-4 py-2 text-center text-sm hover:bg-slate-50">Adjust terms on the workbench →</Link>
            </div>
          </Section>

          <Section title={policy ? "Renewed" : "Renewal quote"}>
            <div className="space-y-4 p-4 text-sm">
              {policy && (
                <p className="rounded bg-emerald-50 px-3 py-2 text-emerald-800">
                  Bound as <RowLink href={`/policies/${policy.id}`}>{policy.policy_number}</RowLink> · {money(policy.total)} · by {policy.bound_by}
                </p>
              )}
              {quotes.length > 0 && (
                <ul className="space-y-1">
                  {quotes.map((q) => (
                    <Fragment key={q.id}>
                      <li className={`flex items-center gap-2 ${q.status === "superseded" ? "text-slate-400" : ""}`}>
                        <Link href={`/quotes/${q.id}`} className="font-mono text-xs hover:underline">{q.quote_number} v{q.version}</Link>
                        <Pill status={q.status} />
                        <span className="ml-auto tabular-nums">{money(q.total)}</span>
                      </li>
                      <li className="flex gap-3 pl-1 text-xs">
                        <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-indigo-600 hover:underline">Quote PDF</a>
                        {q.has_memo && <a href={`/quotes/${q.id}/memo`} target="_blank" className="text-indigo-600 hover:underline">Renewal memo PDF</a>}
                        <span className="text-slate-400">issued {when(q.issued_at)}</span>
                      </li>
                    </Fragment>
                  ))}
                </ul>
              )}
              {!policy && (ready ? (
                <IssueQuoteForm action={issueRenewalQuoteAction.bind(null, id)} effective={effective} expiration={expiration} subjectivities={subjectivities}
                  label={latest ? `Issue revised renewal quote (v${latest.version + 1})` : `Issue renewal quote · ${money(ws.last_rating!.total)}`} />
              ) : (
                <p className="text-slate-500">
                  {!rated ? "Rate the renewing terms to quote." : `Clear ${openReferrals.length} open referral${openReferrals.length === 1 ? "" : "s"} on the workbench to quote.`}
                </p>
              ))}
              {latest && !policy && <p className="text-xs text-slate-500">Bind from the <RowLink href={`/submissions/${id}/workbench`}>workbench</RowLink> once the broker confirms.</p>}
            </div>
          </Section>

          <Section title="Expiring policy">
            <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
              <dt className="text-slate-500">Policy</dt><dd className="text-right"><RowLink href={expiringHref}>{exp.policy_number}</RowLink></dd>
              <dt className="text-slate-500">Source</dt><dd className="text-right">{exp.source === "book" ? "prior system" : "UW Desktop"}</dd>
              <dt className="text-slate-500">Producer</dt><dd className="text-right">{exp.producer[0]}</dd>
              <dt className="text-slate-500">Losses (5 yr)</dt><dd className="text-right tabular-nums">{exp.losses.claims} claims · {money(exp.losses.incurred)}{exp.losses.open_claims ? ` · ${exp.losses.open_claims} open` : ""}</dd>
            </dl>
          </Section>
        </aside>
      </div>
    </main>
  );
}
