"use client";

/**
 * The Bind form (UX-039): asks before the one click that issues policy and binder numbers and books
 * the premium, naming the quote, the amount and how many subjectivities stay open. `action` is the
 * bound server action; the checkboxes and the submit button come in as children.
 */
export function BindForm({ action, label, children }: {
  action: (formData: FormData) => void | Promise<void>; label: string; children: React.ReactNode;
}) {
  return (
    <form action={action} className="space-y-2 rounded-md border border-slate-200 p-3"
      onSubmit={(e) => {
        const open = e.currentTarget.querySelectorAll('input[name="received"]:not(:checked)').length;
        const msg = `${label}?\n${open ? `${open} subjectivit${open === 1 ? "y stays" : "ies stay"} open, due in 30 days.` : "All subjectivities received."}\nThis issues policy and binder numbers and books the premium to the GL.`;
        if (!confirm(msg)) e.preventDefault();
      }}>
      {children}
    </form>
  );
}
