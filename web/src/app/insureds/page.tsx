import type { Metadata } from "next";
import Link from "next/link";
import { money } from "@/components/ui";
import { listInsureds } from "@/lib/insureds";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Customers" };   // UX-010

export default async function InsuredsPage() {
  const insureds = await listInsureds();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Customers</h1>
      <p className="mt-1 text-sm text-slate-500">Insureds are created when an intake is accepted. One per FEIN.</p>
      <table className="mt-6 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Insured</th><th className="px-4 py-2">FEIN</th><th className="px-4 py-2">State</th>
            <th className="px-4 py-2 text-right">Submissions</th><th className="px-4 py-2 text-right">Policies</th>
            <th className="px-4 py-2 text-right">Written premium</th><th className="px-4 py-2">Open subjectivities</th>
          </tr>
        </thead>
        <tbody>
          {insureds.map((i) => (
            <tr key={i.id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2 font-medium"><Link href={`/insureds/${i.id}`} className="text-indigo-600 hover:underline">{i.name}</Link></td>
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{i.fein || "—"}</td>
              <td className="px-4 py-2">{i.state}</td>
              <td className="px-4 py-2 text-right tabular-nums">{i.submissions}</td>
              <td className="px-4 py-2 text-right tabular-nums">{i.policies}</td>
              <td className="px-4 py-2 text-right tabular-nums">{i.written ? money(i.written) : "—"}</td>
              <td className="px-4 py-2 text-xs">{i.open_subjectivities ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{i.open_subjectivities} open</span> : "—"}</td>
            </tr>
          ))}
          {!insureds.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No customers yet. Accept a submission&apos;s intake to create one.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
