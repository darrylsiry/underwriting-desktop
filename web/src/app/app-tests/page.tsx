import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Section } from "@/components/ui";
import { loadAgentActivity, mockupIds } from "@/lib/agent-activity";
import type { AgentView, LedgerItem, LedgerRun } from "@/lib/agent-ledger";
import { AGENTS, agentInfo, type AgentKey } from "@/lib/agent-reports";
import { when, whenShort } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "App Tests" };

// App Tests (step 26): what the four review agents have found and what became of it, read from
// their reports and the ledger on every request. A summary for demos; nothing here changes anything.

const TONE: Record<string, string> = {
  Critical: "bg-rose-100 text-rose-800", "P1 Blocker": "bg-rose-100 text-rose-800", Failure: "bg-rose-100 text-rose-800",
  High: "bg-orange-100 text-orange-800", "P2 Major": "bg-orange-100 text-orange-800",
  Medium: "bg-amber-100 text-amber-800", "P3 Minor": "bg-amber-100 text-amber-800",
  Low: "bg-slate-100 text-slate-700", "P4 Polish": "bg-slate-100 text-slate-700", Suggestion: "bg-slate-100 text-slate-600",
  Informational: "bg-sky-50 text-sky-800", Observation: "bg-sky-50 text-sky-800",
};

function Severity({ s, count }: { s: string; count?: number }) {
  if (!s) return <span className="text-xs text-slate-500">—</span>;
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${TONE[s] ?? "bg-slate-100 text-slate-700"}`}>
      {s}{count !== undefined && <span className="ml-1 tabular-nums">{count}</span>}
    </span>
  );
}

function Status({ item }: { item: LedgerItem }) {
  const tone = item.status === "resolved" ? "bg-emerald-50 text-emerald-700"
    : item.status === "accepted" ? "bg-amber-50 text-amber-800"
    : item.status === "declined" ? "bg-slate-100 text-slate-600"
    : /^new/i.test(item.statusText) ? "bg-indigo-50 text-indigo-700" : "bg-white text-slate-700 ring-1 ring-slate-200";
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{item.statusText}</span>;
}

/** `Oct 31, 8:21 PM`, the full time and zone on hover. */
function Stamp({ at }: { at: string | Date | null }) {
  return at ? <time dateTime={new Date(at).toISOString()} title={when(at)}>{whenShort(at)}</time> : <>—</>;
}

/** A calendar date (`2026-10-30`) as `Oct 30`, with the year when it isn't this year. */
function day(d: string): string {
  const date = new Date(`${d}T12:00:00Z`);
  const sameYear = d.slice(0, 4) === String(new Date().getFullYear());
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** Text with the agents' `code` spans set as code. */
function Inline({ text }: { text: string }) {
  return <>{text.split("`").map((part, n) => (n % 2 ? <code key={n} className="rounded bg-slate-100 px-1 font-mono text-[12px] text-slate-800">{part}</code> : part))}</>;
}

const Commit = ({ sha, subject }: { sha: string; subject?: string }) => <code className="rounded bg-slate-100 px-1 text-xs text-slate-700" title={subject}>{sha}</code>;

