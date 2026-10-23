import Link from "next/link";
import { listSubmissions, missingForRating } from "@/lib/submissions";
import { FIELD_DEFS, attention, getPath } from "@/lib/submission";
import { StatusBadge } from "./status-badge";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function SubmissionsPage() {
  const submissions = await listSubmissions();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Submission inbox</h1>
      <p className="mt-1 text-sm text-slate-500">Upload a broker submission; review what was extracted before it goes to underwriting.</p>

      <div className="mt-6"><UploadForm /></div>

      <table className="mt-8 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Ref</th><th className="px-4 py-2">Applicant</th><th className="px-4 py-2">Class</th>
            <th className="px-4 py-2">States</th><th className="px-4 py-2 text-right">Receipts</th>
            <th className="px-4 py-2">Review</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Received</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((s) => {
            const conflicted = new Set(s.extraction.conflicts.map((c) => c.path));
            const flags = FIELD_DEFS.filter((d) =>
              !s.corrected_fields.includes(d.path) &&
              attention(d.path, getPath(s.data, d.path), s.extraction.fields[d.path], conflicted.has(d.path))).length;
            const missing = missingForRating(s.data).length;
            const receipts = getPath(s.data, "operations.gross_receipts");
            return (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-mono text-xs"><Link href={`/submissions/${s.id}`} className="text-indigo-600 hover:underline">{s.reference}</Link></td>
                <td className="px-4 py-2 font-medium">{s.applicant_name || <span className="text-slate-400">unnamed</span>}</td>
                <td className="px-4 py-2 font-mono text-xs">{String(getPath(s.data, "operations.class_code") ?? "") || "—"}</td>
                <td className="px-4 py-2">{(getPath(s.data, "operations.states") as string[] | null)?.join(", ") || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{receipts ? `$${Number(receipts).toLocaleString("en-US")}` : "—"}</td>
                <td className="px-4 py-2 text-xs">
                  {s.status === "accepted" ? <span className="text-slate-400">done</span> : (
                    <span className="flex gap-2 whitespace-nowrap">
                      {missing > 0 && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">{missing} missing</span>}
                      {flags - missing > 0 && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{flags - missing} to check</span>}
                      {flags === 0 && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">looks complete</span>}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                <td className="px-4 py-2 text-xs text-slate-500">{s.received_at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              </tr>
            );
          })}
          {!submissions.length && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No submissions yet. Upload one above (try samples/submissions/05-desert-bloom-painting).</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
