"use client";

import { useActionState, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE } from "@/lib/submission";
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
  // Checked here too: the server refuses a body over its limit before the action can answer in a sentence (CR-159).
  const [tooLarge, setTooLarge] = useState(false);
  const checkSize = (e: FormEvent<HTMLFormElement>) => {
    const files = (e.currentTarget.elements.namedItem("files") as HTMLInputElement).files;
    const over = [...(files ?? [])].reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES;
    setTooLarge(over);
    if (over) e.preventDefault();
  };
  const error = tooLarge ? UPLOAD_TOO_LARGE : state.error;
  return (
    <form action={action} onSubmit={checkSize} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-4">
        <input type="file" name="files" multiple required accept=".pdf,.eml,.docx,.txt"
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm" />
        <Submit />
        <p className="text-xs text-slate-500">
          Every document in one broker submission: ACORD PDFs, emails (attachments included), questionnaires, loss runs, Word apps.
          Fillable forms are read instantly; the rest takes Claude about 20–40 seconds.
        </p>
      </div>
      {error && <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </form>
  );
}
