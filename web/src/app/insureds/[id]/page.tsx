import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { StageChip } from "@/components/stage-chip";
import { Empty, Pill, RowLink, Section, money, when, whenDate } from "@/components/ui";
import { submissionStagesById } from "@/lib/dashboard";
import { getInsured, policiesForInsured, quotesForInsured, submissionsForInsured } from "@/lib/insureds";

export const dynamic = "force-dynamic";

const load = cache(getInsured);   // once per request, shared by the title and the page

// UX-010
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const insured = await load((await params).id);
  return { title: insured ? `${insured.name} · Customer` : "Customer" };
}

// UX-013: every table says what its columns hold.
const TH = "px-4 py-2 font-medium";
const Head = ({ cols }: { cols: (string | [string, "right"])[] }) => (
  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
    <tr>{cols.map((c) => Array.isArray(c) ? <th key={c[0]} scope="col" className={`${TH} text-right`}>{c[0]}</th> : <th key={c} scope="col" className={TH}>{c}</th>)}</tr>
  </thead>
);

export default async function InsuredPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const insured = await load(id);
  if (!insured) notFound();
  const [submissions, quotes, policies] = await Promise.all([submissionsForInsured(id), quotesForInsured(id), policiesForInsured(id)]);
  const stages = await submissionStagesById(submissions.map((x) => x.id));   // UX-034
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
          <table className="w-full text-sm"><Head cols={["Policy", "Period", "Subjectivities", ["Total", "right"]]} /><tbody>
            {policies.map((p) => {
              const open = p.subjectivities.filter((s) => s.status === "open").length;
              return (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/policies/${p.id}`}>{p.policy_number}</RowLink></td>
                  <td className="px-4 py-2 tabular-nums text-xs">{whenDate(p.effective_date)} → {whenDate(p.expiration_date)}</td>
                  <td className="px-4 py-2 text-xs">{open ? <Pill status="open" /> : <Pill status="received" />}{open ? ` ${open} subjectivit${open === 1 ? "y" : "ies"}` : ""}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(p.total)}</td>
                </tr>
              );
            })}
          </tbody></table>
          {!policies.length && <Empty>No policies yet</Empty>}
        </Section>
        <Section title="Quotes">
          <table className="w-full text-sm"><Head cols={["Quote", "Effective", "Status", "Issued", ["Total", "right"]]} /><tbody>
            {quotes.map((q) => (
              <tr key={q.id} className={`border-t border-slate-100 ${q.status === "superseded" ? "text-slate-500" : ""}`}>
                <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/quotes/${q.id}`}>{q.quote_number} v{q.version}</RowLink></td>
                <td className="px-4 py-2 text-xs">{whenDate(q.effective_date)}</td>
                <td className="px-4 py-2"><Pill status={q.status} /></td>
                <td className="px-4 py-2 text-xs text-slate-500">{when(q.issued_at)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(q.total)}</td>
              </tr>
            ))}
          </tbody></table>
          {!quotes.length && <Empty>No quotes yet</Empty>}
        </Section>
        <Section title="Submissions">
          <table className="w-full text-sm"><Head cols={["Ref", "Class", "Receipts", "Stage", "Received", ["Next step", "right"]]} /><tbody>
            {submissions.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-mono text-xs"><RowLink href={`/submissions/${s.id}`}>{s.reference}</RowLink></td>
                <td className="px-4 py-2 text-xs">class {s.class_code ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{s.receipts ? `${money(s.receipts)} receipts` : ""}</td>
                <td className="px-4 py-2">{stages.get(s.id) ? <StageChip stage={stages.get(s.id)!} /> : <Pill status={s.status} />}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{when(s.received_at)}</td>
                {/* UX-034: the next step follows the stage: review, work, or open the policy it became. */}
                <td className="px-4 py-2 text-right text-xs">{(() => {
                  const st = stages.get(s.id);
                  if (st?.key === "bound" && st.href) return <RowLink href={st.href}>Policy →</RowLink>;
                  if (st?.key === "review" || s.status === "needs_review") return <RowLink href={`/submissions/${s.id}`}>Review →</RowLink>;
                  return <RowLink href={`/submissions/${s.id}/workbench`}>Workbench →</RowLink>;
                })()}</td>
              </tr>
            ))}
          </tbody></table>
          {!submissions.length && <Empty>No submissions</Empty>}
        </Section>
      </div>
    </main>
  );
}
