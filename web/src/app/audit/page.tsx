import type { Metadata } from "next";
import Link from "next/link";
import { RowLink, when } from "@/components/ui";
import { getSubmission } from "@/lib/submissions";
import { DISPLAY_TIME_ZONE } from "@/lib/time";
import { loadTimeline } from "@/lib/timeline";
import { applyFilters, changes, display, groupByCorrelation, type TimelineEvent } from "@/lib/timeline-merge";

export const dynamic = "force-dynamic";

const RATING_ADMIN_URL = process.env.RATING_ADMIN_URL ?? "/admin";

const SOURCES: Record<string, { label: string; style: string }> = {
  desktop: { label: "UW Desktop", style: "bg-indigo-50 text-indigo-700" },
  rate_admin: { label: "Rate admin", style: "bg-amber-50 text-amber-800" },
  rating: { label: "Rating engine", style: "bg-slate-100 text-slate-600" },
};

type Params = { submission?: string; source?: string; entityType?: string; actor?: string; q?: string; from?: string; to?: string; correlation?: string; before?: string };

function entityHref(e: TimelineEvent): string | null {
  switch (e.entityType) {
    case "submission": return `/submissions/${e.entityId}`;
    case "quote": return `/quotes/${e.entityId}`;
    case "policy": return `/policies/${e.entityId}`;
    case "book_policy": return `/policies/book/${e.entityId}`;
    case "ledger": return `/accounting?batch=${e.entityId}`;
    case "insured": return `/insureds/${e.entityId}`;
    case "rate_version": return `${RATING_ADMIN_URL}/versions/${e.entityId}`;
    default: return null;
  }
}

