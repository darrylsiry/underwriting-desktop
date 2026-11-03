import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { when, whenDate } from "@/components/ui";
import { auditTrail } from "@/lib/audit";
import { recordedApart } from "@/lib/timeline-merge";
import { isOpenLoss } from "@/lib/referrals";
import { plural } from "@/lib/text";
import { dataFingerprint, getSubmission, listDocuments, missingForRating } from "@/lib/submissions";
import {
  FIELD_DEFS, SECTIONS, fieldLabel, fieldValueText, formatValue, getPath, openAttention, toInput, type FieldDef, type FieldMeta, type Value,
} from "@/lib/submission";
import { declineAction, reopenDeclinedAction, reopenIntakeAction, reviewAction } from "../actions";
import { ConfirmForm } from "@/components/confirm-form";
import { Flash } from "@/components/flash";
import { ReasonForm } from "@/components/reason-form";
import { StageChip } from "@/components/stage-chip";
import { submissionStagesById } from "@/lib/dashboard";
import { DECLINE_REASONS, closureText } from "@/lib/file-closure";
import { policiesForSubmission } from "@/lib/policies";
import { rateableClasses } from "@/lib/worksheets";
import { ActionDirtyHint, ActionError, ActionForm, ActionFormProvider, ActionInput, ActionSelect, ActionSubmit, ActionTextarea, FieldMessage } from "./action-form";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> };

// UX-010: the tab names the file.
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const sub = await getSubmission((await params).id);
  return { title: sub ? `${sub.reference} · Intake review` : "Intake review" };
}

