import Link from "next/link";
import { notFound } from "next/navigation";
import { auditTrail } from "@/lib/audit";
import { addYears, suggestedSubjectivities } from "@/lib/quote-terms";
import { bindBlockers } from "@/lib/bind-rules";
import { clearanceStatus } from "@/lib/referrals";
import { policiesForSubmission } from "@/lib/policies";
import { quotesForSubmission } from "@/lib/quotes";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import {
  INPUT_DEFS, MAX_CATEGORY_PCT, SCHEDULE_CATEGORIES, UW_AUTHORITY_PCT, scheduleMod, scheduleTotal, type RatingInputs,
} from "@/lib/worksheet";
import { activeRateVersion, money, openWorksheet, readiness } from "@/lib/worksheets";
import { inputText } from "@/lib/renewal-compare";
import { expiringOf } from "@/lib/renewals";
import { IssueQuoteForm } from "../issue-quote-form";
import { StatusBadge } from "../../status-badge";
import { bindAction, clearReferralAction, issueQuoteAction, saveAndRateAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> };

const WORKSHEET_ACTIONS = new Set(["renewal.started", "worksheet.opened", "worksheet.input_changed", "worksheet.schedule_changed", "worksheet.rated", "referral.cleared", "quote.issued", "policy.bound"]);

