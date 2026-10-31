"use client";

import { SubmitButton } from "@/components/submit-button";

/**
 * The Start renewal form (UX-023, UX-009): asks before creating the renewal submission (one click
 * is otherwise irreversible), shows a primary button inside the renewal window and an outlined one
 * outside it, and reads "Starting renewal…" while the action runs. `action` is the bound server action.
 */
export function StartRenewalForm({ action, policyNumber, inWindow, children }: {
  action: (formData: FormData) => void | Promise<void>; policyNumber: string; inWindow: boolean; children: React.ReactNode;
}) {
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Start the renewal of ${policyNumber} now? This creates a renewal submission.`)) e.preventDefault(); }}>
      {children}
      <SubmitButton pending="Starting renewal…" className={`mt-3 rounded-md px-4 py-2 text-sm font-medium ${inWindow
        ? "bg-indigo-600 text-white hover:bg-indigo-500"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
        Start renewal
      </SubmitButton>
    </form>
  );
}
