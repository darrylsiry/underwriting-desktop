import Link from "next/link";
import { listPolicies } from "@/lib/policies";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const policies = await listPolicies();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Policies</h1>
      <p className="mt-1 text-sm text-slate-500">Bound policies with their binder and policy documents as issued.</p>
      <table className="mt-6 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Policy</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Period</th>
            <th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2">Subjectivities</th>
            <th className="px-4 py-2">Bound</th><th className="px-4 py-2">Documents</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => {
            const open = p.subjectivities.filter((s) => s.status === "open");
            return (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs"><Link href={`/policies/${p.id}`} className="text-indigo-600 hover:underline">{p.policy_number}</Link><br /><span className="text-slate-400">{p.quote_number} v{p.quote_version}</span></td>
                <td className="px-4 py-2"><Link href={`/submissions/${p.submission_id}/workbench`} className="hover:underline">{p.insured_name}</Link></td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-xs">{p.effective_date} → {p.expiration_date}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{money(p.total)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  {open.length
                    ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{open.length} open, due {open[0].due_date}</span>
                    : <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">all received</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{p.bound_by}, {p.bound_at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  <a href={`/policies/${p.id}/binder`} target="_blank" className="text-indigo-600 hover:underline">Binder</a>{" · "}
                  <a href={`/policies/${p.id}/policy`} target="_blank" className="text-indigo-600 hover:underline">Policy</a>
                </td>
              </tr>
            );
          })}
          {!policies.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No policies yet. Bind an issued quote from the workbench.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
