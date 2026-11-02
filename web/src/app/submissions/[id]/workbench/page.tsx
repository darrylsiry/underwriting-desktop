import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { Pill, when, whenDate } from "@/components/ui";
import { auditTrail } from "@/lib/audit";
import { recordedApart } from "@/lib/timeline-merge";
import { addYears, suggestedSubjectivities } from "@/lib/quote-terms";
import { bindBlockers } from "@/lib/bind-rules";
import { clearanceStatus } from "@/lib/referrals";
import { policiesForSubmission } from "@/lib/policies";
import { getQuote, quotesForSubmission } from "@/lib/quotes";
import { getSubmission } from "@/lib/submissions";
import { todayIso } from "@/lib/time";
import { currentUser } from "@/lib/user";
import {
  INPUT_DEFS, MAX_CATEGORY_PCT, SCHEDULE_CATEGORIES, UW_AUTHORITY_PCT, inputChanges, inputUnit, inputsHash, scheduleMod, scheduleTotal,
  worksheetChips, worksheetFingerprint, type RatingInputs,
} from "@/lib/worksheet";
import { activeRateVersion, flagsFor, money, openWorksheet, readiness } from "@/lib/worksheets";
import { inputText } from "@/lib/renewal-compare";
import { expiringOf } from "@/lib/renewals";
import { ActionDirtyHint, ActionError, ActionForm, ActionFormProvider, ActionInput, ActionSelect, ActionSubmit, FieldMessage, WaitForSave } from "../action-form";
import { IssueQuoteForm } from "../issue-quote-form";
import { QuoteDriftNotice, StatusChips } from "../status-chips";
import { bindAction, clearReferralAction, issueQuoteAction, saveAndRateAction } from "./actions";
import { BindForm } from "./bind-form";
import { WorksheetInput } from "./worksheet-input";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> };

const WORKSHEET_ACTIONS = new Set(["renewal.started", "worksheet.opened", "worksheet.input_changed", "worksheet.schedule_changed", "worksheet.rated", "referral.cleared", "quote.issued", "policy.bound"]);
const WAIT = "Save & rate your changes first (or reload the page to discard them)."; // UX-032

