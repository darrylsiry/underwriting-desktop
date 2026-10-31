import type { Metadata } from "next";
import { Empty, RowLink, Section, when as whenAt } from "@/components/ui";
import { loginReport } from "@/lib/login-events";
import { browserLabel, place, type LoginEvent, type UserSummary } from "@/lib/login-meta";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign-ins" };   // UX-010

// UX-006: the same display zone as every other screen (was UTC in its own format).
const when = (d: Date | null) => (d ? whenAt(d) : "—");
const num = (n: number) => n.toLocaleString("en-US");

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function UsersTable({ users }: { users: UserSummary[] }) {
  if (!users.length) return <Empty>No sign-ins.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
        <tr><th className="px-4 py-2">User</th><th className="px-2 py-2 text-right">Sign-ins</th><th className="px-2 py-2 text-right">Failed</th><th className="px-2 py-2">First</th><th className="px-2 py-2">Last</th><th className="px-2 py-2">Last from</th><th className="px-2 py-2">All addresses</th><th className="px-2 py-2">All locations</th><th className="px-2 py-2">Via</th></tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.username} className="border-t border-slate-100">
            <td className="px-4 py-2 font-medium text-slate-900">{u.username}</td>
            <td className="px-2 py-2 text-right tabular-nums">{num(u.logins)}</td>
            <td className={`px-2 py-2 text-right tabular-nums ${u.failures ? "text-rose-700" : "text-slate-500"}`}>{num(u.failures)}</td>
            <td className="whitespace-nowrap px-2 py-2 text-slate-600">{when(u.first_seen)}</td>
            <td className="whitespace-nowrap px-2 py-2 text-slate-600">{when(u.last_seen)}</td>
            <td className="px-2 py-2 text-slate-600"><span className="font-mono text-xs">{u.last_ip ?? "—"}</span>{u.last_place && <span className="block text-xs text-slate-500">{u.last_place}</span>}</td>
            <td className="px-2 py-2 font-mono text-xs text-slate-600">{u.ips.join(", ") || "—"}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{u.places.join("; ") || "—"}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{u.methods.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventsTable({ events }: { events: LoginEvent[] }) {
  if (!events.length) return <Empty>No attempts.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
        <tr><th className="px-4 py-2">When</th><th className="px-2 py-2">User</th><th className="px-2 py-2">Result</th><th className="px-2 py-2">Via</th><th className="px-2 py-2">Address</th><th className="px-2 py-2">Location</th><th className="px-2 py-2">Network</th><th className="px-2 py-2">Edge</th><th className="px-2 py-2">Browser</th><th className="px-2 py-2">Language</th></tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id} className="border-t border-slate-100">
            <td className="whitespace-nowrap px-4 py-2 text-slate-600">{when(e.occurred_at)}</td>
            <td className="px-2 py-2 font-medium text-slate-900">{e.username}</td>
            <td className="px-2 py-2">{e.success
              ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">signed in</span>
              : <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">failed</span>}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{e.method === "signin" ? "sign-in page" : "API (Basic)"}</td>
            <td className="px-2 py-2 font-mono text-xs text-slate-600">{e.ip ?? "—"}</td>
            <td className="px-2 py-2 text-slate-600" title={e.geo_source ?? ""}>{place(e.geo) || <span className="text-xs text-slate-500">{e.geo_source ?? "pending"}</span>}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{e.geo?.isp ?? "—"}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{e.edge_region ?? "—"}</td>
            <td className="px-2 py-2 text-xs text-slate-600" title={e.user_agent ?? ""}>{browserLabel(e.user_agent) || "—"}</td>
            <td className="px-2 py-2 text-xs text-slate-600">{e.accept_language?.split(",")[0] ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Who has signed in: the last 24 hours and all time, with everything the sign-in recorded. */
export default async function LoginsPage({ searchParams }: { searchParams: Promise<{ hours?: string }> }) {
  const p = await searchParams;
  const hours = Math.min(24 * 90, Math.max(1, Number(p.hours) || 24));
  const r = await loginReport({ windowHours: hours });
  const recentUsers = r.last_24h.users.filter((u) => u.logins).length;
  const allUsers = r.all_time.users.filter((u) => u.logins).length;
  return (
    <main className="mx-auto max-w-6xl p-8">
      <RowLink href="/audit">← Audit trail</RowLink>
      <h1 className="mt-2 text-2xl font-semibold">Sign-ins</h1>
      <p className="mt-1 text-sm text-slate-500">
        Who has signed in over the last {hours} hours and all time, with the address, location, browser and language each sign-in arrived with.
        Generated {when(r.generated_at)}; records since {r.all_time.earliest ? when(r.all_time.earliest) : "the log started (nothing recorded yet)"}.
      </p>
      <p className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
        <span>Window: {[24, 48, 168].map((h) => h === hours ? <b key={h} className="text-slate-900">{h}h</b> : <RowLink key={h} href={`/audit/logins?hours=${h}`}>{h}h</RowLink>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}</span>
        <a href="/api/reports/logins?format=md" className="text-indigo-600 hover:underline">Markdown</a>
        <a href="/api/reports/logins?format=csv" className="text-indigo-600 hover:underline">CSV (every attempt)</a>
        <a href="/api/reports/logins" className="text-indigo-600 hover:underline">JSON</a>
        <span>Daily: <code className="rounded bg-slate-100 px-1">scripts/login-report.sh</code></span>
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={`Sign-ins · last ${hours}h`} value={num(r.last_24h.logins)} />
        <Stat label={`Users · last ${hours}h`} value={num(recentUsers)} />
        <Stat label={`Failed · last ${hours}h`} value={num(r.last_24h.failures)} tone={r.last_24h.failures ? "text-rose-700" : ""} />
        <Stat label="Users · all time" value={`${num(allUsers)}${r.never_signed_in.length ? ` of ${num(allUsers + r.never_signed_in.length)}` : ""}`} />
      </div>

      <div className="mt-6 space-y-6">
        <Section title={`Who signed in · last ${hours} hours`}><UsersTable users={r.last_24h.users} /></Section>
        <Section title={`Every attempt · last ${hours} hours`}><EventsTable events={r.last_24h.events} /></Section>
        <Section title="Who has signed in · all time">
          <UsersTable users={r.all_time.users} />
          {r.never_signed_in.length > 0 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Never signed in: {r.never_signed_in.join(", ")}</p>}
        </Section>
        <Section title={`Latest attempts · all time${r.all_time.events_total > r.all_time.events.length ? ` (newest ${num(r.all_time.events.length)} of ${num(r.all_time.events_total)})` : ""}`}
          action={<a href="/api/reports/logins?format=csv" className="text-indigo-600 hover:underline">Download all as CSV</a>}>
          <EventsTable events={r.all_time.events} />
        </Section>
      </div>
      <p className="mt-6 text-xs text-slate-500">
        Via: the sign-in page, or an HTTP Basic login on the API or MCP endpoint (recorded once per login, address and hour). Location and network are looked up from
        the address with ipwho.is; a private or local address has none. On Fly the address is the one the platform saw (Fly-Client-IP), and Edge is the Fly region that took the request.
      </p>
    </main>
  );
}
