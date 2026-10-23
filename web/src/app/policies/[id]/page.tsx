import { notFound } from "next/navigation";
import { Pill, RowLink, Section, money, when } from "@/components/ui";
import { getPolicy } from "@/lib/policies";

export const dynamic = "force-dynamic";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getPolicy(id);
  if (!p) notFound();
  const open = p.subjectivities.filter((s) => s.status === "open");

  return (
    <main className="mx-auto max-w-5xl p-8">
      <RowLink href="/policies">← Policies</RowLink>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{p.policy_number}</h1>
        <Pill status={p.status} />
        <a href={`/policies/${p.id}/policy`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Policy PDF</a>
        <a href={`/policies/${p.id}/binder`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Binder {p.binder_number}</a>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {p.insured_id ? <RowLink href={`/insureds/${p.insured_id}`}>{p.insured_name}</RowLink> : p.insured_name}
        {" · "}from <RowLink href={`/quotes/${p.quote_id}`}>{p.quote_number} v{p.quote_version}</RowLink>
        {" · "}<RowLink href={`/submissions/${p.submission_id}/workbench`}>workbench</RowLink>
        {" · "}bound by {p.bound_by} {when(p.bound_at)}
        {" · "}<RowLink href={`/audit?submission=${p.submission_id}`}>case history</RowLink>
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Section title="Coverage">
          <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
            <dt className="text-slate-500">Policy period</dt><dd className="text-right">{p.effective_date} → {p.expiration_date}</dd>
            <dt className="text-slate-500">Premium</dt><dd className="text-right tabular-nums">{money(p.premium)}</dd>
            <dt className="text-slate-500">Policy fee</dt><dd className="text-right tabular-nums">{money(p.policy_fee)}</dd>
            <dt className="text-slate-500">Surplus lines tax</dt><dd className="text-right tabular-nums">{money(p.surplus_lines_tax)}</dd>
            <dt className="font-medium">Total</dt><dd className="text-right font-semibold tabular-nums">{money(p.total)}</dd>
          </dl>
        </Section>
        <Section title={`Subjectivities · ${open.length ? `${open.length} open` : "all received"}`}>
          <ul className="divide-y divide-slate-100 text-sm">
            {p.subjectivities.map((s) => (
              <li key={s.text} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1">{s.text}</span>
                {s.status === "open" && <span className="text-xs text-amber-800">due {s.due_date}</span>}
                <Pill status={s.status} />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </main>
  );
}
