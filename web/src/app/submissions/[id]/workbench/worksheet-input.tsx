"use client";

import type { INPUT_DEFS } from "@/lib/worksheet";
import { useFieldInvalid, useFieldValue } from "../action-form";

type Def = (typeof INPUT_DEFS)[number];
const NUMERIC = new Set(["money", "pct", "int", "mod"]);

/**
 * A rating input with its unit (UX-004): `$` before money, `%` / `ft` after, right-aligned
 * tabular figures, a numeric keypad on touch. Comes back as typed after a rejected submit
 * and turns red when it was the rejected field (UX-001).
 */
export function WorksheetInput({ def, saved, unit, list }: { def: Def; saved: string; unit: "$" | "%" | "ft" | null; list?: string }) {
  const value = useFieldValue(def.key, saved);
  const bad = useFieldInvalid(def.key);
  const numeric = NUMERIC.has(def.kind);
  const constraints = def.kind === "state" ? { pattern: "[A-Za-z]{2}", maxLength: 2, title: "2-letter state code" }
    : def.kind === "states" ? { pattern: "[A-Za-z]{2}([ ,;]+[A-Za-z]{2})*[ ,;]*", title: "2-letter state codes, e.g. TX, OK" }
    : def.kind === "mod" ? { inputMode: "decimal" as const, pattern: "[0-9]*[.]?[0-9]{0,2}", title: "A factor with up to two decimals, like 0.95 or 1.10" }
    : numeric ? { inputMode: "numeric" as const, pattern: "[0-9$,.% ]*", title: "Digits; $ , % and spaces are fine" } : {};
  return (
    <span className={`flex items-center rounded border bg-white text-sm text-slate-900 focus-within:ring-2 focus-within:ring-indigo-200 ${bad ? "border-rose-400 bg-rose-50" : "border-slate-300"}`}>
      {unit === "$" && <span className="pl-2 text-slate-500">$</span>}
      <input name={def.key} defaultValue={value} list={list} aria-invalid={bad || undefined} {...constraints}
        className={`w-full min-w-0 bg-transparent px-2 py-1.5 outline-none ${numeric ? "text-right tabular-nums" : ""}`} />
      {unit && unit !== "$" && <span className="pr-2 text-slate-500">{unit}</span>}
    </span>
  );
}
