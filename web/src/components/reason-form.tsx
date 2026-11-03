"use client";

import { SubmitButton } from "@/components/submit-button";

/**
 * Ending a file (UX-068): opens from a quiet link, needs a reason, and asks before it acts. `action` is the
 * bound server action; `id` lets a link elsewhere on the page jump to it.
 */
export function ReasonForm({ action, summary, reasons, confirmText, submitLabel, pending, id }: {
  action: (form: FormData) => void | Promise<void>; summary: string; reasons: string[]; confirmText: string; submitLabel: string; pending: string; id?: string;
}) {
  return (
    <details id={id} className="scroll-mt-24 text-xs">
      <summary className="cursor-pointer text-rose-700 hover:underline">{summary}</summary>
      <form action={action} onSubmit={(e) => { if (!confirm(confirmText)) e.preventDefault(); }} className="mt-2 space-y-2">
        <label className="flex flex-col gap-1 text-slate-500">Reason
          <select name="reason" required defaultValue="" className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900">
            <option value="" disabled>Choose a reason</option>
            {reasons.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-slate-500">Note (needed for Other)
          <input name="note" maxLength={500} className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <SubmitButton pending={pending} className="rounded border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 hover:bg-rose-50">{submitLabel}</SubmitButton>
      </form>
    </details>
  );
}
