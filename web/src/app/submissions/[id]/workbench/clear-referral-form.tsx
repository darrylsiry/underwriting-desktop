"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import type { FormAction, FormState } from "../action-form";

/** Clear a referral. A refusal comes back under the row with the note still typed (UX-076). */
export function ClearReferralForm({ action, detail, title, selfCleared }: { action: FormAction; detail: string; title: string; selfCleared: boolean }) {
  const [raw, dispatch] = useActionState<FormState, FormData>(action, {});
  const state = raw ?? {};
  return (
    <form action={dispatch}>
      <input type="hidden" name="detail" value={detail} />
      <div className="flex gap-2">
        <input key={state.values?.note} name="note" defaultValue={state.values?.note} aria-label={`Why "${title}" is acceptable`} required minLength={10} placeholder="Why this is acceptable (authority, mitigation)"
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
        <SubmitButton pending="Clearing…" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Clear</SubmitButton>
      </div>
      {selfCleared && <p className="mt-1 text-[11px] text-amber-800">You hold this file, so this will read as self-cleared.</p>}
      {state.error && <p className="mt-1 text-xs text-rose-700" role="alert">{state.error}</p>}
    </form>
  );
}