function Stat({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

/** The UAT run's pass table as numbers: tests passed and failed across its passes. */
function uatTotals(a: AgentView) {
  const t = a.report?.summary;
  if (!t) return null;
  const col = (name: RegExp) => t.columns.findIndex((c) => name.test(c));
  const [p, f, s] = [col(/^passed$/i), col(/^failed$/i), col(/^skipped$/i)];
  if (p < 0 || f < 0) return null;
  const sum = (i: number) => (i < 0 ? 0 : t.rows.reduce((n, r) => n + (Number(r[i]) || 0), 0));
  return { passed: sum(p), failed: sum(f), skipped: sum(s), passes: t.rows.length };
}

function AgentCard({ a, selected, now }: { a: AgentView; selected: boolean; now: number }) {
  const last = a.latest;
  const uat = a.info.key === "uat" ? uatTotals(a) : null;
  return (
    <Link href={`/app-tests?agent=${a.info.key}#findings`} aria-current={selected ? "true" : undefined}
      className={`group flex flex-col rounded-lg border bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md ${selected ? "border-indigo-400 ring-1 ring-indigo-200" : "border-slate-200"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-900 group-hover:text-indigo-700">{a.info.name}</h2>
        <span className="font-mono text-xs text-slate-500">{a.info.agent}</span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{a.info.what}</p>
      <div className="mt-3 flex items-baseline gap-4">
        {uat ? (
          <div><span className={`text-2xl font-semibold tabular-nums ${uat.failed ? "text-rose-700" : "text-emerald-700"}`}>{uat.passed}</span>
            <span className="ml-1 text-xs text-slate-500">passed · {uat.failed} failed</span></div>
        ) : (
          <div><span className="text-2xl font-semibold tabular-nums text-slate-900">{last?.open ?? a.open.length}</span><span className="ml-1 text-xs text-slate-500">open</span></div>
        )}
        <div><span className="text-2xl font-semibold tabular-nums text-emerald-700">{a.resolved.length}</span><span className="ml-1 text-xs text-slate-500">resolved</span></div>
      </div>
      <div className="mt-2 flex min-h-6 flex-wrap gap-1">
        {uat
          ? <span className="text-xs text-slate-600">{uat.passes} passes · {a.open.length} observation{a.open.length === 1 ? "" : "s"} open</span>
          : a.openBySeverity.map((s) => <Severity key={s.severity} s={s.severity} count={s.count} />)}
      </div>
      <p className="mt-auto pt-3 text-xs text-slate-500">
        {last?.runAt ? <>Last run <Stamp at={last.runAt} /> · {ago(last.runAt, now)}{last.commit && <> · <Commit sha={last.commit} /></>}</> : "No report yet"}
        <span className="block">{a.runs.length} run{a.runs.length === 1 ? "" : "s"} recorded</span>
      </p>
    </Link>
  );
}

function OpenTable({ a, mockups }: { a: AgentView; mockups: Set<string> }) {
  if (!a.open.length) return <Empty>Nothing open: every finding from this agent has been resolved, declined or accepted.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="whitespace-nowrap text-left text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-4 py-2">ID</th><th className="px-2 py-2">Severity</th><th className="px-2 py-2">Finding</th><th className="px-2 py-2">First seen</th><th className="px-2 py-2">Status</th></tr>
        </thead>
        <tbody>
          {a.open.map((i) => {
            const fixes = a.pendingFixes[i.key];
            return (
              <tr key={i.key} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-700">{i.id}</td>
                <td className="px-2 py-2"><Severity s={i.severity} /></td>
                <td className="min-w-0 px-2 py-2 text-slate-800">
                  <Inline text={i.title} />
                  {mockups.has(i.id) && <a href={`/app-tests/mockups/${i.id}`} target="_blank" rel="noopener" className="ml-2 whitespace-nowrap text-xs text-indigo-600 hover:underline">Before / after mockup ↗</a>}
                  {fixes && <span className="mt-1 block text-xs text-emerald-700">Fix landed after this run: {fixes.map((c) => <span key={c.sha} className="mr-1"><Commit sha={c.sha} subject={c.subject} /></span>)} the next run will check it.</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-slate-600">{day(i.firstSeen)}</td>
                <td className="px-2 py-2"><Status item={i} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClosedTable({ items }: { items: LedgerItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="whitespace-nowrap text-left text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-4 py-2">ID</th><th className="px-2 py-2">Finding</th><th className="px-2 py-2">Raised</th><th className="px-2 py-2">Closed</th><th className="px-2 py-2">How</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.key} className="border-t border-slate-100 align-top">
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-700">{i.id}</td>
              <td className="px-2 py-2 text-slate-800">{i.title ? <Inline text={i.title} /> : <span className="text-slate-500">—</span>}{i.severity && <span className="ml-2"><Severity s={i.severity} /></span>}</td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-600">{day(i.firstSeen)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-600"><Stamp at={i.closedAt} /></td>
              <td className="px-2 py-2 text-xs text-slate-600"><Status item={i} />
                {i.closedNote && <span className="mt-1 block max-w-md truncate" title={i.closedNote}>{i.closedNote.replace(/`/g, "")}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Findings({ a, mockups }: { a: AgentView; mockups: Set<string> }) {
  const r = a.report;
  const closedElsewhere = [...a.declined, ...a.accepted];
  return (
    <div id="findings" className="mt-8 scroll-mt-4 space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{a.info.name} <span className="font-normal text-slate-500">· {a.open.length} open · {a.resolved.length} resolved{closedElsewhere.length ? ` · ${closedElsewhere.length} declined or accepted` : ""}</span></h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-xs text-slate-500">Runs with <code className="rounded bg-slate-100 px-1">{a.info.command}</code></span>
          {r && <Link href={`/app-tests/${a.info.key}`} className="text-indigo-600 hover:underline">Full report →</Link>}
          {a.reportWithheld && <span className="text-xs text-slate-500">The full {a.info.name.toLowerCase()} report stays in the repository.</span>}
        </div>
      </div>
      {r?.headline && <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">Latest run says</span>
        {r.headline.replace(/`/g, "").replace(/\*\*/g, "").slice(0, 600)}{r.headline.length > 600 ? "…" : ""}
      </p>}
      {a.info.key === "uat" && r?.summary && (
        <Section title="Test passes in the latest run">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="whitespace-nowrap text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>{r.summary.columns.map((c, n) => <th key={c} className={n ? "px-2 py-2" : "px-4 py-2"}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {r.summary.rows.map((row) => (
                  <tr key={row[0]} className="border-t border-slate-100">
                    {row.map((c, n) => <td key={n} className={`${n ? "px-2" : "px-4 font-medium text-slate-900"} py-2 ${/^PASS/.test(c) ? "text-emerald-700" : /^FAIL/.test(c) ? "text-rose-700" : "text-slate-700"}`}>{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <Section title={a.info.key === "uat" ? `Open from the latest run · ${a.open.length}` : `Open · ${a.open.length}`}><OpenTable a={a} mockups={mockups} /></Section>
      <Section title={`Resolved · ${a.resolved.length}`}>
        {a.resolved.length ? (
          <details className="group">
            <summary className="cursor-pointer px-4 py-2 text-sm text-indigo-600 hover:underline">Show all {a.resolved.length}, newest first</summary>
            <ClosedTable items={a.resolved} />
          </details>
        ) : <Empty>Nothing resolved yet.</Empty>}
      </Section>
      {closedElsewhere.length > 0 && <Section title={`Declined or accepted · ${closedElsewhere.length}`}><ClosedTable items={closedElsewhere} /></Section>}
    </div>
  );
}

function RunsLog({ runs, now }: { runs: LedgerRun[]; now: number }) {
  const recent = [...runs].sort((a, b) => (b.runAt ?? "").localeCompare(a.runAt ?? "")).slice(0, 12);
  if (!recent.length) return <Empty>No runs recorded yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="whitespace-nowrap text-left text-xs uppercase tracking-wide text-slate-500">
          <tr><th className="px-4 py-2">When</th><th className="px-2 py-2">Agent</th><th className="px-2 py-2">Reviewed</th><th className="px-2 py-2 text-right">Listed open</th><th className="px-2 py-2 text-right">Closed in the run</th></tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <tr key={`${r.agent}-${r.run}`} className="border-t border-slate-100">
              <td className="whitespace-nowrap px-4 py-2 text-slate-600"><Stamp at={r.runAt} /> <span className="text-xs text-slate-500">· {ago(r.runAt, now)}</span></td>
              <td className="px-2 py-2"><Link href={`/app-tests?agent=${r.agent}#findings`} className="text-slate-900 hover:text-indigo-600 hover:underline">{agentInfo(r.agent).name}</Link></td>
              <td className="px-2 py-2">{r.commit ? <Commit sha={r.commit} /> : "—"}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.open}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AppTestsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const [{ agent }, activity, mockups] = await Promise.all([searchParams, loadAgentActivity(), mockupIds()]);
  const { view } = activity;
  const now = Date.now();
  const selected: AgentKey = AGENTS.some((a) => a.key === agent) ? (agent as AgentKey) : "code";
  const current = view.agents.find((a) => a.info.key === selected)!;
  const allRuns = view.agents.flatMap((a) => a.runs);
  const t = view.totals;

  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-8">
      <h1 className="text-2xl font-semibold">App Tests</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        Four Claude agents review this app on their own and write what they find to reports in the repository: code quality, security,
        UX and user acceptance. This page reads those reports as they change and keeps the history of every finding, open or closed.
        Read only; the agents and the people fixing things do the work.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Reading the {activity.source === "checkout" ? "reports in this checkout's docs folder (current as each agent writes)" : "reports deployed with this release"}
        {t.since && <> · history since {day(t.since)}</>}
        {activity.ledgerUpdatedAt && <> · ledger updated <Stamp at={activity.ledgerUpdatedAt} /></>}
      </p>

      <section aria-label="Totals" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Findings raised" value={t.raised} sub="all time, all agents" />
        <Stat label="Resolved" value={t.resolved} sub={t.raised ? `${Math.round((t.resolved / t.raised) * 100)}% of everything raised` : "—"} />
        <Stat label="Open now" value={t.open} sub="in the agents' latest runs" />
        <Stat label="Declined or accepted" value={t.declinedOrAccepted} sub="by a person, with a reason" />
        <Stat label="Agent runs" value={t.runs} sub="recorded in the ledger" />
      </section>

      <section aria-label="Agents" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.agents.map((a) => <AgentCard key={a.info.key} a={a} selected={a.info.key === selected} now={now} />)}
      </section>

      <Findings a={current} mockups={mockups} />

      <div className="mt-8">
        <Section title="Recent runs · all agents"><RunsLog runs={allRuns} now={now} /></Section>
      </div>
    </main>
  );
}
