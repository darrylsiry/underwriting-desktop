import type { Metadata } from "next";
import Link from "next/link";
import { DaysChip, money, whenDate } from "@/components/ui";
import { LOSS_RATIO_BASIS, dueWithin, lossRatio } from "@/lib/book-metrics";
import { daysUntil, loadDashboard, plural, RENEWAL_WINDOW_DAYS, type BookPolicy } from "@/lib/dashboard";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

type Params = { due?: string; view?: string };

export const metadata: Metadata = { title: "Book" };   // UX-010

const shortDate = whenDate;   // UX-025: one on-screen date format

/**
 * The in-force book behind the desk's tiles: the signed-in underwriter's policies in force today, the
 * ones written in the prior policy system plus the ones bound in the UW Desktop, with those bound but
 * not yet effective in their own table. `?due=N` is what still needs renewing within N days;
 * `?view=losses` is the prior-system book by incurred, with its loss ratio.
 */
export default async function BookPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const user = await currentUser();
  const d = await loadDashboard(user);
  const due = /^\d{1,3}$/.test(p.due ?? "") ? Number(p.due) : null;
  const losses = p.view === "losses";

  let rows: BookPolicy[] = due !== null ? dueWithin(d.unexpired, d.today, due) : d.book;
  if (losses) rows = rows.filter((x) => x.source === "prior system").sort((a, b) => b.incurred - a.incurred || b.premium - a.premium);
  const premium = rows.reduce((n, x) => n + x.premium, 0);
  const incurred = rows.reduce((n, x) => n + x.incurred, 0);
  const openClaims = rows.reduce((n, x) => n + x.open_claims, 0);
  const title = losses ? "Book loss ratio (incurred)" : due !== null ? `Renewals due within ${due} days` : "In-force book";

  const filters: { label: string; href: string; on: boolean }[] = [
    { label: "All in force", href: "/book", on: due === null && !losses },
    { label: "Due in 90 days", href: "/book?due=90", on: due === 90 && !losses },
    { label: `Due in ${RENEWAL_WINDOW_DAYS} days`, href: `/book?due=${RENEWAL_WINDOW_DAYS}`, on: due === RENEWAL_WINDOW_DAYS && !losses },
    { label: "Losses (prior-system book)", href: "/book?view=losses", on: losses },
  ];

  return (
    <main className="mx-auto max-w-7xl p-6 lg:p-8">
      <Link href="/" className="text-sm text-indigo-600 hover:underline">← {user}&apos;s desk</Link>
      <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        {losses
          ? <>Incurred losses over the last five years against five years of current premium, for the policies {user} has in force from the prior policy system (the UW Desktop&apos;s own policies have no loss history yet). Sorted by incurred.</>
          : due !== null
            ? <>Policies for {user} expiring within {due} days and not yet renewed, as of {shortDate(d.today)}: written in the prior policy system or bound in the UW Desktop. Sorted by expiration.</>
            : <>Policies in force for {user} as of {shortDate(d.today)}: written in the prior policy system or bound in the UW Desktop, already effective and not yet expired. Sorted by expiration.</>}
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {filters.map((f) => (
          <Link key={f.href} href={f.href} className={`rounded-full border px-3 py-1 ${f.on ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>{f.label}</Link>
        ))}
      </div>

      <section className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Totals">
        <Stat label="Policies" value={String(rows.length)} />
        <Stat label={losses ? "Premium (prior-system book)" : due !== null ? "Expiring premium" : "In-force premium"} value={money(premium)} />
        {losses ? <Stat label="Incurred (5 yr)" value={money(incurred)} /> : <Stat label="Prior system / UW Desktop" value={`${rows.filter((x) => x.source === "prior system").length} / ${rows.filter((x) => x.source === "uw desktop").length}`} />}
        {losses ? <Stat label={`Loss ratio (${LOSS_RATIO_BASIS}) · open claims`} value={`${Math.round((lossRatio(incurred, premium) ?? 0) * 100)}% · ${openClaims}`} /> : <Stat label="Renewals in progress" value={String(rows.filter((x) => x.renewal_status === "in_progress").length)} />}
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="px-4 py-2">Expires</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Class</th>
                <th className="px-4 py-2">States</th><th className="px-4 py-2">Producer</th><th className="px-4 py-2">Effective</th>
                <th className="px-4 py-2 text-right">Premium</th><th className="px-4 py-2">Losses (5 yr)</th><th className="px-4 py-2">Renewal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const lr = lossRatio(x.incurred, x.premium) ?? 0;
                return (
                  <tr key={x.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2"><span className="mr-2 tabular-nums">{shortDate(x.expiration_date)}</span><DaysChip days={daysUntil(x.expiration_date, d.today)} /></td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{x.href ? <Link href={x.href} className="text-indigo-600 hover:underline">{x.insured_name}</Link> : x.insured_name}</div>{/* UX-013 */}
                      <div className="font-mono text-xs text-slate-500">{x.policy_number}{x.source === "prior system" ? " · prior system" : " · UW Desktop"}</div>
                    </td>
                    <td className="px-4 py-2 text-xs"><span className="font-mono">{x.class_code}</span> <span className="text-slate-500">{x.class_description}</span></td>
                    <td className="px-4 py-2 text-xs">{x.states.join(", ")}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{x.producer}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-slate-600">{shortDate(x.effective_date)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(x.premium)}</td>
                    <td className="px-4 py-2 text-xs">
                      {x.claims ? <>{x.claims} claim{x.claims === 1 ? "" : "s"} · {money(x.incurred)} · <span className={lr >= 0.65 ? "font-semibold text-rose-700" : ""}>{Math.round(lr * 100)}% LR</span>
                        {x.open_claims > 0 && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-800">{x.open_claims} open</span>}</>
                        : <span className="text-slate-500">{x.source === "uw desktop" ? "no history yet" : "clean"}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {x.renewal_status === "in_progress" ? <span className="whitespace-nowrap rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">In progress</span>
                        : x.renewal_status === "renewed" ? <span className="whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">Renewed</span>
                        : <span className="whitespace-nowrap text-slate-500">Not started</span>}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-500">Nothing here{due !== null ? ` in the next ${due} days` : ""}.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <p className="border-t border-slate-100 px-4 py-2 text-right text-sm font-semibold tabular-nums">
            {rows.length} polic{rows.length === 1 ? "y" : "ies"} · {money(premium)} premium{losses ? ` · ${money(incurred)} incurred` : ""}
          </p>
        )}
      </section>

      {due === null && !losses && d.boundNotEffective.length > 0 && (
        <section id="bound-not-effective" className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" aria-labelledby="bound-not-effective-title">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h2 id="bound-not-effective-title" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bound, not yet effective · {d.boundNotEffective.length}</h2>
            <span className="text-xs text-slate-500">{money(d.kpis.boundNotEffectivePremium)} premium, not counted as in force until it starts</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-100">
                  <th className="px-4 py-2">Effective</th><th className="px-4 py-2">Insured</th><th className="px-4 py-2">Class</th>
                  <th className="px-4 py-2">Expires</th><th className="px-4 py-2 text-right">Premium</th>
                </tr>
              </thead>
              <tbody>
                {d.boundNotEffective.map((x) => (
                  <tr key={x.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2"><span className="mr-2 tabular-nums">{shortDate(x.effective_date)}</span><span className="text-xs tabular-nums text-slate-500">in {plural(daysUntil(x.effective_date, d.today), "day")}</span></td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{x.href ? <Link href={x.href} className="text-indigo-600 hover:underline">{x.insured_name}</Link> : x.insured_name}</div>
                      <div className="font-mono text-xs text-slate-500">{x.policy_number}{x.is_renewal ? " · renewal" : ""}</div>
                    </td>
                    <td className="px-4 py-2 text-xs"><span className="font-mono">{x.class_code}</span> <span className="text-slate-500">{x.class_description}</span></td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-slate-600">{shortDate(x.expiration_date)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(x.premium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
