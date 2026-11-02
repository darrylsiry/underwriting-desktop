import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Empty, Pill, RowLink, Section, money, when, whenDate } from "@/components/ui";
import { LOSS_RATIO_BASIS, lossRatio } from "@/lib/book-metrics";
import { RENEWAL_WINDOW_DAYS, daysUntil } from "@/lib/dashboard";
import { inputText } from "@/lib/renewal-compare";
import { getBookPolicy, renewalOfPolicy } from "@/lib/renewals";
import { todayIso } from "@/lib/time";
import { INPUT_DEFS, SCHEDULE_CATEGORIES } from "@/lib/worksheet";
import { startRenewalAction } from "../../actions";
import { StartRenewalForm } from "../../start-renewal-form";

export const dynamic = "force-dynamic";

const load = cache(getBookPolicy);   // once per request, shared by the title and the page

// UX-010
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await load((await params).id);
  return { title: p ? `${p.policy_number} · Policy` : "Policy" };
}

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

/** A policy written in the prior policy system: what we know about it, and its renewal. */
export default async function BookPolicyPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error } = await searchParams;
  const p = await load(id);
  if (!p) notFound();
  const daysLeft = daysUntil(p.expiration_date, todayIso());   // UX-023
  const renewal = await renewalOfPolicy(p.renewal_submission_id);
  const inputs = p.rating_inputs;
  const ratio = lossRatio(Number(p.incurred), Number(p.premium));
  const categoryLabel = (key: string) => SCHEDULE_CATEGORIES.find((c) => c.key === key)?.label ?? key;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <RowLink href="/#renewals">← Upcoming renewals</RowLink>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{p.policy_number}</h1>
        <Pill status="prior system" />
        <Pill status={p.renewal_status} />
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {p.insured_name} · {p.class_code} {p.class_description} · {p.producer} · underwriter {p.underwriter}
      </p>
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Section title="Current policy">
          <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
            <dt className="text-slate-500">Policy period</dt><dd className="text-right">{whenDate(p.effective_date)} → {whenDate(p.expiration_date)}</dd>
            <dt className="text-slate-500">Expiring premium</dt><dd className="text-right font-semibold tabular-nums">{money(p.premium)}</dd>
            <dt className="text-slate-500">Rated on</dt><dd className="text-right">rate revision {p.rate_version ?? "—"}</dd>
            {inputs && (
              <>
                <dt className="text-slate-500">Each occurrence / aggregate</dt><dd className="text-right tabular-nums">{money(inputs.occurrence_limit)} / {money(inputs.aggregate_limit)}</dd>
                <dt className="text-slate-500">Deductible</dt><dd className="text-right tabular-nums">{inputs.deductible ? money(inputs.deductible) : "None"}</dd>
                <dt className="text-slate-500">Gross receipts</dt><dd className="text-right tabular-nums">{money(inputs.gross_receipts)}</dd>
                <dt className="text-slate-500">States</dt><dd className="text-right">{inputs.states.join(", ")} (home {inputs.home_state})</dd>
              </>
            )}
          </dl>
        </Section>
        <Section title="Loss history · 5 years">
          <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
            <dt className="text-slate-500">Claims</dt><dd className="text-right tabular-nums">{p.claims}</dd>
            <dt className="text-slate-500">Incurred</dt><dd className="text-right tabular-nums">{money(p.incurred)}</dd>
            <dt className="text-slate-500">Open claims</dt><dd className="text-right tabular-nums">{p.open_claims}</dd>
            <dt className="text-slate-500">Loss ratio ({LOSS_RATIO_BASIS})</dt><dd className="text-right tabular-nums">{ratio === null ? "—" : `${Math.round(ratio * 100)}%`}</dd>
          </dl>
        </Section>
        <Section title="Rating basis (expiring)">
          {inputs ? (
            <div className="grid gap-x-6 gap-y-1 p-4 text-sm sm:grid-cols-2">
              {INPUT_DEFS.map((d) => <p key={d.key}><span className="text-slate-500">{d.label}:</span> {inputText(d.key, inputs[d.key])}</p>)}
              <p className="sm:col-span-2"><span className="text-slate-500">Schedule:</span>{" "}
                {p.schedule.length ? p.schedule.map((s) => `${s.pct > 0 ? "+" : ""}${s.pct}% ${categoryLabel(s.category).toLowerCase()} (${s.rationale})`).join("; ") : "none"}</p>
            </div>
          ) : <Empty>No rating inputs on file for this policy.</Empty>}
        </Section>
        {/* UX-023: when it expires, whether a renewal is due yet, and a confirm before one is created. */}
        <Section title={`Renewal · ${p.renewal_status.replace("_", " ")}`}>
          <div className="p-4 text-sm">
            {!renewal ? (
              <StartRenewalForm action={startRenewalAction.bind(null, "book", p.id)} policyNumber={p.policy_number} inWindow={daysLeft <= RENEWAL_WINDOW_DAYS}>
                <p className="font-medium">Expires {whenDate(p.expiration_date)} · {daysLeft < 0 ? `expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago` : `${daysLeft} day${daysLeft === 1 ? "" : "s"}`}</p>
                <p className="mt-1 text-slate-600">
                  {daysLeft > RENEWAL_WINDOW_DAYS && <>Renewals usually start within {RENEWAL_WINDOW_DAYS} days of expiry. </>}
                  Starts a renewal from these terms: the expiring premium is reproduced on rate revision {p.rate_version}, and the
                  renewing terms are rated on current rates so the two can be compared.
                </p>
              </StartRenewalForm>
            ) : (
              <>
                <p>
                  <RowLink href={`/submissions/${renewal.submission.id}/renewal`}>Expiring vs renewing →</RowLink>{" · "}
                  <RowLink href={`/submissions/${renewal.submission.id}/workbench`}>workbench</RowLink>{" · "}
                  <span className="font-mono text-xs">{renewal.submission.reference}</span>, started by {renewal.submission.received_by} {when(renewal.submission.received_at)}
                </p>
                {renewal.quotes.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {renewal.quotes.map((q) => (
                      <li key={q.id} className={`flex items-center gap-2 ${q.status === "superseded" ? "text-slate-500" : ""}`}>
                        <Link href={`/quotes/${q.id}`} className="font-mono text-xs text-indigo-600 hover:underline">{q.quote_number} v{q.version}</Link>{/* UX-013 */}
                        <Pill status={q.status} />
                        <span className="ml-auto tabular-nums">{money(q.total)}</span>
                        <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-xs text-indigo-600 hover:underline">Quote PDF</a>
                        {q.has_memo && <a href={`/quotes/${q.id}/memo`} target="_blank" className="text-xs text-indigo-600 hover:underline">Memo</a>}
                      </li>
                    ))}
                  </ul>
                )}
                {renewal.policy && (
                  <p className="mt-3 rounded bg-emerald-50 px-3 py-2 text-emerald-800">
                    Renewed as <RowLink href={`/policies/${renewal.policy.id}`}>{renewal.policy.policy_number}</RowLink>, {whenDate(renewal.policy.effective_date)} → {whenDate(renewal.policy.expiration_date)}, {money(renewal.policy.total)}
                  </p>
                )}
              </>
            )}
          </div>
        </Section>
      </div>
      <p className="mt-6 text-xs text-slate-500">Imported from the prior policy system; its documents aren&apos;t held here. Documents for the renewal appear above once issued.</p>
    </main>
  );
}
