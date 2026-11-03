import { Flash } from "@/components/flash";
import type { Metadata } from "next";
import Link from "next/link";
import { inputText } from "@/lib/renewal-compare";
import { notFound } from "next/navigation";
import { Fragment, cache } from "react";
import { Pill, RowLink, Section, money, when, whenDate } from "@/components/ui";
import { factorText } from "@/lib/format";
import { ProducerCard } from "@/components/producer-card";
import { ReasonForm } from "@/components/reason-form";
import { quoteState } from "@/lib/bind-rules";
import { NOT_TAKEN_REASONS, closureText } from "@/lib/file-closure";
import { producerOf } from "@/lib/quote-terms";
import { todayIso } from "@/lib/time";
import { closeQuoteAction } from "./actions";
import { policiesForSubmission } from "@/lib/policies";
import { getQuote, quoteVersions } from "@/lib/quotes";
import { changeSummary } from "@/lib/renewal-compare";
import { INPUT_DEFS, SCHEDULE_CATEGORIES, scheduleMod } from "@/lib/worksheet";

export const dynamic = "force-dynamic";

const CATEGORY = new Map<string, string>(SCHEDULE_CATEGORIES.map((c) => [c.key, c.label]));
const load = cache(getQuote);   // once per request, shared by the title and the page

// UX-010
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const q = await load((await params).id);
  return { title: q ? `${q.quote_number} v${q.version} · Quote` : "Quote" };
}

