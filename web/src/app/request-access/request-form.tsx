"use client";

import { useActionState } from "react";
import { requestAccessAction, type RequestState } from "./actions";

const INPUT = "mt-1 w-full rounded-md border px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-500";

function Field({ id, label, hint, error, ...input }: { id: string; label: string; hint?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className={LABEL} htmlFor={id}>{label}{hint && <span className="ml-1 normal-case tracking-normal text-slate-400">{hint}</span>}</label>
      <input id={id} name={id} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        className={`${INPUT} ${error ? "border-rose-400" : "border-slate-300"}`} {...input} />
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

/** The request-access form; on success it becomes the thank-you card. */
export function RequestAccessForm() {
  const [state, action, pending] = useActionState<RequestState, FormData>(requestAccessAction, { sent: false });
  if (state.sent) {
    return (
      <div role="status" className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-lg text-emerald-700" aria-hidden>✓</div>
        <h2 className="font-semibold text-slate-900">Request sent</h2>
        <p className="mt-2 text-sm text-slate-600">
          Thanks{state.name ? `, ${state.name}` : ""}. We&apos;ll be in touch{state.email ? <> at <span className="font-medium text-slate-800">{state.email}</span></> : ""} about a login.
        </p>
      </div>
    );
  }
  const v = state.values;
  return (
    <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      {state.error && <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <Field id="name" label="Name" required maxLength={100} autoComplete="name" autoFocus defaultValue={v?.name} error={state.errors?.name} />
      <Field id="email" label="Email" type="email" required maxLength={254} autoComplete="email" defaultValue={v?.email} error={state.errors?.email} />
      <Field id="company" label="Company" hint="(optional)" maxLength={120} autoComplete="organization" defaultValue={v?.company} />
      {/* For bots only: hidden from people and screen readers; a filled-in value means the request is dropped. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <button disabled={pending} className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
        {pending ? "Sending…" : "Request access"}
      </button>
    </form>
  );
}
