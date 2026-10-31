import type { Stage } from "@/lib/stage";

// UX-005 / UX-034: one chip for a file's stage, in the same words and colours on the inbox, search and customer pages.
export const STAGE_STYLE: Record<Stage["tone"], string> = {
  amber: "bg-amber-50 text-amber-800", emerald: "bg-emerald-50 text-emerald-700", indigo: "bg-indigo-50 text-indigo-700", slate: "bg-slate-100 text-slate-600",
};

export function StageChip({ stage }: { stage: Stage }) {
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLE[stage.tone]}`}>{stage.label}</span>;
}
