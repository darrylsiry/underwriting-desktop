import { notFound } from "next/navigation";
import { Empty, Pill, RowLink, Section, money, when } from "@/components/ui";
import { getInsured, policiesForInsured, quotesForInsured, submissionsForInsured } from "@/lib/insureds";

export const dynamic = "force-dynamic";

export default async function InsuredPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const insured = await getInsured(id);
  if (!insured) notFound();
  const [submissions, quotes, policies] = await Promise.all([submissionsForInsured(id), quotesForInsured(id), policiesForInsured(id)]);
  const written = policies.reduce((s, p) => s + Number(p.premium), 0);

  return (
    <main className="mx-auto max-w-6xl p-8">
      <RowLink href="/insureds">← Customers</RowLink>
      <h1 className="mt-2 text-2xl font-semibold">{insured.name}</h1>
      <p className="mt-1 text-sm text-slate-500">
        FEIN {insured.fein || "not on file"} · {insured.state} · customer since {when(insured.created_at)}
      </p>
      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[["Submissions", submissions.length], ["Quotes issued", quotes.length], ["Policies", policies.length], ["Written premium", written ? money(written) : "—"]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <dt className="text-xs text-slate-500">{k}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 space-y-6">
        <Section title="Policies">
          <table className="w-full text-sm"><tbody>
            {policies.map((p) => {
              const open = p.subjectivities.filter((s) => s.status === "open").length;
              return (
                <tr key={p.id} className="border-t border-slate-100 first:border-0">
                  <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/policies/${p.id}`}>{p.policy_number}</RowLink></td>
                  <td className="px-4 py-2 tabular-nums text-xs">{p.effective_date} → {p.expiration_date}</td>
                  <td className="px-4 py-2 text-xs">{open ? <Pill status="open" /> : <Pill status="received" />}{open ? ` ${open} subjectivit${open === 1 ? "y" : "ies"}` : ""}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(p.total)}</td>
                </tr>
              );
            })}
          </tbody></table>
          {!policies.length && <Empty>No policies yet</Empty>}
        </Section>
        <Section title="Quotes">
          <table className="w-full text-sm"><tbody>
            {quotes.map((q) => (
              <tr key={q.id} className={`border-t border-slate-100 first:border-0 ${q.status === "superseded" ? "text-slate-400" : ""}`}>
                <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/quotes/${q.id}`}>{q.quote_number} v{q.version}</RowLink></td>
                <td className="px-4 py-2 text-xs">eff. {q.effective_date}</td>
                <td className="px-4 py-2"><Pill status={q.status} /></td>
                <td className="px-4 py-2 text-xs text-slate-500">{when(q.issued_at)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(q.total)}</td>
              </tr>
            ))}
          </tbody></table>
          {!quotes.length && <Empty>No quotes yet</Empty>}
        </Section>
        <Section title="Submissions">
          <table className="w-full text-sm"><tbody>
            {submissions.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 first:border-0">
                <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/submissions/${s.id}`}>{s.reference}</RowLink></td>
                <td className="px-4 py-2 text-xs">class {s.class_code ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{s.receipts ? `${money(s.receipts)} receipts` : ""}</td>
                <td className="px-4 py-2"><Pill status={s.status} /></td>
                <td className="px-4 py-2 text-xs text-slate-500">{when(s.received_at)}</td>
                <td className="px-4 py-2 text-right text-xs"><RowLink href={`/submissions/${s.id}/workbench`}>Workbench →</RowLink></td>
              </tr>
            ))}
          </tbody></table>
          {!submissions.length && <Empty>No submissions</Empty>}
        </Section>
      </div>
    </main>
  );
}
