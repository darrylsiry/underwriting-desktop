"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import type { FormAction, FormState } from "./action-form";

const input = "rounded border px-2 py-1 text-sm text-slate-900";
const border = (bad: boolean) => (bad ? "border-rose-400 bg-rose-50" : "border-slate-300");

/**
 * The issue-a-quote form, shared by the workbench and the renewal comparison page.
 * UX-001: dates are date inputs (the browser refuses "12/1/2026"), and a rejected submit
 * comes back as typed with the message under the field. UX-003: `primary` false when
 * binding the issued quote is the more likely next step.
 */
export function IssueQuoteForm({ action, effective, expiration, subjectivities, label, primary = true }: {
  action: FormAction; effective: string; expiration: string; subjectivities: string[]; label: string; primary?: boolean;
}) {
  const [raw, dispatch] = useActionState<FormState, FormData>(action, {});
  const state = raw ?? {};   // undefined after a successful redirect
  const v = (name: string, saved: string) => state.values?.[name] ?? saved;
  const eff = v("effective_date", effective);
  return (
    <form action={dispatch} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Effective
          <input type="date" name="effective_date" defaultValue={eff} required className={`${input} ${border(state.field === "effective_date")}`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Expiration
          <input type="date" name="expiration_date" defaultValue={v("expiration_date", expiration)} min={eff || undefined}
            className={`${input} ${border(state.field === "expiration_date")}`} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-slate-500">Subjectivities (one per line)
        <textarea name="subjectivities" rows={4} defaultValue={v("subjectivities", subjectivities.join("\n"))} className={`${input} ${border(false)} text-xs`} />
      </label>
      {state.error && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700" role="alert">{state.error}</p>}
      <SubmitButton pending="Issuing quote and building PDF…"
        className={`w-full rounded-md px-4 py-2 text-sm font-medium ${primary ? "bg-emerald-600 text-white hover:bg-emerald-500" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
        {label}
      </SubmitButton>
    </form>
  );
}