export default async function WorkbenchPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { msg, error } = await searchParams;
  const sub = await getSubmission(id);
  if (!sub) notFound();
  if (sub.status !== "accepted") {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="rounded bg-amber-50 px-4 py-3 text-amber-800">
          {sub.reference} is still in intake review. <Link href={`/submissions/${id}`} className="underline">Review and accept it</Link> first.
        </p>
      </main>
    );
  }
  const ws = await openWorksheet(sub, await currentUser());
  const { flags, openReferrals, rated, ready, staleRates } = readiness(sub, ws, await activeRateVersion());
  const history = (await auditTrail("submission", id)).filter((h) => WORKSHEET_ACTIONS.has(h.action));
  const quotes = await quotesForSubmission(id);
  const latest = quotes[0];
  const effective = latest?.effective_date ?? String(sub.data.policy?.effective_date ?? "");
  const expiration = latest?.expiration_date ?? (effective ? addYears(effective, 1) : "");
  const subjectivities = latest?.subjectivities ?? (sub.kind === "renewal"
    ? ["Signed renewal application or no-change confirmation", ...suggestedSubjectivities(flags, sub.data).slice(1)]
    : suggestedSubjectivities(flags, sub.data));
  const [policy] = await policiesForSubmission(id);
  const bindIssues = latest ? bindBlockers(latest, new Date().toISOString().slice(0, 10)) : [];
  const rating = ws.last_rating;
  const schedule = new Map(ws.schedule.map((s) => [s.category, s]));
  const total = scheduleTotal(ws.schedule);

  const exp = expiringOf(sub);
  const issueForm = (
    <IssueQuoteForm action={issueQuoteAction.bind(null, id)} effective={effective} expiration={expiration} subjectivities={subjectivities}
      label={latest ? `Issue revised quote (v${latest.version + 1})` : `Issue ${exp ? "renewal " : ""}quote · ${rating ? money(rating.total) : ""}`} />
  );

  return (
    <main className="mx-auto max-w-7xl p-8">
      <Link href={`/submissions/${id}`} className="text-sm text-indigo-600 hover:underline">← Intake</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{sub.applicant_name}</h1>
        <span className="font-mono text-sm text-slate-500">{sub.reference}</span>
        <StatusBadge status={sub.status} />
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${policy || ready ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>
          {policy ? `Bound · ${policy.policy_number}` : ready ? (latest ? `Quoted · ${latest.quote_number} v${latest.version}` : "Ready to quote") : !rated ? "Not rated" : `${openReferrals.length} referral${openReferrals.length === 1 ? "" : "s"} open`}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Underwriting workbench · {String(sub.data.operations?.description ?? "")} ·{" "}
        <Link href={`/audit?submission=${id}`} className="text-indigo-600 hover:underline">Case history →</Link>
      </p>

      {exp && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span className="font-medium">Renewal of {exp.policy_number}</span>
          <span>expiring {money(exp.premium)} on rates {exp.rate_version} · {exp.effective_date} → {exp.expiration_date}</span>
          <span className="text-xs">Expiring values are shown under each input.</span>
          <Link href={`/submissions/${id}/renewal`} className="ml-auto font-medium hover:underline">Expiring vs renewing →</Link>
        </p>
      )}
      {msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <form action={saveAndRateAction.bind(null, id)} className="space-y-6">
          <Card title="Rating inputs">
            <div className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
              {INPUT_DEFS.map((d) => (
                <label key={d.key} className="flex flex-col gap-1 text-xs text-slate-500">
                  {d.label}
                  {d.kind === "bool" ? (
                    <select name={d.key} defaultValue={ws.rating_inputs[d.key] ? "yes" : "no"} className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
                      <option value="yes">yes</option><option value="no">no</option>
                    </select>
                  ) : (
                    <input name={d.key} defaultValue={inputValue(ws.rating_inputs, d.key)}
                      className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900" />
                  )}
                  {exp && (() => {
                    const was = inputText(d.key, exp.rating_inputs[d.key]);
                    const changed = was !== inputText(d.key, ws.rating_inputs[d.key]);
                    return <span className={`text-[11px] ${changed ? "font-medium text-amber-700" : "text-slate-400"}`}>expiring: {was}</span>;
                  })()}
                </label>
              ))}
            </div>
          </Card>

          <Card title={`Schedule rating · total ${total > 0 ? "+" : ""}${total}% · mod ${scheduleMod(ws.schedule).toFixed(2)}`}>
            <p className="px-4 pt-3 text-xs text-slate-500">
              Credits are negative, debits positive, up to ±{MAX_CATEGORY_PCT}% per category. Every credit or debit needs a written reason.
              Totals beyond ±{UW_AUTHORITY_PCT}% need a referral.
            </p>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2 font-medium">Category</th><th className="px-2 py-2 font-medium">%</th><th className="px-4 py-2 font-medium">Reason</th></tr>
              </thead>
              <tbody>
                {SCHEDULE_CATEGORIES.map((c) => {
                  const item = schedule.get(c.key);
                  return (
                    <tr key={c.key} className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-700">{c.label}</td>
                      <td className="px-2 py-2">
                        <input name={`schedule.${c.key}.pct`} defaultValue={item?.pct ?? 0} inputMode="numeric"
                          className={`w-16 rounded border px-2 py-1 text-right tabular-nums ${item ? (item.pct < 0 ? "border-emerald-400 bg-emerald-50" : "border-rose-300 bg-rose-50") : "border-slate-300"}`} />
                      </td>
                      <td className="px-4 py-2">
                        <input name={`schedule.${c.key}.rationale`} defaultValue={item?.rationale ?? ""}
                          placeholder="Why this credit or debit is justified" className="w-full rounded border border-slate-300 px-2 py-1" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <div className="sticky bottom-4 flex justify-end">
            <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-500">Save &amp; rate</button>
          </div>
        </form>

        <aside className="space-y-6">
          <Card title={policy ? "Policy" : "Quote"}>
            <div className="space-y-4 p-4">
              {policy && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
                  <p className="font-medium text-emerald-800">Bound · <Link href={`/policies/${policy.id}`} className="hover:underline">{policy.policy_number}</Link></p>
                  <p className="mt-0.5 text-xs text-emerald-700">
                    Binder {policy.binder_number} · {policy.quote_number} v{policy.quote_version} · {money(policy.total)} · by {policy.bound_by}
                  </p>
                  <p className="mt-2 flex gap-3 text-xs">
                    <a href={`/policies/${policy.id}/binder`} target="_blank" className="text-indigo-600 hover:underline">Binder PDF</a>
                    <a href={`/policies/${policy.id}/policy`} target="_blank" className="text-indigo-600 hover:underline">Policy PDF</a>
                  </p>
                  {policy.subjectivities.some((s) => s.status === "open") && (
                    <ul className="mt-2 space-y-0.5 text-xs text-amber-800">
                      {policy.subjectivities.filter((s) => s.status === "open").map((s) => <li key={s.text}>Open: {s.text} (due {s.due_date})</li>)}
                    </ul>
                  )}
                </div>
              )}
              {quotes.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {quotes.map((q) => (
                    <li key={q.id} className={`flex items-center gap-2 ${q.status === "superseded" ? "text-slate-400" : ""}`}>
                      <Link href={`/quotes/${q.id}`} className="font-mono text-xs hover:underline">{q.quote_number} v{q.version}</Link>
                      <span className="text-xs">{q.status}</span>
                      <span className="ml-auto tabular-nums">{money(q.total)}</span>
                      <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-xs text-indigo-600 hover:underline">PDF</a>
                    </li>
                  ))}
                </ul>
              )}
              {!policy && latest?.status === "issued" && (
                bindIssues.length ? (
                  <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{bindIssues.join("; ")}</p>
                ) : (
                  <form action={bindAction.bind(null, id, latest.id)} className="space-y-2 rounded-md border border-slate-200 p-3">
                    <p className="text-sm font-medium">Bind {latest.quote_number} v{latest.version}</p>
                    <p className="text-xs text-slate-500">Tick subjectivities already received. The rest stay open on the binder, due in 30 days.</p>
                    {latest.subjectivities.map((text, i) => (
                      <label key={i} className="flex items-start gap-2 text-xs">
                        <input type="checkbox" name="received" value={i} className="mt-0.5" /> {text}
                      </label>
                    ))}
                    <button className="w-full rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600">
                      Bind · {money(latest.total)}
                    </button>
                  </form>
                )
              )}
              {!policy && (ready ? (
                latest ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-indigo-600">Revise quote (v{latest.version + 1})</summary>
                    <div className="mt-3">{issueForm}</div>
                  </details>
                ) : issueForm
              ) : (
                <p className="text-sm text-slate-500">
                  {!rated ? "Save & rate the current inputs to quote." : `Clear ${openReferrals.length} open referral${openReferrals.length === 1 ? "" : "s"} to quote.`}
                </p>
              ))}
            </div>
          </Card>

          <Card title="Indicative premium">
            {rating ? (
              <div className="p-4">
                {!rated && (
                  <p className="mb-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    {staleRates ? `Rates changed since this rating (${staleRates.from} → ${staleRates.to}).` : "Inputs changed since this rating."} Save &amp; rate again.
                  </p>
                )}
                <p className="text-3xl font-semibold tabular-nums">{money(rating.total)}</p>
                <p className="text-xs text-slate-500">total cost to insured · rates {rating.rate_version}</p>
                <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-slate-500">Premium</dt><dd className="text-right tabular-nums">{money(rating.premium)}</dd>
                  <dt className="text-slate-500">Policy fee</dt><dd className="text-right tabular-nums">{money(rating.policy_fee)}</dd>
                  <dt className="text-slate-500">SL tax ({(Number(rating.surplus_lines_tax_rate) * 100).toFixed(2)}%)</dt>
                  <dd className="text-right tabular-nums">{money(rating.surplus_lines_tax)}</dd>
                </dl>
                <table className="mt-4 w-full text-xs">
                  <tbody>
                    {rating.worksheet.map((w, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1.5 pr-2"><span className="font-medium">{w.step}</span><br /><span className="text-slate-500">{w.detail}</span></td>
                        <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums text-slate-500">{w.factor ? `× ${Number(w.factor)}` : ""}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(w.premium)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p-4 text-sm text-slate-500">Not rated yet. Check the inputs and click Save &amp; rate.</p>
            )}
          </Card>

          <Card title={`Referrals · ${flags.filter((f) => f.severity === "refer").length} refer, ${flags.filter((f) => f.severity === "warn").length} warn`}>
            <ul className="divide-y divide-slate-100">
              {flags.map((f) => {
                const clearance = ws.referral_clearances[f.code];
                const status = clearanceStatus(f, clearance);
                return (
                  <li key={f.code} className="p-4 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${status === "cleared" ? "bg-slate-100 text-slate-500" : f.severity === "refer" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>
                        {status === "cleared" ? "cleared" : f.severity}
                      </span>
                      <span className="font-medium">{f.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{f.detail}</p>
                    {status === "cleared" && clearance && (
                      <p className="mt-2 text-xs text-slate-500">
                        <span className="font-medium text-slate-700">{clearance.by}</span>: “{clearance.note}”
                      </p>
                    )}
                    {status === "stale" && clearance && (
                      <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                        {clearance.by} cleared this for {clearance.detail ? `“${clearance.detail}”` : "earlier facts"}; the facts changed, so it needs clearing again.
                      </p>
                    )}
                    {status !== "cleared" && f.severity === "refer" && (
                      <form action={clearReferralAction.bind(null, id, f.code)} className="mt-2 flex gap-2">
                        <input name="note" required minLength={10} placeholder="Why this is acceptable (authority, mitigation)"
                          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
                        <button className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Clear</button>
                      </form>
                    )}
                  </li>
                );
              })}
              {!flags.length && <li className="p-4 text-sm text-emerald-700">No referral rules triggered.</li>}
            </ul>
          </Card>

          <Card title="Worksheet history">
            <ul className="space-y-2 p-4 text-xs">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="text-slate-400">{h.occurred_at.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>{" "}
                  <span className="font-medium">{h.actor}</span>: {h.summary}
                  {h.action === "worksheet.input_changed" && (
                    <span className="text-slate-500"> ({JSON.stringify(Object.values(h.before as object)[0])} → {JSON.stringify(Object.values(h.after as object)[0])})</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </main>
  );
}

function inputValue(inputs: RatingInputs, key: keyof RatingInputs): string {
  const v = inputs[key];
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}
