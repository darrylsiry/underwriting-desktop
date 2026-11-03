import { money as usd, moneyShort as usdShort } from "@/lib/format";
import Link from "next/link";
import { Suspense } from "react";
import { DaysChip, when, whenDate } from "@/components/ui";
import { lossRatio } from "@/lib/book-metrics";
import { daysUntil, loadDashboard, plural, RENEWAL_WINDOW_DAYS, type Task } from "@/lib/dashboard";
import { systemHealth } from "@/lib/health";
import { iso } from "@/lib/time";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

const TASK_KIND: Record<Task["kind"], string> = {
  review: "Intake", rate: "Rate", referral: "Referral", quote: "Quote", bind: "Bind",
  subjectivity: "Subjectivities", renewal: "Renewal", inbox: "Inbox",
};

/** The questions an underwriter asks most, one click from the desk: each opens the assistant and asks it. */
const QUICK_QUESTIONS = [
  "What should I work on next?",
  "What quotes are outstanding?",
  "Which renewals are due in the next 30 days?",
  "What's waiting in the inbox?",
  "Which submissions have open referrals?",
];

/** A KPI that opens the list behind the number. */
function Tile({ label, value, sub, href }: { label: string; value: string; sub: string; href: string }) {
  return (
    <Link href={href} className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md" title={`Open: ${label}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
        <span aria-hidden className="text-slate-300 transition group-hover:text-indigo-500">→</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 group-hover:text-indigo-700">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </Link>
  );
}

/** Live probes, behind Suspense: the desk shows at once, and a stopped service only leaves this panel waiting, briefly (CR-085). */
const DESK_PROBE_MS = 3_000;

