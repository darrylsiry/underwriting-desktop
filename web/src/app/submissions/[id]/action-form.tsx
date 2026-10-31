"use client";

import { createContext, useActionState, useContext, useEffect, useState } from "react";
import { SubmitButton } from "@/components/submit-button";

/**
 * What a form action returns when it cannot proceed (UX-001): the message, the field it is
 * about (shown under that input), and what the user typed (so the form comes back as typed).
 * On success the action redirects and the state resets to nothing.
 */
export type FormState = { error?: string; field?: string; values?: Record<string, string> };
export type FormAction = (prev: FormState, form: FormData) => Promise<FormState>;

type Ctx = { formId: string; state: FormState; pending: boolean; dirty: boolean; dispatch: (form: FormData) => void };
const ActionFormContext = createContext<Ctx | null>(null);
const useCtx = () => useContext(ActionFormContext);

/**
 * Holds a form's action state and dirtiness for everything inside it, including buttons that sit
 * outside the <form> element (the sticky title row) and neighbouring forms that must wait for it
 * (UX-002). Render the form itself with <ActionForm>.
 */
export function ActionFormProvider({ formId, action, children }: { formId: string; action: FormAction; children: React.ReactNode }) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(action, {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;
    const onInput = () => setDirty(true);
    const onSubmit = () => setDirty(false);
    form.addEventListener("input", onInput);
    form.addEventListener("submit", onSubmit);
    return () => { form.removeEventListener("input", onInput); form.removeEventListener("submit", onSubmit); };
  }, [formId]);
  // After a successful redirect the action has no result and React hands back undefined: a clean form.
  // A rejected submit leaves the typed values unsaved, so the form counts as dirty until it goes through.
  return <ActionFormContext.Provider value={{ formId, state: state ?? {}, pending, dirty: dirty || !!state?.error, dispatch }}>{children}</ActionFormContext.Provider>;
}

export function ActionForm({ className, children }: { className?: string; children: React.ReactNode }) {
  const c = useCtx()!;
  return <form id={c.formId} action={c.dispatch} className={className}>{children}</form>;
}

/** The form's submit button, wherever it sits: pending comes from the provider, not from an ancestor <form> (UX-009). */
export function ActionSubmit({ pending, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending: string }) {
  const c = useCtx()!;
  return (
    <SubmitButton {...rest} form={c.formId} pending={pending} disabled={c.pending || rest.disabled} aria-busy={c.pending}>
      {c.pending ? pending : children}
    </SubmitButton>
  );
}

/** The top banner for an error the action returned. */
export function ActionError() {
  const c = useCtx()!;
  if (!c.state.error) return null;
  return <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{c.state.error}</p>;
}

/** The message under the offending field. */
export function FieldMessage({ name }: { name: string }) {
  const c = useCtx()!;
  if (c.state.field !== name || !c.state.error) return null;
  return <p className="mt-1 text-xs text-rose-700" role="alert">{c.state.error}</p>;
}

/** What the input should show: what the user typed on the last failed submit, else the saved value. */
export function useFieldValue(name: string, saved: string): string {
  const c = useCtx();
  return c?.state.values?.[name] ?? saved;
}

/** The input's class when its value was rejected. */
export function useFieldInvalid(name: string): boolean {
  const c = useCtx();
  return c?.state.field === name;
}

/**
 * Neighbouring actions (Clear, Issue, Bind) wait while the main form has unsaved edits (UX-002):
 * their controls are disabled with a hint instead of silently discarding the edits.
 */
export function WaitForSave({ hint, className, children }: { hint: string; className?: string; children: React.ReactNode }) {
  const c = useCtx();
  const dirty = c?.dirty ?? false;
  return (
    <div className={className}>
      <fieldset disabled={dirty} className={`min-w-0 ${dirty ? "opacity-60" : ""}`}>{children}</fieldset>
      {dirty && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800" role="status">{hint}</p>}
    </div>
  );
}

const invalidClass = (bad: boolean) => (bad ? "border-rose-400 bg-rose-50" : "border-slate-300");

type Field = { name: string; saved: string; className?: string };

/** An input that comes back as typed after a rejected submit, red when it was the rejected field. Pass classes without a border color. */
export function ActionInput({ name, saved, className = "", ...rest }: Field & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name" | "defaultValue">) {
  const value = useFieldValue(name, saved);
  const bad = useFieldInvalid(name);
  return <input {...rest} name={name} defaultValue={value} aria-invalid={bad || undefined} className={`${className} ${invalidClass(bad)}`} />;
}

export function ActionTextarea({ name, saved, className = "", ...rest }: Field & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "name" | "defaultValue">) {
  const value = useFieldValue(name, saved);
  const bad = useFieldInvalid(name);
  return <textarea {...rest} name={name} defaultValue={value} aria-invalid={bad || undefined} className={`${className} ${invalidClass(bad)}`} />;
}

export function ActionSelect({ name, saved, className = "", children, ...rest }: Field & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "name" | "defaultValue">) {
  const value = useFieldValue(name, saved);
  const bad = useFieldInvalid(name);
  return <select {...rest} name={name} defaultValue={value} aria-invalid={bad || undefined} className={`${className} ${invalidClass(bad)}`}>{children}</select>;
}
