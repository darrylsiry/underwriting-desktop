"use client";

import { SubmitButton } from "@/components/submit-button";

/** One button that asks first, for a step that changes a file's state. `action` is the bound server action. */
export function ConfirmForm({ action, confirmText, pending, className, children }: {
  action: (form: FormData) => void | Promise<void>; confirmText: string; pending: string; className?: string; children: React.ReactNode;
}) {
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(confirmText)) e.preventDefault(); }} className="inline">
      <SubmitButton pending={pending} className={className}>{children}</SubmitButton>
    </form>
  );
}