// UX-010: the tab names the file.
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const sub = await getSubmission((await params).id);
  return { title: sub ? `${sub.reference} ${sub.applicant_name} · Workbench` : "Workbench" };
}

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
  const bindIssues = latest ? bindBlockers(latest, todayIso()) : [];
  // CR-100: a bound file shows what was bound, frozen on its quote; the worksheet may have moved on after that quote was issued.
  const boundQuote = policy ? await getQuote(policy.quote_id) : null;
  const rating = boundQuote?.rating ?? ws.last_rating;
  const shownInputs = boundQuote?.rating_inputs ?? ws.rating_inputs;
  const shownSchedule = boundQuote?.schedule ?? ws.schedule;
  const schedule = new Map(shownSchedule.map((s) => [s.category, s]));
  const total = scheduleTotal(shownSchedule);

  // UX-003: does the worksheet still say what the latest issued quote says? The quote froze its inputs and schedule.
  const quoted = latest && !policy ? await getQuote(latest.id) : null;
  const quoteCurrent = !!quoted && inputsHash(quoted.rating_inputs, quoted.schedule) === inputsHash(ws.rating_inputs, ws.schedule);
  const drift = quoted && !quoteCurrent
    ? inputChanges({ inputs: quoted.rating_inputs, schedule: quoted.schedule }, { inputs: ws.rating_inputs, schedule: ws.schedule })
        .map((c) => ({ label: c.label, from: changeText(c.key, c.from), to: changeText(c.key, c.to) }))
    : [];
  const differs = drift.length > 0;
  const chips = worksheetChips({
    policyNumber: policy?.policy_number, quote: latest ? { number: latest.quote_number, version: latest.version } : null, quoteCurrent,
    hasRating: !!rating, rated, ready, openReferrals: openReferrals.length,
  });

  const exp = expiringOf(sub);
  const issueForm = (
    <IssueQuoteForm action={issueQuoteAction.bind(null, id)} effective={effective} expiration={expiration} subjectivities={subjectivities} ratingId={ws.last_rating?.rating_id}
      label={latest ? `Issue revised ${exp ? "renewal " : ""}quote (v${latest.version + 1})` : `Issue ${exp ? "renewal " : ""}quote · ${rating ? money(rating.total) : ""}`} />
  );

  // CR-138: a bound file's panel judges the terms that were bound, like the inputs beside it, not a worksheet edited after the quote.
  const panelFlags = boundQuote ? flagsFor(sub, { ...ws, rating_inputs: boundQuote.rating_inputs, schedule: boundQuote.schedule }) : flags;
  const refers = panelFlags.filter((f) => f.severity === "refer");
  const openRefers = refers.filter((f) => clearanceStatus(f, ws.referral_clearances[f.code], !!policy) !== "cleared").length;
  const warns = panelFlags.length - refers.length;
  // A file can't bind with a referral open, so one that is unresolved on a bound file comes from a rule added or changed since.
  const unresolved = policy ? "since bind" : "open";
  const referralsTitle = `Referrals · ${openRefers} ${unresolved}${refers.length - openRefers ? ` · ${refers.length - openRefers} cleared` : ""}${warns ? ` · ${warns} warn` : ""}`;

  return (
    <main className="mx-auto max-w-7xl p-8">
      {/* The key remounts on bind: the inputs then show what was bound, not figures typed since that quote. */}
      <ActionFormProvider key={policy ? "bound" : "open"} formId="worksheet-form" action={saveAndRateAction.bind(null, id)}>
        {/* UX-010: where this page sits. */}
        <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
          <Link href="/submissions" className="text-indigo-600 hover:underline">Inbox</Link> ›{" "}
          <Link href={`/submissions/${id}`} className="text-indigo-600 hover:underline">{sub.reference} intake</Link> › <span className="text-slate-700">Workbench</span>
        </nav>
        {/* UX-021: the title row and Save & rate stay in view while the form scrolls. */}
        <div className="sticky top-0 z-10 -mx-8 mt-2 flex flex-wrap items-center gap-3 bg-slate-50/95 px-8 py-2 backdrop-blur">
          <h1 className="text-2xl font-semibold">{sub.applicant_name}</h1>
          <span className="font-mono text-sm text-slate-500">{sub.reference}</span>
          {/* UX-033: the workbench only exists for accepted files, so the chip pair is the whole status. */}
          <StatusChips chips={chips} />
          <span className="ml-auto flex items-center gap-3">
            {/* UX-037: once bound, the worksheet is the rating that was bound; nothing here saves. */}
            {policy ? <span className="text-xs text-slate-500">Worksheet frozen at bind</span> : <>
              <ActionDirtyHint />
              <ActionSubmit pending="Rating…" title="Enter also saves" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500">
                Save &amp; rate
              </ActionSubmit>
            </>}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Underwriting workbench · {String(sub.data.operations?.description ?? "")} ·{" "}
          <Link href={`/audit?submission=${id}`} className="text-indigo-600 hover:underline">Case history →</Link>
        </p>
        {policy && (
          <p className="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Bound as <Link href={`/policies/${policy.id}`} className="font-medium underline">{policy.policy_number}</Link> by {policy.bound_by} on {whenDate(policy.bound_at)} ·
            this worksheet is the rating that was bound. Changes to a bound policy need an endorsement; to renew, start the renewal from the policy page.
          </p>
        )}

        {exp && (
          <p className="mt-4 flex flex-wrap items-center gap-x-3 rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
            <span className="font-medium">Renewal of {exp.policy_number}</span>
            <span>expiring {money(exp.premium)} on rates {exp.rate_version} · {whenDate(exp.effective_date)} → {whenDate(exp.expiration_date)}</span>
            <span className="text-xs">Expiring values are shown under each input.</span>
            <Link href={`/submissions/${id}/renewal`} className="ml-auto font-medium hover:underline">Expiring vs renewing →</Link>
          </p>
        )}
        {msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
        {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <ActionError />

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <ActionForm className="space-y-6">
            <input type="hidden" name="_fingerprint" value={worksheetFingerprint(ws.rating_inputs, ws.schedule)} />
            <fieldset disabled={!!policy} className="space-y-6 [&_input:disabled]:bg-slate-50 [&_input:disabled]:text-slate-700 [&_select:disabled]:bg-slate-50 [&_select:disabled]:text-slate-700">{/* UX-037; UX-047: quiet the controls, not the labels */}
            <Card title="Rating inputs">
              <div className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
                {INPUT_DEFS.map((d) => (
                  <label key={d.key} className="flex flex-col gap-1 text-xs text-slate-500">
                    {/* UX-029: the input shows the unit, so the label does not repeat it. */}
                    {inputUnit(d) ? d.label.replace(/\s*%$|\s*\(ft\)$/, "") : d.label}
                    {d.kind === "bool" ? (
                      <ActionSelect name={d.key} saved={shownInputs[d.key] ? "yes" : "no"} className="rounded border px-2 py-1.5 text-sm text-slate-900">
                        <option value="yes">yes</option><option value="no">no</option>
                      </ActionSelect>
                    ) : (
                      // UX-004: formatted with its unit, the same text as the "expiring:" line below it.
                      <WorksheetInput def={d} saved={editValue(d, shownInputs)} unit={inputUnit(d)} />
                    )}
                    <FieldMessage name={d.key} />
                    {exp && (() => {
                      const was = inputText(d.key, exp.rating_inputs[d.key]);
                      const changed = was !== inputText(d.key, shownInputs[d.key]);
                      return <span className={`text-[11px] ${changed ? "font-medium text-amber-700" : "text-slate-500"}`}>expiring: {was}</span>;
                    })()}
                  </label>
                ))}
              </div>
            </Card>

            <Card title={`Schedule rating · total ${total > 0 ? "+" : ""}${total}% · mod ${scheduleMod(shownSchedule).toFixed(2)}`}>
              <p className="px-4 pt-3 text-xs text-slate-500">
                Credits are negative, debits positive, up to ±{MAX_CATEGORY_PCT}% per category. Every credit or debit needs a written reason.
                Totals beyond ±{UW_AUTHORITY_PCT}% need a referral.
              </p>
              <table className="mt-2 w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr><th scope="col" className="px-4 py-2 font-medium">Category</th><th scope="col" className="px-2 py-2 font-medium">%</th><th scope="col" className="px-4 py-2 font-medium">Reason</th></tr>
                </thead>
                <tbody>
                  {SCHEDULE_CATEGORIES.map((c) => {
                    const item = schedule.get(c.key);
                    return (
                      <tr key={c.key} className="border-t border-slate-100 align-top">
                        <td className="px-4 py-2 text-slate-700">{c.label}</td>
                        <td className="px-2 py-2">
                          {/* UX-001: a whole percent within authority, enforced by the browser first. */}
                          <ActionInput name={`schedule.${c.key}.pct`} aria-label={`${c.label}: percent (credit negative, debit positive)`} saved={String(item?.pct ?? 0)} type="number" min={-MAX_CATEGORY_PCT} max={MAX_CATEGORY_PCT} step={1} inputMode="numeric"
                            className={`w-16 rounded border px-2 py-1 text-right tabular-nums ${item ? (item.pct < 0 ? "border-emerald-400 bg-emerald-50" : "border-rose-300 bg-rose-50") : ""}`} />
                          <FieldMessage name={`schedule.${c.key}.pct`} />
                        </td>
                        <td className="px-4 py-2">
                          <ActionInput name={`schedule.${c.key}.rationale`} aria-label={`${c.label}: reason`} saved={item?.rationale ?? ""}
                            placeholder="Why this credit or debit is justified" className="w-full rounded border px-2 py-1" />
                          <FieldMessage name={`schedule.${c.key}.rationale`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
            </fieldset>
          </ActionForm>

          <aside className="space-y-6">
            <Card title={policy ? "Policy" : "Quote"}>
              <div className="space-y-4 p-4">
                {policy && (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
                    <p className="font-medium text-emerald-800">Bound · <Link href={`/policies/${policy.id}`} className="underline hover:no-underline">{policy.policy_number}</Link></p>
                    <p className="mt-0.5 text-xs text-emerald-700">
                      Binder {policy.binder_number} · {policy.quote_number} v{policy.quote_version} · {money(policy.total)} · by {policy.bound_by}
                    </p>
                    <p className="mt-2 flex gap-3 text-xs">
                      <a href={`/policies/${policy.id}/binder`} target="_blank" className="text-indigo-600 hover:underline">Binder PDF</a>
                      <a href={`/policies/${policy.id}/policy`} target="_blank" className="text-indigo-600 hover:underline">Policy PDF</a>
                    </p>
                    {policy.subjectivities.some((s) => s.status === "open") && (
                      <ul className="mt-2 space-y-0.5 text-xs text-amber-800">
                        {policy.subjectivities.filter((s) => s.status === "open").map((s, i) => <li key={i}>Open: {s.text}{s.due_date && <> (due {whenDate(s.due_date)})</>}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {quotes.length > 0 && (
                  <ul className="space-y-1 text-sm">
                    {quotes.map((q) => (
                      // UX-013: quote numbers look like the links they are; superseded rows are quiet, not faint.
                      <li key={q.id} className={`flex items-center gap-2 ${q.status === "superseded" ? "text-slate-500" : ""}`}>
                        <Link href={`/quotes/${q.id}`} className="font-mono text-xs text-indigo-600 hover:underline">{q.quote_number} v{q.version}</Link>
                        <Pill status={q.status} />
                        <span className="ml-auto tabular-nums">{money(q.total)}</span>
                        <a href={`/quotes/${q.id}/pdf`} target="_blank" className="text-xs text-indigo-600 hover:underline">PDF</a>
                      </li>
                    ))}
                  </ul>
                )}
                {/* UX-003: the worksheet has moved on from the issued quote; say so, and lead with the revised quote. */}
                {differs && latest && <QuoteDriftNotice quote={latest} changes={drift} newTotal={rated && rating ? rating.total : null} />}
                {differs && !policy && (ready ? (
                  <WaitForSave hint={WAIT}>{issueForm}</WaitForSave>
                ) : (
                  <p className="text-sm text-slate-500">
                    {!rated ? "Save & rate the current inputs to quote the new terms." : `Clear ${openReferrals.length} open referral${openReferrals.length === 1 ? "" : "s"} to quote the new terms.`}
                  </p>
                ))}
                {!policy && latest?.status === "issued" && (
                  bindIssues.length ? (
                    <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{bindIssues.join("; ")}</p>
                  ) : (
                    // UX-002: Bind waits for unsaved rating edits to be saved & rated (or reverted).
                    <WaitForSave hint={WAIT}>
                      <BindForm action={bindAction.bind(null, id, latest.id)} label={`Bind ${latest.quote_number} v${latest.version} for ${money(latest.total)}`}>
                        <p className="text-sm font-medium">Bind {latest.quote_number} v{latest.version}</p>
                        <p className="text-xs text-slate-500">Tick subjectivities already received. The rest stay open on the binder, due in 30 days.</p>
                        {latest.subjectivities.map((text, i) => (
                          <label key={i} className="flex items-start gap-2 text-xs">
                            <input type="checkbox" name="received" value={i} className="mt-0.5" /> {text}
                          </label>
                        ))}
                        {/* UX-009 "Binding…"; UX-003 outlined when the worksheet differs from what was quoted. */}
                        <SubmitButton pending="Binding…"
                          className={`w-full rounded-md px-4 py-2 text-sm font-medium ${differs ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "bg-emerald-700 text-white hover:bg-emerald-600"}`}>
                          {differs ? `Bind v${latest.version} as issued · ${money(latest.total)}` : `Bind · ${money(latest.total)}`}
                        </SubmitButton>
                      </BindForm>
                    </WaitForSave>
                  )
                )}
                {!policy && !differs && (ready ? (
                  latest ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-indigo-600">Revise quote (v{latest.version + 1})</summary>
                      <div className="mt-3"><WaitForSave hint={WAIT}>{issueForm}</WaitForSave></div>
                    </details>
                  ) : <WaitForSave hint={WAIT}>{issueForm}</WaitForSave>
                ) : (
                  <p className="text-sm text-slate-500">
                    {!rated ? "Save & rate the current inputs to quote." : `Clear ${openReferrals.length} open referral${openReferrals.length === 1 ? "" : "s"} to quote.`}
                  </p>
                ))}
              </div>
            </Card>

            <Card title={policy ? "Premium as bound" : "Indicative premium"}>
              {rating ? (
                <div className="p-4">
                  {!rated && !policy && (
                    <p className="mb-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      {staleRates ? `Rates changed since this rating (${staleRates.from} → ${staleRates.to}).` : "Inputs changed since this rating."} Save &amp; rate again.
                    </p>
                  )}
                  <p className="text-3xl font-semibold tabular-nums">{money(rating.total)}</p>
                  <p className="text-xs text-slate-500">{policy ? `bound ${whenDate(policy.bound_at)}` : "total cost to insured"} · rates {rating.rate_version}</p>
                  <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">
                    <dt className="text-slate-500">Premium</dt><dd className="text-right tabular-nums">{money(rating.premium)}</dd>
                    <dt className="text-slate-500">Policy fee</dt><dd className="text-right tabular-nums">{money(rating.policy_fee)}</dd>
                    <dt className="text-slate-500">SL tax ({(Number(rating.surplus_lines_tax_rate) * 100).toFixed(2)}%)</dt>
                    <dd className="text-right tabular-nums">{money(rating.surplus_lines_tax)}</dd>
                  </dl>
                  <table className="mt-4 w-full text-xs">
                    {/* UX-013: a header row over the worksheet steps. */}
                    <thead className="text-left text-slate-500">
                      <tr><th scope="col" className="py-1.5 pr-2 font-medium">Step</th><th scope="col" className="py-1.5 pr-2 text-right font-medium">Factor</th><th scope="col" className="py-1.5 text-right font-medium">Premium</th></tr>
                    </thead>
                    <tbody>
                      {rating.worksheet.map((w, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1.5 pr-2"><span className="font-medium">{w.step}</span><br /><span className="text-slate-500">{w.detail}</span></td>
                          <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums text-slate-500">{w.factor ? `× ${Number(w.factor).toFixed(2)}` : ""}</td>
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

            {/* UX-036: the same numbers as the header chip: what is still open, what was cleared, what only warns. */}
            <Card title={referralsTitle}>
              <ul className="divide-y divide-slate-100">
                {panelFlags.map((f) => {
                  const clearance = ws.referral_clearances[f.code];
                  const status = clearanceStatus(f, clearance, !!policy);
                  return (
                    <li key={f.code} className="p-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${status === "cleared" || (policy && f.severity === "refer") ? "bg-slate-100 text-slate-500" : f.severity === "refer" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>
                          {status === "cleared" ? "cleared" : policy && f.severity === "refer" ? "since bind" : f.severity}
                        </span>
                        <span className="font-medium">{f.title}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{f.detail}</p>
                      {status === "cleared" && clearance && (
                        // UX-017: who, when and why on one line.
                        <p className="mt-2 text-xs text-slate-500">
                          <span className="font-medium text-slate-700">{clearance.by}</span> · {when(clearance.at)}: “{clearance.note}”
                          {clearance.detail && clearance.detail !== f.detail && <> That note is for “{clearance.detail}”. The worksheet history has the clearance this quote was issued under.</>}
                        </p>
                      )}
                      {status !== "cleared" && f.severity === "refer" && policy && (
                        <p className="mt-2 text-xs text-slate-500">Raised by the current rules, not the rules at bind. Nothing to clear on a bound policy.</p>
                      )}
                      {status === "stale" && clearance && !policy && (
                        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          {clearance.by} cleared this for {clearance.detail ? `“${clearance.detail}”` : "earlier facts"} on {when(clearance.at)}; the facts changed, so it needs clearing again.
                        </p>
                      )}
                      {status !== "cleared" && f.severity === "refer" && !policy && (
                        // UX-002: Clear waits for unsaved rating edits, so a flag isn't cleared against stale facts.
                        <WaitForSave hint={WAIT} className="mt-2">
                          <form action={clearReferralAction.bind(null, id, f.code)} className="flex gap-2">
                            <input type="hidden" name="detail" value={f.detail} />
                            <input name="note" aria-label={`Why "${f.title}" is acceptable`} required minLength={10} placeholder="Why this is acceptable (authority, mitigation)"
                              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
                            <SubmitButton pending="Clearing…" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Clear</SubmitButton>
                          </form>
                        </WaitForSave>
                      )}
                    </li>
                  );
                })}
                {!panelFlags.length && <li className="p-4 text-sm text-emerald-700">No referral rules triggered.</li>}
              </ul>
            </Card>

            <Card title="Worksheet history">
              <ul className="space-y-2 p-4 text-xs">
                {history.map((h) => (
                  <li key={h.id}>
                    {/* UX-006: one display zone, named. */}
                    <span className="text-slate-500">{when(h.occurred_at)}</span>{" "}
                    {recordedApart(h.occurred_at, h.recorded_at) && <span className="text-amber-700">(recorded {when(h.recorded_at!)}) </span>/* CR-074 */}
                    <span className="font-medium">{h.actor}</span>: {h.summary}
                    {/* UX-045: the same text the inputs show ($1,000 → $2,500, AZ → AZ, NV). */}
                    {h.action === "worksheet.input_changed" && (() => {
                      const key = Object.keys(h.before as object)[0] as keyof RatingInputs;
                      return <span className="text-slate-500"> ({inputText(key, Object.values(h.before as object)[0])} → {inputText(key, Object.values(h.after as object)[0])})</span>;
                    })()}
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      </ActionFormProvider>
    </main>
  );
}

/** UX-004: the input's text is `inputText` without the unit the wrapper shows: "$2,300,000" → "2,300,000", "100%" → "100". */
function editValue(d: (typeof INPUT_DEFS)[number], inputs: RatingInputs): string {
  const t = inputText(d.key, inputs[d.key]);
  return d.kind === "money" ? t.replace(/^-?\$/, (m) => m.replace("$", "")) : d.kind === "pct" ? t.replace(/%$/, "") : t;
}

/** A changed value in the drift notice: inputs through `inputText`, schedule percents as given. */
function changeText(key: string, v: unknown): string {
  return key.startsWith("schedule.") ? String(v) : inputText(key as keyof RatingInputs, v as RatingInputs[keyof RatingInputs]);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}
