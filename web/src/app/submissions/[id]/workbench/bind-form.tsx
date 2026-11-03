"use client";

import { useActionState } from "react";
import type { FormAction, FormState } from "../action-form";

/**
 * The Bind form (UX-039): asks before the one click that issues policy and binder numbers and books
 * the premium, naming the quote, the amount and how many subjectivities stay open. A refusal comes back
 * with the boxes still ticked (UX-076). `action` is the bound server action; the heading and the submit button come in as children.
 */
export function BindForm({ action, label, subjectivities, heading, children }: {
  action: FormAction; label: string; subjectivities: string[]; heading: React.ReactNode; children: React.ReactNode;
}) {
  const [raw, dispatch] = useActionState<FormState, FormData>(action, {});
  const state = raw ?? {};
  const ticked = new Set((state.values?.received ?? "").split(",").filter(Boolean));
  return (
    <form action={dispatch} className="space-y-2 rounded-md border border-slate-200 p-3"
      onSubmit={(e) => {
        const open = e.currentTarget.querySelectorAll('input[name="received"]:not(:checked)').length;
        const msg = `${label}?\n${open ? `${open} subjectivit${open === 1 ? "y stays" : "ies stay"} open, due in 30 days.` : "All subjectivities received."}\nThis issues policy and binder numbers and books the premium to the GL.`;
        if (!confirm(msg)) e.preventDefault();
      }}>
      {heading}
      {subjectivities.map((text, i) => (
        <label key={`${i}-${state.values?.received}`} className="flex items-start gap-2 text-xs">
          <input type="checkbox" name="received" value={i} defaultChecked={ticked.has(String(i))} className="mt-0.5" /> {text}
        </label>
      ))}
      {state.error && <p className="text-xs text-rose-700" role="alert">{state.error}</p>}
      {children}
    </form>
  );
}
