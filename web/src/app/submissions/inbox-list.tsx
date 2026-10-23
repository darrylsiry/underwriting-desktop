"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { InboxFolder } from "@/lib/inbox-files";
import { extractFromInbox, type UploadState } from "./actions";

const KIND: Record<string, string> = {
  "application/pdf": "PDF",
  "message/rfc822": "Email",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "text/plain": "Text",
};

function ExtractButton() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending}
      className="whitespace-nowrap rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
      {pending ? "Reading documents…" : "Extract →"}
    </button>
  );
}

function InboxRow({ item }: { item: InboxFolder }) {
  const [state, action] = useActionState<UploadState, FormData>(extractFromInbox.bind(null, item.folder), {});
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{item.title}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {item.files.map((f) => (
            <span key={f.name} title={`${f.name} · ${(f.size / 1024).toFixed(0)} KB`}
              className="inline-flex max-w-full items-center gap-1 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
              <span className="font-semibold text-slate-500">{KIND[f.contentType] ?? "File"}</span>{f.name}
            </span>
          ))}
        </div>
        {state.error && <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{state.error}</p>}
      </div>
      <span className="font-mono text-xs text-slate-400">{item.folder}</span>
      <form action={action}><ExtractButton /></form>
    </li>
  );
}

export function InboxList({ items }: { items: InboxFolder[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((item) => <InboxRow key={item.folder} item={item} />)}
    </ul>
  );
}
