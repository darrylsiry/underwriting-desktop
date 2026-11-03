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

/** A form that asks first only when `confirmText` is given, so a step that changes nothing goes straight through. */
export function ConfirmingForm({ action, confirmText, className, children }: {
  action: (form: FormData) => void | Promise<void>; confirmText?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <form action={action} className={className} onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {children}
    </form>
  );
}