// UX-010: "Case history SUB-0003" for one file, "Audit" for everything.
export async function generateMetadata({ searchParams }: { searchParams: Promise<Params> }): Promise<Metadata> {
  const { submission } = await searchParams;
  const sub = submission ? await getSubmission(submission) : null;
  return { title: sub ? `Case history ${sub.reference}` : "Audit" };
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const { events: all, labels, warnings, scope, capped, oldestDesktopAt } = await loadTimeline(params.submission, params);
  const withoutBefore = Object.fromEntries(Object.entries(params).filter(([k, v]) => v && k !== "before")) as Record<string, string>;
  const events = applyFilters(all, params);
  const groups = groupByCorrelation(events);
  const actors = [...new Set(all.map((e) => e.actor))].sort();
  const entityTypes = [...new Set(all.map((e) => e.entityType))].sort();
  const label = (e: TimelineEvent) => labels.get(`${e.entityType}:${e.entityId}`) ?? e.entityLabel ?? (e.entityType === "ledger" ? e.entityId : e.entityId.slice(0, 8));
  const counts = Object.keys(SOURCES).map((s) => [s, all.filter((e) => e.source === s).length] as const);

  return (
    <main className="mx-auto max-w-6xl p-8">
      {scope ? (
        <>
          <RowLink href={`/submissions/${scope.submissionId}/workbench`}>← {scope.reference} workbench</RowLink>
          <h1 className="mt-2 text-2xl font-semibold">Case history · {scope.reference} {scope.applicant}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Everything about this submission across services: intake, worksheet, referrals, quotes, binding, its insured, and every rating call.{" "}
            <RowLink href="/audit">All activity →</RowLink>
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Audit trail</h1>
          <p className="mt-1 text-sm text-slate-500">All recorded activity: the UW Desktop, rate-table administration, and the rating engine. <RowLink href="/audit/logins">Sign-ins →</RowLink></p>
        </>
      )}

      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {params.submission && <input type="hidden" name="submission" value={params.submission} />}
        {params.correlation && <input type="hidden" name="correlation" value={params.correlation} />}
        <label className="flex flex-col gap-1 text-xs text-slate-500">Search
          <input name="q" defaultValue={params.q} placeholder="summary, action, reference" className="w-56 rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Source
          <select name="source" defaultValue={params.source ?? ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="">All</option>
            {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Record
          <select name="entityType" defaultValue={params.entityType ?? ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="">All</option>
            {entityTypes.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Who
          <select name="actor" defaultValue={params.actor ?? ""} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="">Anyone</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">From
          <input type="date" name="from" defaultValue={params.from} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">To
          <input type="date" name="to" defaultValue={params.to} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <button className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">Filter</button>
        <Link href={params.submission ? `/audit?submission=${params.submission}` : "/audit"} className="py-1.5 text-xs text-slate-500 hover:underline">Clear</Link>
      </form>

      {warnings.map((w) => <p key={w} className="mt-4 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{w}</p>)}
      {params.correlation && (
        <p className="mt-4 rounded bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
          Showing the events of one action (correlation <code className="text-xs">{params.correlation}</code>).{" "}
          <Link href={params.submission ? `/audit?submission=${params.submission}` : "/audit"} className="underline">Show everything</Link>
        </p>
      )}
      <p className="mt-4 text-xs text-slate-500">
        Showing {events.length} of {all.length} loaded events · {counts.map(([s, n]) => `${SOURCES[s].label} ${n}`).join(" · ")} · times in {DISPLAY_TIME_ZONE.replace("_", " ")}
        {/* UX-044 / UX-048: say when the newest-500 cap (by time) bit, and offer the page before that instant. */}
        {capped && oldestDesktopAt && (
          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
            UW Desktop shows its newest 500 by time; everything before {when(oldestDesktopAt)} continues on the next page.
            <Link href={`/audit?${new URLSearchParams({ ...withoutBefore, before: oldestDesktopAt })}`} className="ml-2 font-medium text-indigo-700 hover:underline">Older →</Link>
          </span>
        )}
      </p>
      {params.before && !Number.isNaN(Date.parse(params.before)) && (
        <p className="mt-2 text-sm text-slate-700">
          Older than {when(params.before)} · <Link href={`/audit?${new URLSearchParams(withoutBefore)}`} className="text-indigo-600 hover:underline">← Newer</Link>
        </p>
      )}

      <ol className="mt-3 space-y-3">
        {groups.map((g, gi) => (
          <li key={g.events[0].key + gi} className="rounded-lg border border-slate-200 bg-white shadow-sm">
            {g.events.length > 1 && (
              <p className="border-b border-slate-100 px-4 py-1.5 text-xs text-slate-500">
                One action by {g.events[0].actor} · {g.events.length} events
              </p>
            )}
            <ul className="divide-y divide-slate-100">
              {g.events.map((e) => {
                const href = entityHref(e);
                const diff = changes(e.before, e.after);
                return (
                  <li key={e.key} className="grid grid-cols-[150px_minmax(0,1fr)] gap-4 px-4 py-2.5 text-sm">
                    <div className="text-xs text-slate-500">
                      <time dateTime={e.at}>{when(e.at)}</time>{/* UX-006 */}
                      {e.recordedAt && <span className="mt-0.5 block text-[11px] text-amber-700" title="When this row was written. The time above is when it says the event happened.">recorded {when(e.recordedAt)}</span>/* CR-074 */}
                      <span className={`mt-1 block w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCES[e.source].style}`}>{SOURCES[e.source].label}</span>
                    </div>
                    <div className="min-w-0">
                      <p>
                        <span className="font-medium">{e.actor}</span>{" "}
                        <code className="text-xs text-slate-500">{e.action}</code>{" "}
                        {href
                          ? <a href={href} className="text-xs text-indigo-600 hover:underline">{e.entityType.replace("_", " ")} {label(e)}</a>
                          : <span className="text-xs text-slate-500">{label(e)}</span>}
                      </p>
                      <p className="mt-0.5 text-slate-700">{e.summary}</p>
                      {diff.length > 0 && (
                        <table className="mt-1.5 text-xs">
                          <tbody>
                            {diff.slice(0, 8).map((c) => (
                              <tr key={c.field}>
                                {c.field && <td className="pr-3 align-top font-mono text-slate-500">{c.field}</td>}
                                <td className="pr-2 align-top text-rose-700 line-through decoration-rose-300">{display(c.before)}</td>
                                <td className="align-top text-emerald-700">{display(c.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {!events.length && <li className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No events match.</li>}
      </ol>
    </main>
  );
}
