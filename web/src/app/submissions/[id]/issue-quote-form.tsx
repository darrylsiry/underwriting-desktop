"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { addYears } from "@/lib/quote-terms";
import { isIsoDate } from "@/lib/submission";
import { whenDate } from "@/lib/time";
import type { FormAction, FormState } from "./action-form";

const input = "rounded border px-2 py-1 text-sm text-slate-900";
const border = (bad: boolean) => (bad ? "border-rose-400 bg-rose-50" : "border-slate-300");

/**
 * The issue-a-quote form, shared by the workbench and the renewal comparison page.
 * UX-001: dates are date inputs (the browser refuses "12/1/2026"), and a rejected submit
 * comes back as typed with the message under the field. UX-003: `primary` false when
 * binding the issued quote is the more likely next step. CR-113, UX-065: policies are annual, so
 * the expiration follows the effective date and isn't a field to get wrong; a past date warns
 * without blocking, since it can be a deliberate backdate. CR-148: `ratingId` is the rating
 * the button's price came from, so a re-rate in another tab can't issue at a price nobody saw.
 */
export function IssueQuoteForm({ action, effective, today, subjectivities, label, ratingId, primary = true }: {
  action: FormAction; effective: string; today: string; subjectivities: string[]; label: string; ratingId?: string; primary?: boolean;
}) {
  const [raw, dispatch] = useActionState<FormState, FormData>(action, {});
  const state = raw ?? {};   // undefined after a successful redirect
  const v = (name: string, saved: string) => state.values?.[name] ?? saved;
  const [date, setDate] = useState(v("effective_date", effective));
  const expiration = isIsoDate(date) ? addYears(date, 1) : "";
  const fieldError = (name: string) => state.field === name && state.error
    ? <span className="text-rose-700" role="alert">{state.error}</span> : null;
  return (
    <form action={dispatch} className="space-y-3">
      {ratingId && <input type="hidden" name="_rating_id" value={ratingId} />}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Effective
          <input type="date" name="effective_date" defaultValue={v("effective_date", effective)} required onChange={(e) => setDate(e.target.value)}
            className={`${input} ${border(state.field === "effective_date")}`} />
          {isIsoDate(date) && date < today && <span className="text-amber-800" role="status">This date has passed. Coverage would be backdated.</span>}
          {fieldError("effective_date")}
        </label>
        <div className="flex flex-col gap-1 text-xs text-slate-500">Expiration
          <input type="hidden" name="expiration_date" value={expiration} />
          <p className="py-1 text-sm text-slate-900">{expiration ? `${whenDate(expiration)} (one year)` : "One year from the effective date"}</p>
          {fieldError("expiration_date")}
        </div>
      </div>
      <label className="flex flex-col gap-1 text-xs text-slate-500">Subjectivities (one per line)
        <textarea name="subjectivities" rows={4} defaultValue={v("subjectivities", subjectivities.join("\n"))} className={`${input} ${border(false)} text-xs`} />
      </label>
      {state.error && !state.field && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700" role="alert">{state.error}</p>}
      <SubmitButton pending="Issuing quote and building PDF…"
        className={`w-full rounded-md px-4 py-2 text-sm font-medium ${primary ? "bg-emerald-600 text-white hover:bg-emerald-500" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
        {label}
      </SubmitButton>
    </form>
  );
}
