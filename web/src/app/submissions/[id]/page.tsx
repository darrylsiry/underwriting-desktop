import Link from "next/link";
import { notFound } from "next/navigation";
import { auditTrail } from "@/lib/audit";
import { isOpenLoss } from "@/lib/referrals";
import { dataFingerprint, getSubmission, listDocuments, missingForRating } from "@/lib/submissions";
import {
  SECTIONS, attention, formatValue, getPath, toInput, type FieldDef, type FieldMeta, type Value,
} from "@/lib/submission";
import { acceptAction, saveReviewAction } from "../actions";
import { StatusBadge } from "../status-badge";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> };

export default async function ReviewPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { msg, error } = await searchParams;
  const sub = await getSubmission(id);
  if (!sub) notFound();
  const [documents, history] = await Promise.all([listDocuments(id), auditTrail("submission", id)]);
  const ex = sub.extraction;
  const editable = sub.status === "needs_review";
  const missing = missingForRating(sub.data);
  const conflicts = new Map(ex.conflicts.map((c) => [c.path, c]));
  const docTypes = new Map(ex.documents.map((d) => [d.filename, d]));

  return (
    <main className="mx-auto max-w-7xl p-8">
      <Link href="/submissions" className="text-sm text-indigo-600 hover:underline">← Inbox</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{sub.applicant_name || "Unnamed applicant"}</h1>
        <span className="font-mono text-sm text-slate-500">{sub.reference}</span>
        <StatusBadge status={sub.status} />
        {editable && <button form="review-form" className="ml-auto rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500">Save corrections</button>}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Received by {sub.received_by} {sub.received_at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
        {ex.claude && <> · read by {ex.claude.model} ({ex.claude.usage.input_tokens.toLocaleString()} in / {ex.claude.usage.output_tokens.toLocaleString()} out tokens)</>}
        {sub.reviewed_by && <> · accepted by {sub.reviewed_by}</>}
        {sub.insured_id && <> · <Link href={`/insureds/${sub.insured_id}`} className="text-indigo-600 hover:underline">customer record</Link></>}
        {" · "}<Link href={`/audit?submission=${id}`} className="text-indigo-600 hover:underline">case history</Link>
      </p>

      {msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {editable && missing.length > 0 && (
        <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Missing before this can be rated: {missing.join(", ")}. Fill them in or ask the broker.
        </p>
      )}
      {ex.warnings.map((w) => <p key={w} className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{w}</p>)}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <form id="review-form" action={saveReviewAction.bind(null, id)} className="space-y-6">
          <input type="hidden" name="_fingerprint" value={dataFingerprint(sub.data)} />
          {SECTIONS.map((section) => (
            <section key={section.key} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <h2 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">{section.title}</h2>
              <div className="divide-y divide-slate-100">
                {section.fields.map((def) => (
                  <FieldRow key={def.path} def={def} value={getPath(sub.data, def.path)}
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
              <tbody>
                {sub.data.loss_history.map((l) => (
                  <tr key={`${l.date}-${l.incurred}`} className="border-t border-slate-100 first:border-0">
                    <td className="px-4 py-2 tabular-nums text-slate-500">{l.date}</td>
                    <td className="px-4 py-2">{l.description}</td>
                    <td className="px-4 py-2 text-right tabular-nums">${l.incurred.toLocaleString("en-US")}</td>
                    <td className="px-4 py-2"><span className={isOpenLoss(l.status) ? "font-medium text-rose-700" : "text-slate-500"}>{l.status}</span></td>
                  </tr>
                ))}
                {!sub.data.loss_history.length && <tr><td className="px-4 py-3 text-slate-400">No losses reported.</td></tr>}
              </tbody>
            </table>
          </section>

        </form>

        <aside className="space-y-6">
          {editable && (
            <form action={acceptAction.bind(null, id)} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-medium">Accept intake</h2>
              <p className="mt-1 text-xs text-slate-500">
                Save corrections first. Accepting links the insured and hands the submission to underwriting.
              </p>
              <button disabled={missing.length > 0}
                className="mt-3 w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                Accept intake
              </button>
            </form>
          )}

          {!editable && (
            <Link href={`/submissions/${id}/workbench`}
              className="block rounded-lg bg-indigo-600 p-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-500">
              Open underwriting workbench →
              <span className="mt-1 block text-xs font-normal text-indigo-100">Rating inputs, schedule credits/debits, referrals, indicative premium</span>
            </Link>
          )}

          <Panel title="Documents">
            <ul className="space-y-2 text-sm">
              {documents.map((d) => (
                <li key={d.id}>
                  <a href={`/submissions/${id}/documents/${d.id}`} target="_blank" className="text-indigo-600 hover:underline">{d.filename}</a>
                  <span className="ml-1 text-xs text-slate-400">{Math.ceil(d.size / 1024)} KB</span>
                </li>
              ))}
            </ul>
            <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {ex.documents.map((d) => (
                <li key={d.filename}>
                  <span className="font-medium text-slate-700">{d.doc_type.replaceAll("_", " ")}</span>: {d.filename}
                  {d.parent && <> (in email)</>} · {d.method === "form_field" ? "form fields" : "Claude"}
                </li>
              ))}
            </ul>
          </Panel>

          {ex.notes.length > 0 && (
            <Panel title="Underwriting notes from Claude">
              <ul className="list-disc space-y-2 pl-4 text-sm text-slate-700">{ex.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </Panel>
          )}

          {ex.conflicts.length > 0 && (
            <Panel title="Documents disagree">
              <ul className="space-y-2 text-sm">
                {ex.conflicts.map((c) => (
                  <li key={c.path}><code className="text-xs">{c.path}</code>: used <strong>{JSON.stringify(c.chosen)}</strong>;{" "}
                    {c.others.map((o) => `${JSON.stringify(o.value)} in ${o.source_document}`).join(", ")}</li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="History">
            <ul className="space-y-2 text-xs">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="text-slate-400">{h.occurred_at.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>{" "}
                  <span className="font-medium">{h.actor}</span>: {h.summary}
                  {h.action === "submission.field_corrected" && (
                    <span className="text-slate-500"> ({JSON.stringify(Object.values(h.before as object)[0])} → {JSON.stringify(Object.values(h.after as object)[0])})</span>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </main>
  );
}

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
};

function FieldRow({ def, value, original, meta, corrected, conflicted, editable, docType }: FieldRowProps) {
  const reason = corrected ? null : attention(def.path, value, meta, conflicted);
  const tone = corrected ? "border-l-indigo-400" : reason === "Required for rating" ? "border-l-rose-400" : reason ? "border-l-amber-400" : "border-l-transparent";
  const inputClass = "w-full rounded border border-slate-300 px-2 py-1 text-sm";
  return (
    <div className={`grid grid-cols-[180px_minmax(0,1fr)_170px] items-start gap-4 border-l-4 px-4 py-2.5 ${tone}`}>
      <label htmlFor={def.path} className="pt-1 text-sm text-slate-600">{def.label}</label>
      <div>
        {!editable ? (
          <p className="pt-1 text-sm">{formatValue(def.type, value)}</p>
        ) : def.type === "bool" ? (
          <select id={def.path} name={def.path} defaultValue={toInput(def.type, value)} className={inputClass}>
            <option value="">—</option><option value="yes">yes</option><option value="no">no</option>
          </select>
        ) : def.path === "operations.description" ? (
          <textarea id={def.path} name={def.path} defaultValue={toInput(def.type, value)} rows={3} className={inputClass} />
        ) : (
          <input id={def.path} name={def.path} defaultValue={toInput(def.type, value)} className={inputClass}
            placeholder={def.type === "date" ? "YYYY-MM-DD" : def.type === "states" ? "e.g. TX, OK" : ""} />
        )}
        {meta?.snippet && !corrected && (
          <p className="mt-1 truncate text-xs text-slate-400" title={meta.snippet}>
            “{meta.snippet}” — {meta.source_document}{docType && ` (${docType.replaceAll("_", " ")})`}
          </p>
        )}
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
