import Link from "next/link";

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
        {action && <div className="ml-auto text-xs">{action}</div>}
      </div>
      {children}
    </section>
  );
}

const PILL: Record<string, string> = {
  needs_review: "bg-amber-50 text-amber-700", accepted: "bg-emerald-50 text-emerald-700",
  issued: "bg-indigo-50 text-indigo-700", superseded: "bg-slate-100 text-slate-500", bound: "bg-emerald-50 text-emerald-700",
  open: "bg-amber-50 text-amber-800", received: "bg-emerald-50 text-emerald-700",
  not_started: "bg-slate-100 text-slate-600", in_progress: "bg-indigo-50 text-indigo-700", renewed: "bg-emerald-50 text-emerald-700",
  non_renewed: "bg-rose-50 text-rose-700", renewal: "bg-indigo-50 text-indigo-700", "prior system": "bg-slate-100 text-slate-500",
};

export function Pill({ status }: { status: string }) {
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PILL[status] ?? "bg-slate-100 text-slate-600"}`}>{status.replace("_", " ")}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-sm text-slate-500">{children}</p>;
}

export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="text-indigo-600 hover:underline">{children}</Link>;
}

export const money = (v: string | number) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;

/** Days-left chip: the number always carries the meaning, color only reinforces it. */
export function DaysChip({ days }: { days: number }) {
  const style = days < 0 ? "bg-rose-100 text-rose-800" : days <= 14 ? "bg-rose-50 text-rose-700"
    : days <= 45 ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600";
  return <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${style}`}>
    {days < 0 ? `${-days}d overdue` : days === 0 ? "today" : `${days}d`}
  </span>;
}
export { when, whenDate } from "@/lib/time";
