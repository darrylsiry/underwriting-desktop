import { systemHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function Home() {
  const components = await systemHealth();
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Underwriting Desktop</h1>
      <p className="mt-1 text-sm text-slate-500">E&amp;S Contractors General Liability</p>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-slate-500">System status</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {components.map((c) => (
          <li key={c.name} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-rose-500"}`} />
              <span className="font-medium">{c.name}</span>
              <span className="ml-auto text-xs text-slate-400">{c.kind}</span>
            </div>
            <p className="mt-1 truncate text-sm text-slate-500" title={c.detail}>{c.detail}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
