import { moneyExact } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { when } from "@/components/ui";
import { submissionStages } from "@/lib/dashboard";
import { inboxWarning, listInbox } from "@/lib/inbox";
import { StageChip } from "@/components/stage-chip";
import { STAGE_FILTERS, isStageKey, stageSummary } from "@/lib/stage";
import { listSubmissions, missingForRating } from "@/lib/submissions";
import { FIELD_DEFS, getPath, openAttention } from "@/lib/submission";
import { iso } from "@/lib/time";
import { InboxList } from "./inbox-list";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Submissions" };   // UX-010

// UX-005: the stage chip, in the colours the rest of the app uses (amber: needs attention, emerald: done, indigo: out the door).
/** `?stage=` keeps one stage (UX-005). */
export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const [all, inbox, { stage }] = await Promise.all([listSubmissions(), listInbox(), searchParams]);
  const stages = await submissionStages(all);
  const stageFilter = isStageKey(stage) ? stage : null;
  const submissions = stageFilter ? all.filter((s) => stages.get(s.id)?.key === stageFilter) : all;
  const warning = inboxWarning();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Submissions</h1>
      <p className="mt-1 text-sm text-slate-500">Pick a broker submission from the inbox (or upload one); review what was extracted before it goes to underwriting.</p>

      <section className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inbox · {inbox.length} new</h2>
          <span className="text-xs text-slate-500">From the broker drop folder, not yet extracted. Fillable forms read instantly; the rest takes Claude 20–40 s.</span>
        </div>
        {warning && <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">{warning}</p>}
        {inbox.length ? <InboxList items={inbox} /> : (
          <p className="px-4 py-6 text-center text-sm text-slate-500">Inbox is empty: every submission in the drop folder has been extracted.</p>
        )}
      </section>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-700">Or upload documents yourself</summary>
        <div className="mt-2"><UploadForm /></div>
      </details>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wide text-slate-500">Received · {all.length}</h2>
      {/* UX-005: what the list holds, and one click to each stage. */}
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{stageSummary([...stages.values()])}</span>
        <span className="flex flex-wrap gap-1">
          <Link href="/submissions" className={`rounded-full border px-2 py-0.5 ${!stageFilter ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>All</Link>
          {STAGE_FILTERS.map((f) => {
            const n = [...stages.values()].filter((x) => x.key === f.key).length;
            return <Link key={f.key} href={`/submissions?stage=${f.key}`} className={`rounded-full border px-2 py-0.5 ${stageFilter === f.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>{f.label} · {n}</Link>;
          })}
        </span>
      </p>
      <table className="mt-2 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Ref</th><th className="px-4 py-2">Applicant</th><th className="px-4 py-2">Class</th>
            <th className="px-4 py-2">States</th><th className="px-4 py-2 text-right">Receipts</th>
            {/* UX-013: the column holds the next step, so it says so. UX-005: Stage replaces the accepted/needs-review pill. */}
            <th className="px-4 py-2">Next step</th><th className="px-4 py-2">Stage</th><th className="px-4 py-2">Received</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((s) => {
            const st = stages.get(s.id)!;
            const conflicted = new Set(s.extraction.conflicts.map((c) => c.path));
            const flags = FIELD_DEFS.filter((d) =>
              openAttention(d.path, getPath(s.data, d.path), s.extraction.fields[d.path], conflicted.has(d.path), s.corrected_fields.includes(d.path))).length;
            const missing = missingForRating(s.data).length;
            const receipts = getPath(s.data, "operations.gross_receipts");
            return (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs"><Link href={`/submissions/${s.id}`} className="text-indigo-600 hover:underline">{s.reference}</Link>
                  {s.kind === "renewal" && <Link href={`/submissions/${s.id}/renewal`} className="ml-1 rounded bg-indigo-50 px-1 py-0.5 font-sans text-[10px] text-indigo-700 hover:underline" title={`Renewal of ${s.renewal_of?.policy_number}`}>renewal</Link>}</td>
                <td className="px-4 py-2 font-medium">{s.applicant_name || <span className="text-slate-500">unnamed</span>}</td>
                <td className="px-4 py-2 font-mono text-xs">{String(getPath(s.data, "operations.class_code") ?? "") || "—"}</td>
                <td className="px-4 py-2">{(getPath(s.data, "operations.states") as string[] | null)?.join(", ") || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{receipts ? moneyExact(receipts as string | number) : "—"}</td>
                <td className="px-4 py-2 text-xs">
                  {/* UX-038: the next step follows the stage; a bound file's next step is its policy. */}
                  {st.key === "bound" && st.href ? <Link href={st.href} className="text-indigo-600 hover:underline">Policy →</Link>
                    : s.status === "accepted" ? <Link href={`/submissions/${s.id}/workbench`} className="text-indigo-600 hover:underline">Workbench →</Link> : (
                    <span className="flex gap-2 whitespace-nowrap">
                      {missing > 0 && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">{missing} missing</span>}
                      {flags - missing > 0 && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{flags - missing} to check</span>}
                      {flags === 0 && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">looks complete</span>}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2"><StageChip stage={st} /></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500"><time dateTime={iso(s.received_at)}>{when(s.received_at)}</time></td>
              </tr>
            );
          })}
          {!submissions.length && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">
              {stageFilter ? <>No submissions at this stage. <Link href="/submissions" className="text-indigo-600 hover:underline">Show all</Link></> : "No submissions yet. Extract one from the inbox above."}
            </td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
