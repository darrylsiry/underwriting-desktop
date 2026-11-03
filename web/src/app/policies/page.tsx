import type { Metadata } from "next";
import Link from "next/link";
import { Pill, when, whenDate } from "@/components/ui";
import { policyPeriodState } from "@/lib/book-metrics";
import { firstParams, type RawParams } from "@/lib/http";
import { listPolicies } from "@/lib/policies";
import { submissionIdsReceivedBy } from "@/lib/submissions";
import { iso, todayIso } from "@/lib/time";
import { currentUser } from "@/lib/user";
import { money } from "@/lib/worksheets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Policies" };   // UX-010

type Params = { underwriter?: string; in_force?: string; new_business?: string; open?: string };

/**
 * Bound policies. `?underwriter=<name>` keeps those from that underwriter's submissions; `&in_force=1` only those in force today;
 * `&new_business=1` the desk's New business tile: unexpired and not renewals.
 */
export default async function PoliciesPage({ searchParams }: { searchParams: Promise<RawParams<Params>> }) {
  const p = firstParams<Params>(await searchParams);
  const underwriter = p.underwriter?.trim() || null;
  const inForce = p.in_force === "1";
  const newBusiness = p.new_business === "1";
  const openOnly = p.open === "1";
  const me = await currentUser();
  const all = await listPolicies({ submissionIds: underwriter ? await submissionIdsReceivedBy(underwriter) : null, inForce, newBusiness });
  const policies = openOnly ? all.filter((x) => x.subjectivities.some((s) => s.status === "open")) : all;
  const today = todayIso();
  const mine = underwriter === me;
  const pillClass = (on: boolean) => `rounded-full border px-2 py-0.5 ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`;
  const total = policies.reduce((n, x) => n + Number(x.premium), 0);
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Policies</h1>
      <p className="mt-1 text-sm text-slate-500">Bound policies with their binder and policy documents as issued.</p>
      {/* UX-062: one click to the working set, as on Submissions. */}
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{policies.length} polic{policies.length === 1 ? "y" : "ies"} · newest first</span>
        <span className="flex flex-wrap gap-1">
          <Link href="/policies" className={pillClass(!openOnly && !underwriter && !inForce && !newBusiness)}>All</Link>
          <Link href="/policies?open=1" className={pillClass(openOnly && !underwriter)}>Open subjectivities</Link>
          <Link href={`/policies?underwriter=${encodeURIComponent(me)}`} className={pillClass(mine && !openOnly && !inForce && !newBusiness)}>Mine</Link>
        </span>
      </p>
      {(underwriter || inForce || newBusiness) && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span className="font-medium">{newBusiness ? "New business b" : "B"}{underwriter ? `ound in the UW Desktop from ${underwriter}'s submissions` : "ound in the UW Desktop"}{inForce ? ", in force today" : ""}{newBusiness ? ", not yet expired" : ""}</span>
          <span>{policies.length} polic{policies.length === 1 ? "y" : "ies"} · {money(total)} premium</span>
          <Link href="/policies" className="ml-auto text-xs underline">Show all policies</Link>
        </p>
      )}
      <table className="mt-6 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Policy</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Period</th>
            <th className="px-4 py-2 text-right">Premium</th><th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2">Subjectivities</th>
            <th className="px-4 py-2">Bound</th><th className="px-4 py-2">Documents</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => {
            const open = p.subjectivities.filter((s) => s.status === "open");
            return (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs"><Link href={`/policies/${p.id}`} className="text-indigo-600 hover:underline">{p.policy_number}</Link><br /><span className="text-slate-500">{p.quote_number} v{p.quote_version}</span></td>
                {/* UX-013: the insured's name opens the customer; it looks like the link it is. */}
                <td className="px-4 py-2">{p.insured_id ? <Link href={`/insureds/${p.insured_id}`} className="text-indigo-600 hover:underline">{p.insured_name}</Link> : p.insured_name}</td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-xs">{whenDate(p.effective_date)} → {whenDate(p.expiration_date)}<br /><span className="mt-1 inline-block"><Pill status={policyPeriodState(p, today)} /></span></td>
                <td className="px-4 py-2 text-right tabular-nums">{money(p.premium)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{money(p.total)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  {open.length
                    ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{open.length} open, due {whenDate(open[0].due_date!)}</span>
                    : <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">all received</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{p.bound_by}, <time dateTime={iso(p.bound_at)}>{when(p.bound_at)}</time></td>
                <td className="whitespace-nowrap px-4 py-2 text-xs">
                  <a href={`/policies/${p.id}/binder`} target="_blank" className="text-indigo-600 hover:underline">Binder</a>{" · "}
                  <a href={`/policies/${p.id}/policy`} target="_blank" className="text-indigo-600 hover:underline">Policy</a>
                </td>
              </tr>
            );
          })}
          {!policies.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">
            {openOnly || underwriter || inForce || newBusiness ? <>No policies match this filter. <Link href="/policies" className="text-indigo-600 hover:underline">Show all</Link></> : "No policies yet. Bind an issued quote from the workbench."}
          </td></tr>}
        </tbody>
      </table>
    </main>
  );
}
