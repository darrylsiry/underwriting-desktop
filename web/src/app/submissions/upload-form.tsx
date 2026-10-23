"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { uploadSubmission, type UploadState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending}
      className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
      {pending ? "Reading documents…" : "Upload & extract"}
    </button>
  );
}

export function UploadForm() {
  const [state, action] = useActionState<UploadState, FormData>(uploadSubmission, {});
  return (
    <form action={action} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-4">
        <input type="file" name="files" multiple required accept=".pdf,.eml,.docx,.txt"
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm" />
        <Submit />
        <p className="text-xs text-slate-500">
          Every document in one broker submission: ACORD PDFs, emails (attachments included), questionnaires, loss runs, Word apps.
          Fillable forms are read instantly; the rest takes Claude about 20–40 seconds.
        </p>
      </div>
      {state.error && <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
    </form>
  );
}
