"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button with a pending state (UX-009): while its form's action runs it
 * is disabled, marked busy, and shows `pending` ("Rating…", "Binding…") instead
 * of its label, so the user sees that the click landed and cannot submit twice.
 * Pass `form="…"` to drive a form it sits outside of; `formAction` works too.
 */
export function SubmitButton({
  children, pending, className = "", ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending: string }) {
  const { pending: isPending } = useFormStatus();
  return (
    <button type="submit" {...rest} disabled={isPending || rest.disabled} aria-busy={isPending}
      className={`${className} disabled:cursor-progress disabled:opacity-60`}>
      {isPending ? pending : children}
    </button>
  );
}
