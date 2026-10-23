import Link from "next/link";
import { after } from "next/server";
import { daysUntil, loadDashboard, RENEWAL_WINDOW_DAYS, type Task } from "@/lib/dashboard";
import { systemHealth } from "@/lib/health";
import { wakeServices } from "@/lib/services";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const usdShort = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `$${Math.round(n / 1000)}K` : usd(n));
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const TASK_KIND: Record<Task["kind"], string> = {
  review: "Intake", rate: "Rate", referral: "Referral", quote: "Quote", bind: "Bind",
  subjectivity: "Subjectivities", renewal: "Renewal", inbox: "Inbox",
};

/** Days-left chip: the number always carries the meaning, color only reinforces it. */
function DaysChip({ days }: { days: number }) {
  const style = days < 0 ? "bg-rose-100 text-rose-800" : days <= 14 ? "bg-rose-50 text-rose-700"
    : days <= 45 ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600";
  return <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${style}`}>
    {days < 0 ? `${-days}d overdue` : days === 0 ? "today" : `${days}d`}
  </span>;
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

export default async function Home() {
  const user = await currentUser();
  const [d, components] = await Promise.all([loadDashboard(user), systemHealth()]);
  after(wakeServices); // so rating and ingestion are up by the time the underwriter extracts or rates
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

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Book summary">
        <Tile label="In-force premium" value={usdShort(k.inForcePremium)} sub={`${k.policies} policies in force`} />
        <Tile label="Renewals · 90 days" value={String(k.renewalsDue90)} sub={`${usdShort(k.renewalPremium90)} expiring premium`} />
        <Tile label="Book loss ratio" value={pct(k.lossRatio)} sub={`${k.openClaims} open claim${k.openClaims === 1 ? "" : "s"} · prior-system book`} />
        <Tile label="New business" value={usdShort(k.newBusinessPremium)} sub={`${k.newBusinessPolicies} bound in the UW Desktop`} />
        <Tile label="Quotes out" value={String(k.quotesOut)} sub={k.hitRatio === null ? "hit ratio: no decided quotes yet" : `hit ratio ${pct(k.hitRatio)} of decided quotes`} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:col-span-2">
          <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next up · {d.tasks.length}</h2>
            <span className="text-xs text-slate-400">Most urgent first: overdue, then by due date</span>
          </div>
          {d.tasks.length ? (
            <ul className="divide-y divide-slate-100">
              {d.tasks.slice(0, 10).map((t, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="mt-0.5 w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">{TASK_KIND[t.kind]}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={t.href} className="font-medium text-slate-900 hover:text-indigo-600 hover:underline">{t.title}</Link>
                    <div className="truncate text-xs text-slate-500" title={t.detail}>{t.detail}</div>
                  </div>
                  {t.due && <DaysChip days={daysUntil(t.due, d.today)} />}
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-8 text-center text-sm text-slate-400">Nothing waiting on you.</p>}
          {d.tasks.length > 10 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">+ {d.tasks.length - 10} more</p>}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm" aria-labelledby="by-class">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 id="by-class" className="text-xs font-semibold uppercase tracking-wide text-slate-500">In-force premium by class</h2>
          </div>
          <ul className="space-y-2.5 px-4 py-3">
            {d.premiumByClass.map((c) => (
              <li key={c.code} title={`${c.code} ${c.description}: ${usd(c.premium)} across ${c.policies} polic${c.policies === 1 ? "y" : "ies"}`}>
                <div className="flex justify-between gap-2 text-xs">
                  <span className="truncate text-slate-600"><span className="font-mono text-slate-400">{c.code}</span> {c.description}</span>
                  <span className="shrink-0 tabular-nums text-slate-900">{usdShort(c.premium)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-r bg-slate-100">
                  <div className="h-1.5 rounded-r bg-indigo-500" style={{ width: `${(c.premium / maxClass) * 100}%` }} />
                </div>
              </li>
            ))}
            {!d.premiumByClass.length && <li className="py-6 text-center text-sm text-slate-400">No policies in force.</li>}
          </ul>
        </section>
      </div>

      <section id="renewals" className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Upcoming renewals · next {RENEWAL_WINDOW_DAYS} days · {d.renewals.length}</h2>
          <span className="text-xs text-slate-400">{usd(d.renewals.reduce((n, p) => n + p.premium, 0))} expiring premium</span>
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
                const lr = p.premium ? p.incurred / p.premium : 0;
                return (
                  <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2"><span className="mr-2 tabular-nums">{shortDate(p.expiration_date)}</span><DaysChip days={daysUntil(p.expiration_date, d.today)} /></td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{p.href ? <Link href={p.href} className="hover:underline">{p.insured_name}</Link> : p.insured_name}</div>
                      <div className="font-mono text-xs text-slate-400">{p.policy_number}{p.source === "prior system" && " · prior system"}</div>
                    </td>
                    <td className="px-4 py-2 text-xs"><span className="font-mono">{p.class_code}</span> <span className="text-slate-500">{p.class_description}</span></td>
                    <td className="px-4 py-2 text-xs">{p.states.join(", ")}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{p.producer}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd(p.premium)}</td>
                    <td className="px-4 py-2 text-xs">
                      {p.claims ? <>{p.claims} claim{p.claims === 1 ? "" : "s"} · {usd(p.incurred)} · <span className={lr >= 0.65 ? "font-semibold text-rose-700" : ""}>{Math.round(lr * 100)}% LR</span>
                        {p.open_claims > 0 && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-800">{p.open_claims} open</span>}</> : <span className="text-slate-400">clean</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{p.renewal_status === "in_progress" ? <span className="whitespace-nowrap rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">In progress</span> : <span className="whitespace-nowrap text-slate-500">Not started</span>}</td>
                  </tr>
                );
              })}
              {!d.renewals.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No renewals in the next {RENEWAL_WINDOW_DAYS} days.</td></tr>}
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
                <span className="w-32 shrink-0 text-xs text-slate-400">{a.occurred_at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <span className="min-w-0 flex-1 truncate text-slate-700" title={a.summary}>{a.summary || a.action}</span>
              </li>
            ))}
            {!d.activity.length && <li className="px-4 py-6 text-center text-slate-400">No activity yet. <Link href="/audit" className="text-indigo-600 hover:underline">Audit trail →</Link></li>}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">System status</h2>
            <a href="/api/health" className="text-xs text-slate-400 hover:underline">JSON</a>
          </div>
          <ul className="divide-y divide-slate-100 text-sm">
            {components.map((c) => (
              <li key={c.name} className="flex items-center gap-2 px-4 py-2" title={c.detail}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : "bg-rose-500"}`} />
                <span className="font-medium">{c.name}</span>
                <span className="ml-auto truncate text-xs text-slate-500">{c.ok ? "ok" : "down"}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
