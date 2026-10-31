import Link from "next/link";

// Small pieces the integration docs pages (/accounting/api, /accounting/mcp) share.

export function Crumbs({ trail }: { trail: { href?: string; label: string }[] }) {
  return (
    <nav className="text-xs text-slate-500">
      {trail.map((t, i) => (
        <span key={t.label}>
          {i > 0 && <span className="mx-1.5">/</span>}
          {t.href ? <Link href={t.href} className="hover:underline">{t.label}</Link> : <span className="text-slate-700">{t.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="my-2">
      {title && <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">{title}</p>}
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"><code>{children}</code></pre>
    </div>
  );
}

export function Json({ value, title }: { value: unknown; title?: string }) {
  return <Code title={title}>{JSON.stringify(value, null, 2)}</Code>;
}

export function Card({ title, children, id, action }: { title: string; children: React.ReactNode; id?: string; action?: React.ReactNode }) {
  return (
    <section id={id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
        {action && <div className="ml-auto text-xs">{action}</div>}
      </div>
      <div className="p-4 text-sm">{children}</div>
    </section>
  );
}

const METHOD: Record<string, string> = { get: "bg-emerald-600", post: "bg-amber-600", delete: "bg-rose-600" };

export function Method({ m }: { m: string }) {
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-white ${METHOD[m] ?? "bg-slate-600"}`}>{m}</span>;
}

export function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "emerald" | "amber" | "indigo" }) {
  const tones = { slate: "bg-slate-100 text-slate-600", emerald: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-800", indigo: "bg-indigo-50 text-indigo-700" };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";
export const btnPrimary = "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500";