export default async function ReviewPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { msg, error } = await searchParams;
  const sub = await getSubmission(id);
  if (!sub) notFound();
  const [documents, history, policies, stages, classes] = await Promise.all([listDocuments(id), auditTrail("submission", id), policiesForSubmission(id), submissionStagesById([id]), rateableClasses()]);
  const stage = stages.get(id);
  const bound = policies.length > 0;
  const declined = sub.status === "declined";
  const ex = sub.extraction;
  const editable = sub.status === "needs_review";
  const missing = missingForRating(sub.data);
  const conflicts = new Map(ex.conflicts.map((c) => [c.path, c]));
  const docTypes = new Map(ex.documents.map((d) => [d.filename, d]));
  const unreadDocuments = ex.documents.filter((d) => d.method === "not_read").length;   // CR-147
  // UX-075: the same test as the Received list's counts, so the two numbers agree; missing fields come first.
  const toCheck = FIELD_DEFS.flatMap((d) => {
    const reason = openAttention(d.path, getPath(sub.data, d.path), ex.fields[d.path], conflicts.has(d.path), sub.corrected_fields.includes(d.path));
    return reason ? [{ def: d, reason }] : [];
  }).sort((a, b) => Number(b.reason === "Required for rating") - Number(a.reason === "Required for rating"));

  return (
    <main className="mx-auto max-w-7xl p-8">
      {/* UX-001/UX-002: one form, two submit buttons; a rejected value comes back as typed. */}
      <ActionFormProvider formId="review-form" action={reviewAction.bind(null, id)}>
        <Link href="/submissions" className="text-sm text-indigo-600 hover:underline">← Submissions</Link>
        {/* UX-021: the title row and Save stay in view while the form scrolls. */}
        <div className="sticky top-0 z-10 -mx-8 mt-2 flex flex-wrap items-center gap-3 bg-slate-50/95 px-8 py-2 backdrop-blur">
          <h1 className="text-2xl font-semibold">{sub.applicant_name || "Unnamed applicant"}</h1>
          <span className="font-mono text-sm text-slate-500">{sub.reference}</span>
          {stage && <StageChip stage={stage} />}
          {editable && (
            <span className="ml-auto flex items-center gap-3">
              <ActionDirtyHint />
              {/* UX-009: "Saving…" while it runs. Enter in any field submits this (the form's first submit button). */}
              <ActionSubmit name="intent" value="save" pending="Saving…" title="Enter also saves"
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500">
                Save corrections
              </ActionSubmit>
              {/* UX-075: Accept stays in view. After Save, so Enter in a field still saves rather than accepts. */}
              <ActionSubmit name="intent" value="accept" pending="Accepting…" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500">
                Save &amp; accept
              </ActionSubmit>
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Received by {sub.received_by} {when(sub.received_at)}
          {ex.claude && <> · read by {ex.claude.model} ({ex.claude.usage.input_tokens.toLocaleString()} in / {ex.claude.usage.output_tokens.toLocaleString()} out tokens)</>}
          {sub.reviewed_by && <> · accepted by {sub.reviewed_by}</>}
          {sub.insured_id && <> · <Link href={`/insureds/${sub.insured_id}`} className="text-indigo-600 hover:underline">customer record</Link></>}
          {" · "}<Link href={`/audit?submission=${id}`} className="text-indigo-600 hover:underline">case history</Link>
        </p>

        <Flash msg={msg} error={error} />
        {declined && sub.decline && (
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-800">
            <span>{closureText("Declined", sub.decline)}.</span>
            <ConfirmForm action={reopenDeclinedAction.bind(null, id)} confirmText={`Reopen ${sub.reference}? It goes back where it was. A quote closed with it stays closed, so issue a new version.`} pending="Reopening…" className="font-medium text-indigo-700 hover:underline">Reopen</ConfirmForm>
          </p>
        )}
        <ActionError />
        {editable && missing.length > 0 && (
          <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">
            Missing before this can be rated:{" "}
            {missing.map((p, i) => <Fragment key={p}>{i > 0 && ", "}<a href={`#${p}`} className="underline">{fieldLabel(p)}</a></Fragment>)}. Fill them in or ask the broker.
          </p>
        )}
        {ex.warnings.map((w, i) => <p key={i} className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{w}</p>)}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <ActionForm className="space-y-6">
            <input type="hidden" name="_fingerprint" value={dataFingerprint(sub.data)} />
            {SECTIONS.map((section) => (
              <section key={section.key} className="rounded-lg border border-slate-200 bg-white shadow-sm">
                <h2 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">{section.title}</h2>
                <div className="divide-y divide-slate-100">
                  {section.fields.map((def) => (
                    <FieldRow key={def.path} def={def} value={getPath(sub.data, def.path)} className={def.path === "operations.class_code" ? classes.get(String(getPath(sub.data, def.path))) : undefined}
                      original={getPath(ex.submission, def.path)} meta={ex.fields[def.path]}
                      corrected={sub.corrected_fields.includes(def.path)} conflicted={conflicts.has(def.path)}
                      editable={editable} docType={docTypes.get(ex.fields[def.path]?.source_document ?? "")?.doc_type} />
                  ))}
                </div>
              </section>
            ))}

            <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <h2 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">Loss history</h2>
              <table className="w-full text-sm">
                {/* UX-013: a header row over the dates and dollars. */}
                {sub.data.loss_history.length > 0 && (
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Date</th><th scope="col" className="px-4 py-2 font-medium">Description</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Incurred</th><th scope="col" className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {sub.data.loss_history.map((l, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{dateText(l.date)}</td>
                      <td className="px-4 py-2">{l.description}</td>
                      <td className="px-4 py-2 text-right tabular-nums">${l.incurred.toLocaleString("en-US")}</td>
                      <td className="px-4 py-2"><span className={isOpenLoss(l.status) ? "font-medium text-rose-700" : "text-slate-500"}>{l.status}</span></td>
                    </tr>
                  ))}
                  {!sub.data.loss_history.length && <tr><td className="px-4 py-3 text-slate-500">{unreadDocuments ? `No losses read; ${plural(unreadDocuments, "document")} ${unreadDocuments === 1 ? "was" : "were"} not read.` : "No losses reported."}</td></tr>}
                </tbody>
              </table>
            </section>
          </ActionForm>

          <aside className="space-y-6">
            {editable && (
              <Panel title={`To check · ${toCheck.length}`}>
                {toCheck.length ? (
                  <ul className="space-y-1 text-sm">
                    {toCheck.map(({ def, reason }) => (
                      <li key={def.path}>
                        <a href={`#${def.path}`} className="text-indigo-600 hover:underline">{def.label}</a>{" "}
                        <span className={`text-xs ${reason === "Required for rating" ? "text-rose-700" : "text-slate-500"}`}>{reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-emerald-700">Nothing flagged. Looks complete.</p>}
              </Panel>
            )}
            {editable && (
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-sm font-medium">Accept intake</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {missing.length
                    ? <>Fill in {missing.map(fieldLabel).join(", ")} above, then accept. Accepting saves your corrections, links the insured and hands the submission to underwriting.</>
                    : <>Saves your corrections, then accepts: links the insured and hands the submission to underwriting.</>}
                </p>
                {/* UX-002: the same form as Save, so typed corrections go with the accept. */}
                <ActionSubmit name="intent" value="accept" pending="Accepting…"
                  className="mt-3 w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500">
                  Save &amp; accept intake
                </ActionSubmit>
              </div>
            )}

            {!editable && !declined && (
              <Link href={`/submissions/${id}/workbench`}
                className="block rounded-lg bg-indigo-600 p-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-500">
                Open underwriting workbench →
                <span className="mt-1 block text-xs font-normal text-indigo-100">Rating inputs, schedule credits/debits, referrals, indicative premium</span>
              </Link>
            )}

            {sub.status === "accepted" && !bound && (
              <div className="text-xs">
                <ConfirmForm action={reopenIntakeAction.bind(null, id)} confirmText={`Reopen ${sub.reference} for corrections? The worksheet is kept; issued quotes stay as sent, so reissue after correcting.`} pending="Reopening…" className="text-indigo-600 hover:underline">Reopen intake to correct</ConfirmForm>
              </div>
            )}
            {!declined && !bound && (
              <ReasonForm action={declineAction.bind(null, id)} summary="Decline this file…" reasons={DECLINE_REASONS} submitLabel="Decline file" pending="Declining…"
                confirmText={`Decline ${sub.reference}? It leaves your desk and stays searchable with its history.`} />
            )}

            <Panel title="Documents">
              <ul className="space-y-2 text-sm">
                {documents.map((d) => (
                  <li key={d.id}>
                    <a href={`/submissions/${id}/documents/${d.id}`} target="_blank" className="text-indigo-600 hover:underline">{d.filename}</a>
                    <span className="ml-1 text-xs text-slate-500">{Math.ceil(d.size / 1024)} KB</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
                {ex.documents.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium text-slate-700">{d.doc_type.replaceAll("_", " ")}</span>: {d.filename}
                    {d.parent && <> (in email)</>} · {d.method === "not_read" ? "not read" : d.method === "claude" ? "Claude" : "form fields"}
                  </li>
                ))}
              </ul>
            </Panel>

            {ex.notes.length > 0 && (
              <Panel title="Underwriting notes from Claude">
                <ul className="list-disc space-y-2 pl-4 text-sm text-slate-700">{ex.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </Panel>
            )}

            {ex.conflicts.length > 0 && (
              <Panel title="Documents disagree">
                <ul className="space-y-2 text-sm">
                  {ex.conflicts.map((c) => (
                    <li key={c.path}><a href={`#${c.path}`} className="text-indigo-600 hover:underline">{fieldLabel(c.path)}</a>: used <strong>{fieldValueText(c.path, c.chosen as Value)}</strong>;{" "}
                      {c.others.map((o) => `${fieldValueText(c.path, o.value as Value)} in ${o.source_document}`).join(", ")}</li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel title="History">
              <ul className="space-y-2 text-xs">
                {history.map((h) => (
                  <li key={h.id}>
                    {/* UX-006: one display zone, named. */}
                    <span className="text-slate-500">{when(h.occurred_at)}</span>{" "}
                    {recordedApart(h.occurred_at, h.recorded_at) && <span className="text-amber-700">(recorded {when(h.recorded_at!)}) </span>/* CR-074 */}
                    <span className="font-medium">{h.actor}</span>: {h.action === "submission.field_corrected" ? `${sub.reference}: ${fieldLabel(Object.keys(h.before as object)[0])} corrected` : h.summary}
                    {h.action === "submission.field_corrected" && (() => {
                      const path = Object.keys(h.before as object)[0];
                      return <span className="text-slate-500"> ({fieldValueText(path, Object.values(h.before as object)[0] as Value)} → {fieldValueText(path, Object.values(h.after as object)[0] as Value)})</span>;
                    })()}
                  </li>
                ))}
              </ul>
            </Panel>
          </aside>
        </div>
      </ActionFormProvider>
    </main>
  );
}

/** UX-025: `Dec 1, 2026` for an ISO date; anything else (a loss run's odd date) as written. */
const dateText = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? whenDate(d) : d);

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

type FieldRowProps = {
  def: FieldDef; value: Value; original: Value; meta?: FieldMeta;
  corrected: boolean; conflicted: boolean; editable: boolean; docType?: string;
  className?: string;   // the class code's name, under its value (UX-077)
};

// UX-001 (1): browser-side constraints so a typo is caught before the round trip; the server still validates.
function constraints(type: FieldDef["type"]): React.InputHTMLAttributes<HTMLInputElement> {
  switch (type) {
    case "money": case "int": case "pct":
      return { inputMode: "numeric", pattern: "[0-9$,.% ]*", title: "Digits; $ , % and spaces are fine" };
    case "state":
      return { pattern: "[A-Za-z]{2}", maxLength: 2, title: "2-letter state code" };
    case "states":
      return { pattern: "[A-Za-z]{2}([ ,;]+[A-Za-z]{2})*[ ,;]*", title: "2-letter state codes, e.g. TX, OK", placeholder: "e.g. TX, OK" };
    case "date":
      return { pattern: "[0-9]{4}-[0-9]{2}-[0-9]{2}", title: "YYYY-MM-DD", placeholder: "YYYY-MM-DD" };
    default:
      return {};
  }
}

function FieldRow({ def, value, original, meta, corrected, conflicted, editable, docType, className }: FieldRowProps) {
  const reason = openAttention(def.path, value, meta, conflicted, corrected);
  const tone = reason === "Required for rating" ? "border-l-rose-400" : corrected ? "border-l-indigo-400" : reason ? "border-l-amber-400" : "border-l-transparent";
  const inputClass = "w-full scroll-mt-24 rounded border px-2 py-1 text-sm";   // UX-075: a jump isn't hidden behind the sticky bar
  const saved = toInput(def.type, value);
  return (
    <div className={`grid grid-cols-[180px_minmax(0,1fr)_170px] items-start gap-4 border-l-4 px-4 py-2.5 ${tone}`}>
      <label htmlFor={def.path} className="pt-1 text-sm text-slate-600">{def.label}</label>
      <div>
        {!editable ? (
          <p id={def.path} className="scroll-mt-24 pt-1 text-sm">{formatValue(def.type, value)}</p>
        ) : def.type === "bool" ? (
          <ActionSelect id={def.path} name={def.path} saved={saved} className={inputClass}>
            <option value="">—</option><option value="yes">yes</option><option value="no">no</option>
          </ActionSelect>
        ) : def.path === "operations.description" ? (
          <ActionTextarea id={def.path} name={def.path} saved={saved} rows={3} className={inputClass} />
        ) : (
          <ActionInput id={def.path} name={def.path} saved={saved} className={inputClass} {...constraints(def.type)} />
        )}
        {editable && <FieldMessage name={def.path} />}
        {className && <p className="mt-0.5 text-[11px] text-slate-600">{className}</p>}
        {/* UX-011 / UX-028: a form-field read is provenance (one small line); a Claude read is evidence
            (the quote, readable without a mouse, with one expander when it is long). */}
        {meta?.snippet && !corrected && (meta.method === "form_field" ? (
          <p className="mt-0.5 text-[11px] text-slate-500">
            Form field <code>{meta.snippet.split(" = ")[0]}</code>{docType && ` · ${docType.replaceAll("_", " ")}`}
          </p>
        ) : meta.snippet.length > 140 ? (
          // UX-035: the clamp sits on an inner span, the cue outside it, and the span un-clamps on open.
          <details className="group mt-1 text-xs text-slate-600">
            <summary className="cursor-pointer list-none">
              <span className="line-clamp-2 whitespace-pre-wrap group-open:line-clamp-none">
                “{meta.snippet}” <span className="text-slate-500">— {meta.source_document}{docType && ` (${docType.replaceAll("_", " ")})`}</span>
              </span>
              <span className="text-indigo-600 group-open:hidden">Show more</span>
              <span className="hidden text-indigo-600 group-open:inline">Show less</span>
            </summary>
          </details>
        ) : (
          <p className="mt-1 text-xs text-slate-600">
            “{meta.snippet}” <span className="text-slate-500">— {meta.source_document}{docType && ` (${docType.replaceAll("_", " ")})`}</span>
          </p>
        ))}
        {corrected && (
          <p className="mt-1 text-xs text-indigo-600">Corrected by underwriter · extracted value: {formatValue(def.type, original)}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 pt-1 text-xs">
        {meta && !corrected && <ConfidencePill meta={meta} />}
        {meta?.basis === "inferred" && !corrected && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">inferred</span>}
        {reason && reason !== "Inferred, not stated" && <span className={reason === "Required for rating" ? "text-rose-700" : "text-amber-700"}>{reason}</span>}
      </div>
    </div>
  );
}

function ConfidencePill({ meta }: { meta: FieldMeta }) {
  const pct = Math.round(meta.confidence * 100);
  const style = meta.confidence >= 0.9 ? "bg-emerald-50 text-emerald-700" : meta.confidence >= 0.6 ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700";
  return (
    <span className={`rounded px-1.5 py-0.5 ${style}`} title={meta.method === "form_field" ? "Read from a PDF form field" : "Extracted by Claude"}>
      {pct}% {meta.method === "form_field" ? "form" : "Claude"}
    </span>
  );
}
