import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, cache } from "react";
import { Empty, Pill, RowLink, Section, money, when, whenDate } from "@/components/ui";
import { RENEWAL_WINDOW_DAYS, daysUntil } from "@/lib/dashboard";
import { getPolicy } from "@/lib/policies";
import { quotesForSubmission } from "@/lib/quotes";
import { renewalOfPolicy } from "@/lib/renewals";
import { listDocuments } from "@/lib/submissions";
import { startRenewalAction } from "../actions";
import { StartRenewalForm } from "../start-renewal-form";

export const dynamic = "force-dynamic";

const load = cache(getPolicy);   // once per request, shared by the title and the page

// UX-010
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await load((await params).id);
  return { title: p ? `${p.policy_number} · Policy` : "Policy" };
}

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

type Doc = { group: string; title: string; detail: string; href: string };

/** Policy overview: coverage, subjectivities, its renewal, and every document that belongs to it. */
export default async function PolicyPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error } = await searchParams;
  const p = await load(id);
  if (!p) notFound();
  const daysLeft = daysUntil(p.expiration_date, new Date().toISOString().slice(0, 10));   // UX-023
  const [quotes, uploads, renewal] = await Promise.all([
    quotesForSubmission(p.submission_id), listDocuments(p.submission_id), renewalOfPolicy(p.renewal_submission_id),
  ]);
  const open = p.subjectivities.filter((s) => s.status === "open");
  const expiringHref = p.renewed_from ? (p.renewed_from.source === "book" ? `/policies/book/${p.renewed_from.policy_id}` : `/policies/${p.renewed_from.policy_id}`) : null;

  const docs: Doc[] = [
    { group: "Policy", title: `Policy document ${p.policy_number}`, detail: `bound ${when(p.bound_at)} by ${p.bound_by}`, href: `/policies/${p.id}/policy` },
    { group: "Policy", title: `Binder ${p.binder_number}`, detail: "temporary evidence of coverage", href: `/policies/${p.id}/binder` },
    ...quotes.flatMap((q) => [
      { group: "Quote", title: `Quote ${q.quote_number} v${q.version}`, detail: `${q.status} · ${money(q.total)} · issued ${when(q.issued_at)}`, href: `/quotes/${q.id}/pdf` },
      ...(q.has_memo ? [{ group: "Quote", title: `Renewal memo for ${q.quote_number} v${q.version}`, detail: "to the insured: what changed and why", href: `/quotes/${q.id}/memo` }] : []),
    ]),
    ...uploads.map((d) => ({ group: "Submission", title: d.filename, detail: `${Math.ceil(d.size / 1024)} KB as received`, href: `/submissions/${p.submission_id}/documents/${d.id}` })),
    ...(renewal?.quotes ?? []).flatMap((q) => [
      { group: "Renewal", title: `Renewal quote ${q.quote_number} v${q.version}`, detail: `${q.status} · ${money(q.total)}`, href: `/quotes/${q.id}/pdf` },
      ...(q.has_memo ? [{ group: "Renewal", title: `Renewal memo for ${q.quote_number} v${q.version}`, detail: "to the insured: what changed and why", href: `/quotes/${q.id}/memo` }] : []),
    ]),
    ...(renewal?.policy ? [
      { group: "Renewal", title: `Renewal policy ${renewal.policy.policy_number}`, detail: `${whenDate(renewal.policy.effective_date)} → ${whenDate(renewal.policy.expiration_date)}`, href: `/policies/${renewal.policy.id}/policy` },
    ] : []),
  ];

  return (
    <main className="mx-auto max-w-5xl p-8">
      <RowLink href="/policies">← Policies</RowLink>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{p.policy_number}</h1>
        <Pill status={p.status} />
        {p.renewed_from && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">renewal of {p.renewed_from.policy_number}</span>}
        <a href={`/policies/${p.id}/policy`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Policy PDF</a>
        <a href={`/policies/${p.id}/binder`} target="_blank" className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50">Binder {p.binder_number}</a>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {p.insured_id ? <RowLink href={`/insureds/${p.insured_id}`}>{p.insured_name}</RowLink> : p.insured_name}
        {" · "}from <RowLink href={`/quotes/${p.quote_id}`}>{p.quote_number} v{p.quote_version}</RowLink>
        {" · "}<RowLink href={`/submissions/${p.submission_id}/workbench`}>workbench</RowLink>
        {expiringHref && <> · renewed <RowLink href={expiringHref}>{p.renewed_from!.policy_number}</RowLink></>}
        {" · "}bound by {p.bound_by} {when(p.bound_at)}
        {" · "}<RowLink href={`/audit?submission=${p.submission_id}`}>case history</RowLink>
      </p>
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {/* UX-014: what is covered, from the terms frozen on the quote; the money has its own section. */}
        <Section title="Coverage">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-4 text-sm">
            <dt className="text-slate-500">Policy period</dt><dd className="text-right">{whenDate(p.effective_date)} → {whenDate(p.expiration_date)}</dd>
            {p.terms.limits.map((l) => <Fragment key={l.label}><dt className="text-slate-500">{l.label}</dt><dd className="text-right tabular-nums">{money(l.amount)}</dd></Fragment>)}
            <dt className="text-slate-500">Deductible</dt><dd className="text-right tabular-nums">{p.terms.deductible ? money(p.terms.deductible) : "None"}</dd>
            <dt className="text-slate-500">Class</dt><dd className="text-right">{p.terms.class_code} {p.terms.class_description}</dd>
            <dt className="text-slate-500">Gross receipts</dt><dd className="text-right tabular-nums">{money(p.rating_inputs.gross_receipts)}</dd>
            <dt className="text-slate-500">States</dt><dd className="text-right">{p.rating_inputs.states.join(", ")} (home {p.rating_inputs.home_state})</dd>
            <dt className="text-slate-500">Forms</dt><dd className="text-right"><ul>{p.terms.forms.map((f) => <li key={f}>{f}</li>)}</ul></dd>
          </dl>
        </Section>
        <Section title="Premium">
          <dl className="grid grid-cols-2 gap-y-1 p-4 text-sm">
            <dt className="text-slate-500">Premium</dt><dd className="text-right tabular-nums">{money(p.premium)}</dd>
            <dt className="text-slate-500">Policy fee</dt><dd className="text-right tabular-nums">{money(p.policy_fee)}</dd>
            <dt className="text-slate-500">Surplus lines tax</dt><dd className="text-right tabular-nums">{money(p.surplus_lines_tax)}</dd>
            <dt className="font-medium">Total</dt><dd className="text-right font-semibold tabular-nums">{money(p.total)}</dd>
          </dl>
        </Section>
        <Section title={`Subjectivities · ${open.length ? `${open.length} open` : "all received"}`}>
          <ul className="divide-y divide-slate-100 text-sm">
            {p.subjectivities.map((s, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1">{s.text}</span>
                {s.status === "open" && <span className="text-xs text-amber-800">due {whenDate(s.due_date!)}</span>}
                <Pill status={s.status} />
              </li>
            ))}
          </ul>
        </Section>

        {/* UX-023: when it expires, whether a renewal is due yet, and a confirm before one is created. */}
        <Section title={`Renewal · ${p.renewal_status.replace("_", " ")}`}>
          <div className="p-4 text-sm">
            {!renewal ? (
              <StartRenewalForm action={startRenewalAction.bind(null, "desktop", p.id)} policyNumber={p.policy_number} inWindow={daysLeft <= RENEWAL_WINDOW_DAYS}>
                <p className="font-medium">Expires {whenDate(p.expiration_date)} · {daysLeft < 0 ? `expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago` : `${daysLeft} day${daysLeft === 1 ? "" : "s"}`}</p>
                <p className="mt-1 text-slate-600">
                  {daysLeft > RENEWAL_WINDOW_DAYS && <>Renewals usually start within {RENEWAL_WINDOW_DAYS} days of expiry. </>}
                  Starting a renewal copies this policy&apos;s terms, schedule and rating into a new worksheet;
                  the renewing terms are then compared with it factor by factor.
                </p>
              </StartRenewalForm>
            ) : (
              <>
                <p>
                  <RowLink href={`/submissions/${renewal.submission.id}/renewal`}>Expiring vs renewing →</RowLink>{" · "}
                  <RowLink href={`/submissions/${renewal.submission.id}/workbench`}>workbench</RowLink>{" · "}
                  <span className="font-mono text-xs">{renewal.submission.reference}</span>, started by {renewal.submission.received_by} {when(renewal.submission.received_at)}
                </p>
                {renewal.quotes.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {renewal.quotes.map((q) => (
                      <li key={q.id} className={`flex items-center gap-2 ${q.status === "superseded" ? "text-slate-500" : ""}`}>
                        <Link href={`/quotes/${q.id}`} className="font-mono text-xs text-indigo-600 hover:underline">{q.quote_number} v{q.version}</Link>{/* UX-013 */}
                        <Pill status={q.status} />
                        <span className="ml-auto tabular-nums">{money(q.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {renewal.policy && (
                  <p className="mt-3 rounded bg-emerald-50 px-3 py-2 text-emerald-800">
                    Renewed as <RowLink href={`/policies/${renewal.policy.id}`}>{renewal.policy.policy_number}</RowLink>, {whenDate(renewal.policy.effective_date)} → {whenDate(renewal.policy.expiration_date)}, {money(renewal.policy.total)}
                  </p>
                )}
              </>
            )}
          </div>
        </Section>

        <Section title={`Documents · ${docs.length}`}>
          <ul className="divide-y divide-slate-100 text-sm">
            {docs.map((d) => (
              <li key={d.href + d.title} className="flex items-center gap-3 px-4 py-2">
                <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-slate-500">{d.group}</span>
                <span className="min-w-0 flex-1">
                  <a href={d.href} target="_blank" className="text-indigo-600 hover:underline">{d.title}</a>
                  <span className="block truncate text-xs text-slate-500">{d.detail}</span>
                </span>
              </li>
            ))}
            {!docs.length && <Empty>No documents</Empty>}
          </ul>
        </Section>
      </div>
    </main>
  );
}