export default async function QuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const { id } = await params;
  const { msg, error } = await searchParams;
  const q = await load(id);
  if (!q) notFound();
  const [versions, policies] = await Promise.all([quoteVersions(q.quote_number), policiesForSubmission(q.submission_id)]);
  const policy = policies.find((p) => p.quote_id === q.id);
  const live = versions.find((v) => v.status !== "superseded");   // UX-043: the version that is actually out
  const r = q.rating;
  const state = quoteState(q, todayIso());   // UX-054

  return (
    <main className="mx-auto max-w-6xl p-8">
      <RowLink href="/quotes">← Quotes</RowLink>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{q.quote_number} v{q.version}</h1>
        <Pill status={state} />
        <a href={`/quotes/${q.id}/pdf`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Quote PDF</a>
        {q.has_memo && <a href={`/quotes/${q.id}/memo`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Renewal memo</a>}
        {/* UX-043: the page the "Chase bind order" task opens carries the next step; a superseded version points at the live one. */}
        {state === "expired" && !policy && (
          <Link href={`/submissions/${q.submission_id}/workbench`} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100">Expired {whenDate(q.valid_until)} · Revise on the workbench →</Link>
        )}
        {state === "issued" && !policy && (
          <Link href={`/submissions/${q.submission_id}/workbench`} className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600">Bind on the workbench →</Link>
        )}
        {q.status === "superseded" && live && live.id !== q.id && (
          <RowLink href={`/quotes/${live.id}`}>Superseded by v{live.version} ({live.status}) →</RowLink>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {q.insured_id ? <RowLink href={`/insureds/${q.insured_id}`}>{q.insured_name}</RowLink> : q.insured_name}
        {" · "}<RowLink href={`/submissions/${q.submission_id}/workbench`}>{q.submission_ref}</RowLink>
        {" · "}issued by {q.issued_by} {when(q.issued_at)} · valid until {whenDate(q.valid_until)}
        {policy && <> · bound as <RowLink href={`/policies/${policy.id}`}>{policy.policy_number}</RowLink></>}
        {" · "}<RowLink href={`/audit?submission=${q.submission_id}`}>case history</RowLink>
        {q.renewal_summary && <> · renewal: premium {changeSummary(q.renewal_summary.bridge)} vs expiring (<RowLink href={`/submissions/${q.submission_id}/renewal`}>comparison</RowLink>)</>}
      </p>

      <Flash msg={msg} error={error} />
      {q.closed && <p className="mt-4 rounded border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-800">{closureText("Closed as not taken", q.closed)}. A new version can still be issued from the <RowLink href={`/submissions/${q.submission_id}/workbench`}>workbench</RowLink>.</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Section title="Terms">
            <dl className="grid grid-cols-[200px_1fr] gap-y-1.5 p-4 text-sm">
              <dt className="text-slate-500">Policy period</dt><dd>{whenDate(q.effective_date)} to {whenDate(q.expiration_date)}</dd>
              {q.terms.limits.map((l) => <Fragment key={l.label}><dt className="text-slate-500">{l.label}</dt><dd className="tabular-nums">{money(l.amount)}</dd></Fragment>)}
              <dt className="text-slate-500">Deductible</dt><dd className="tabular-nums">{q.terms.deductible ? money(q.terms.deductible) : "None"}</dd>
              <dt className="text-slate-500">Class</dt><dd>{q.terms.class_code} {q.terms.class_description}</dd>
              <dt className="text-slate-500">Gross receipts</dt><dd className="tabular-nums">{money(q.rating_inputs.gross_receipts)}</dd>
              <dt className="text-slate-500">States</dt><dd>{q.rating_inputs.states.join(", ")} (home {q.rating_inputs.home_state})</dd>
              <dt className="text-slate-500">Forms</dt><dd><ul className="list-disc pl-4">{q.terms.forms.map((f) => <li key={f}>{f}</li>)}</ul></dd>
            </dl>
          </Section>

          <Section title="Rating worksheet">
            <table className="w-full text-sm">
              {/* UX-013 */}
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th scope="col" className="px-4 py-2 font-medium">Step</th><th scope="col" className="px-4 py-2 text-right font-medium">Factor</th><th scope="col" className="px-4 py-2 text-right font-medium">Premium</th></tr>
              </thead>
              <tbody>
              {r.worksheet.map((w, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-4 py-1.5"><span className="font-medium">{w.step}</span> <span className="text-xs text-slate-500">{w.detail}</span></td>
                  <td className="whitespace-nowrap px-4 py-1.5 text-right text-xs text-slate-500">{w.factor ? `× ${factorText(w.factor)}` : ""}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{money(w.premium)}</td>
                </tr>
              ))}
            </tbody></table>
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              Rate version {q.rate_version} · rating <code>{q.rating_id}</code> in the rating service log
            </p>
          </Section>

          <Section title="Underwriting basis (internal)">
            <div className="grid gap-x-6 gap-y-1 p-4 text-sm sm:grid-cols-2">
              {INPUT_DEFS.map((d) => {
                const v = q.rating_inputs[d.key];
                const shown = inputText(d.key, v);   // UX-030: the same text the workbench and renewal table show
                return <p key={d.key}><span className="text-slate-500">{d.label}:</span> {shown}</p>;
              })}
            </div>
            <div className="border-t border-slate-100 p-4 text-sm">
              <p className="font-medium">Schedule mod {scheduleMod(q.schedule).toFixed(2)}</p>
              {q.schedule.length ? (
                <ul className="mt-1 space-y-1">
                  {q.schedule.map((s) => (
                    <li key={s.category}><span className={s.pct < 0 ? "text-emerald-700" : "text-rose-700"}>{s.pct > 0 ? "+" : ""}{s.pct}%</span> {CATEGORY.get(s.category) ?? s.category}: <span className="text-slate-600">{s.rationale}</span></li>
                  ))}
                </ul>
              ) : <p className="text-slate-500">No credits or debits.</p>}
            </div>
          </Section>
        </div>

        <aside className="space-y-6">
          <ProducerCard producer={producerOf(q.terms)} subject={`${q.quote_number} v${q.version}`} />
          <Section title="Premium">
            <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
              <dt className="text-slate-500">Premium</dt><dd className="text-right tabular-nums">{money(q.premium)}</dd>
              <dt className="text-slate-500">Policy fee</dt><dd className="text-right tabular-nums">{money(q.policy_fee)}</dd>
              <dt className="text-slate-500">Surplus lines tax ({(Number(r.surplus_lines_tax_rate) * 100).toFixed(2)}%)</dt><dd className="text-right tabular-nums">{money(q.surplus_lines_tax)}</dd>
              <dt className="font-medium">Total</dt><dd className="text-right font-semibold tabular-nums">{money(q.total)}</dd>
            </dl>
          </Section>
          <Section title="Subjectivities">
            <ol className="list-decimal space-y-1 p-4 pl-8 text-sm">{q.subjectivities.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </Section>
          <Section title="Versions">
            <ul className="p-4 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2 py-0.5">
                  {v.id === q.id ? <span className="font-mono text-xs font-semibold">v{v.version}</span> : <RowLink href={`/quotes/${v.id}`}><span className="font-mono text-xs">v{v.version}</span></RowLink>}
                  <Pill status={quoteState(v, todayIso())} />
                  <span className="ml-auto tabular-nums">{money(v.total)}</span>
                </li>
              ))}
            </ul>
            {q.status === "issued" && !policy && (
              <div className="border-t border-slate-100 px-4 py-3">
                <ReasonForm action={closeQuoteAction.bind(null, q.id)} summary="Close as not taken…" reasons={NOT_TAKEN_REASONS} submitLabel="Close quote" pending="Closing…"
                  confirmText={`Close ${q.quote_number} v${q.version} as not taken? It leaves Quotes out and your desk, and counts as lost.`} />
              </div>
            )}
          </Section>
        </aside>
      </div>
    </main>
  );
}