async function SystemStatus() {
  const components = await systemHealth({ serviceTimeoutMs: DESK_PROBE_MS });
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {components.map((c) => (
        <li key={c.name} className="flex items-center gap-2 px-4 py-2" title={c.detail}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : c.timedOut ? "bg-amber-500" : "bg-rose-500"}`} />
          <span className="font-medium">{c.name}</span>
          <span className="ml-auto truncate text-xs text-slate-500">{c.ok ? "ok" : c.timedOut ? "no answer" : "down"}</span>
        </li>
      ))}
    </ul>
  );
}

const TASKS_SHOWN = 10;

/** One line of Next up. */
function TaskRow({ t, today }: { t: Task; today: string }) {
  return (
    <li className={`flex items-start gap-3 px-4 py-2.5 ${t.pinned ? "bg-indigo-50/60 shadow-[inset_3px_0_0_0_theme(colors.indigo.400)]" : ""}`}>
      <span className={`mt-0.5 w-24 shrink-0 text-xs font-medium uppercase tracking-wide ${t.pinned ? "text-indigo-600" : "text-slate-500"}`}>{TASK_KIND[t.kind]}</span>
      <div className="min-w-0 flex-1">
        <Link href={t.href} className="font-medium text-slate-900 hover:text-indigo-600 hover:underline">{t.title}</Link>
        <div className="truncate text-xs text-slate-500" title={t.detail}>{t.detail}</div>
      </div>
      {(t.due || t.expiringPremium !== undefined) && (
        // Phones stack the premium over the chip; wider screens set them side by side, the chip in a
        // fixed slot so the premiums line up down the list.
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-start sm:gap-3">
          {t.expiringPremium !== undefined && (
            <span className="text-sm font-medium tabular-nums text-slate-700" title="Expiring premium"><span className="sr-only">Expiring premium </span>{usd(t.expiringPremium)}</span>
          )}
          {t.due && <span className="flex min-w-12 justify-end"><DaysChip days={daysUntil(t.due, today)} /></span>}
        </div>
      )}
    </li>
  );
}

export default async function Home() {
  const user = await currentUser();
  const d = await loadDashboard(user);
  const k = d.kpis;
  const maxClass = Math.max(1, ...d.premiumByClass.map((c) => c.premium));
  const todayLabel = new Date(`${d.today}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  return (
    <main className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{user}&apos;s desk</h1>
          <p className="mt-1 text-sm text-slate-500">E&amp;S Contractors General Liability · {todayLabel}</p>
        </div>
        <Link href="/submissions" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Submission inbox →
        </Link>
      </div>

      <form action="/assistant" method="get" className="mt-5 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm focus-within:border-indigo-300">
        <input name="q" placeholder="AI Assistant - Ask Me Anything" aria-label="Ask the AI Assistant" autoComplete="off" maxLength={4000}
          className="flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none" />
        <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Ask</button>
      </form>
      <ul aria-label="Common questions" className="mt-2 flex flex-wrap gap-2">
        {QUICK_QUESTIONS.map((q) => (
          <li key={q}>
            <Link href={`/assistant?q=${encodeURIComponent(q)}`}
              className="inline-block rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">{q}</Link>
          </li>
        ))}
      </ul>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Book summary">
        <Tile href="/book" label="In-force premium" value={usdShort(k.inForcePremium)} sub={`${k.policies} policies in force`} />
        <Tile href="/book?due=90" label="Renewals · 90 days" value={String(k.renewalsDue90)} sub={`${usdShort(k.renewalPremium90)} expiring premium`} />
        <Tile href="/book?view=losses" label="Book loss ratio (incurred)" value={pct(k.lossRatio)} sub={`Five-year losses on current premium · ${plural(k.openClaims, "open claim")}`} />
        <Tile href={`/policies?underwriter=${encodeURIComponent(user)}&new_business=1`} label="New business" value={usdShort(k.newBusinessPremium)} sub={`${k.newBusinessPolicies} bound in the UW Desktop`} />
        <Tile href={`/quotes?status=issued&live=1&underwriter=${encodeURIComponent(user)}`} label="Quotes out" value={String(k.quotesOut)} sub={k.hitRatio === null ? "hit ratio: no decided quotes yet" : `hit ratio ${pct(k.hitRatio)} of decided quotes`} />
      </section>
      {k.boundNotEffectivePolicies > 0 && (
        <Link href="/book#bound-not-effective" className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2 shadow-sm transition hover:border-indigo-300">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Bound, not yet effective</span>
          <span className="text-sm tabular-nums text-slate-900">{k.boundNotEffectivePolicies} polic{k.boundNotEffectivePolicies === 1 ? "y" : "ies"} · {usdShort(k.boundNotEffectivePremium)} premium, not counted as in force</span>
        </Link>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:col-span-2">
          <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next up · {d.tasks.length}</h2>
            <span className="text-xs text-slate-500">Inbox first, then most urgent: overdue, then by due date</span>
          </div>
          {d.tasks.length ? (
            <ul className="divide-y divide-slate-100">
              {d.tasks.slice(0, TASKS_SHOWN).map((t, i) => <TaskRow key={i} t={t} today={d.today} />)}
            </ul>
          ) : <p className="px-4 py-8 text-center text-sm text-slate-500">Nothing waiting on you.</p>}
          {d.tasks.length > TASKS_SHOWN && (
            <details className="border-t border-slate-100">
              <summary className="cursor-pointer px-4 py-2 text-xs text-indigo-600 hover:underline">Show {d.tasks.length - TASKS_SHOWN} more</summary>
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {d.tasks.slice(TASKS_SHOWN).map((t, i) => <TaskRow key={i} t={t} today={d.today} />)}
              </ul>
            </details>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm" aria-labelledby="by-class">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 id="by-class" className="text-xs font-semibold uppercase tracking-wide text-slate-500">In-force premium by class</h2>
          </div>
          <ul className="space-y-2.5 px-4 py-3">
            {d.premiumByClass.map((c) => (
              <li key={c.code} title={`${c.code} ${c.description}: ${usd(c.premium)} across ${c.policies} polic${c.policies === 1 ? "y" : "ies"}`}>
                <div className="flex justify-between gap-2 text-xs">
                  <span className="truncate text-slate-600"><span className="font-mono text-slate-500">{c.code}</span> {c.description}</span>
                  <span className="shrink-0 tabular-nums text-slate-900">{usdShort(c.premium)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-r bg-slate-100">
                  <div className="h-1.5 rounded-r bg-indigo-500" style={{ width: `${(c.premium / maxClass) * 100}%` }} />
                </div>
              </li>
            ))}
            {!d.premiumByClass.length && <li className="py-6 text-center text-sm text-slate-500">No policies in force.</li>}
          </ul>
        </section>
      </div>

      <section id="renewals" className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500"><Link href={`/book?due=${RENEWAL_WINDOW_DAYS}`} className="hover:text-indigo-600 hover:underline">Upcoming renewals · next {RENEWAL_WINDOW_DAYS} days · {d.renewals.length}</Link></h2>
          <span className="text-xs text-slate-500">{usd(d.renewals.reduce((n, p) => n + p.premium, 0))} expiring premium</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="px-4 py-2">Expires</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Class</th>
                <th className="px-4 py-2">States</th><th className="px-4 py-2">Producer</th><th className="px-4 py-2 text-right">Premium</th>
                <th className="px-4 py-2">Losses (5 yr)</th><th className="px-4 py-2">Renewal</th>
              </tr>
            </thead>
            <tbody>
              {d.renewals.map((p) => {
                const lr = lossRatio(p.incurred, p.premium) ?? 0;
                return (
                  <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2"><span className="mr-2 tabular-nums">{whenDate(p.expiration_date)}</span><DaysChip days={daysUntil(p.expiration_date, d.today)} /></td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{p.href ? <Link href={p.href} className="text-indigo-600 hover:underline">{p.insured_name}</Link> : p.insured_name}</div>{/* UX-013 */}
                      <div className="font-mono text-xs text-slate-500">{p.policy_number}{p.source === "prior system" && " · prior system"}</div>
                    </td>
                    <td className="px-4 py-2 text-xs"><span className="font-mono">{p.class_code}</span> <span className="text-slate-500">{p.class_description}</span></td>
                    <td className="px-4 py-2 text-xs">{p.states.join(", ")}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{p.producer}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd(p.premium)}</td>
                    <td className="px-4 py-2 text-xs">
                      {p.claims ? <>{p.claims} claim{p.claims === 1 ? "" : "s"} · {usd(p.incurred)} · <span className={lr >= 0.65 ? "font-semibold text-rose-700" : ""}>{Math.round(lr * 100)}% LR</span>
                        {p.open_claims > 0 && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-800">{p.open_claims} open</span>}</> : <span className="text-slate-500">{p.source === "uw desktop" ? "none reported" : "clean"}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{p.renewal_status === "in_progress" ? <span className="whitespace-nowrap rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">In progress</span> : <span className="whitespace-nowrap text-slate-500">Not started</span>}</td>
                  </tr>
                );
              })}
              {!d.renewals.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No renewals in the next {RENEWAL_WINDOW_DAYS} days.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-slate-200 bg-white shadow-sm lg:col-span-2">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your recent activity</h2>
          </div>
          <ul className="divide-y divide-slate-100 text-sm">
            {d.activity.map((a, i) => (
              <li key={i} className="flex gap-3 px-4 py-2">
                <time dateTime={iso(a.occurred_at)} className="w-48 shrink-0 whitespace-nowrap text-xs text-slate-500">{when(a.occurred_at)}</time>{/* UX-006 */}
                <span className="min-w-0 flex-1 truncate text-slate-700" title={a.summary}>{a.summary || a.action}</span>
              </li>
            ))}
            {!d.activity.length && <li className="px-4 py-6 text-center text-slate-500">No activity yet. <Link href="/audit" className="text-indigo-600 hover:underline">Audit trail →</Link></li>}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">System status</h2>
            <a href="/api/health" className="text-xs text-slate-500 hover:underline">JSON</a>
          </div>
          <Suspense fallback={<p className="px-4 py-3 text-sm text-slate-500">Checking…</p>}>
            <SystemStatus />
          </Suspense>
        </section>
      </div>
    </main>
  );
}
