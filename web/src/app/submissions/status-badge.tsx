export function StatusBadge({ status }: { status: string }) {
  const style = status === "accepted" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700";
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>{status.replace("_", " ")}</span>;
}
