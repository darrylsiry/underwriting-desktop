"use client";

import { useEffect, useState } from "react";

/**
 * "Unsaved changes" next to a Save button (UX-021). Listens for `input` on the
 * form with id `formId`; clears when that form submits. Renders nothing while clean.
 */
export function DirtyHint({ formId }: { formId: string }) {
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
  if (!dirty) return null;
  return <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" role="status">Unsaved changes</span>;
}
