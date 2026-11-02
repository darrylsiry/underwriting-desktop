import { money } from "@/lib/format";
import type { Chip } from "@/lib/worksheet";

// UX-003: one look for the commercial / worksheet chip pair on the workbench and the renewal comparison.
// Emerald is done, indigo is a live commercial state, amber needs attention, slate is nothing yet.
const TONE: Record<Chip["tone"], string> = {
  done: "bg-emerald-50 text-emerald-700",   /* UX-033: tinted like every other pill */ action: "bg-indigo-50 text-indigo-700", attention: "bg-amber-50 text-amber-800", quiet: "bg-slate-100 text-slate-600",
};

export function StatusChips({ chips }: { chips: { commercial: Chip | null; worksheet: Chip | null } }) {
  return (
    <>
      {[chips.commercial, chips.worksheet].map((c) => c && (
        <span key={c.label} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[c.tone]}`}>{c.label}</span>
      ))}
    </>
  );
}

/**
 * UX-003: the worksheet no longer matches the latest issued quote. Names what changed and both
 * totals so the underwriter can choose between quoting the new terms and binding the quote as issued.
 */
export function QuoteDriftNotice({ quote, changes, newTotal }: {
  quote: { quote_number: string; version: number; total: string | number }; changes: { label: string; from: string; to: string }[]; newTotal: string | number | null;
}) {
  const v = `${quote.quote_number} v${quote.version}`;
  return (
    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
      <span className="font-medium">Worksheet differs from {v}:</span>{" "}
      {changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(" · ")}
      {" · "}total {money(quote.total)} → {newTotal === null ? "not rated yet" : money(newTotal)}.{" "}
      Issue v{quote.version + 1} to quote the new terms, or bind v{quote.version} exactly as issued.
    </p>
  );
}
