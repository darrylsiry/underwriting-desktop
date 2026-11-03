// Rules for binding a quote. Pure module so node:test can load it.
import { whenDate } from "./time.ts";

export const SUBJECTIVITY_DUE_DAYS = 30;

export type SubjectivityStatus = { text: string; status: "received" | "open"; due_date: string | null; received_at?: string; received_by?: string };

/** A quote's state as a reader means it: an issued quote past its valid-until date is expired, in every list and on every page (UX-054). */
export const quoteState = (q: { status: string; valid_until: string }, today: string): string =>
  q.status === "issued" && q.valid_until < today ? "expired" : q.status;

/** Why this quote can't be bound today, or [] if it can. */
export function bindBlockers(
  quote: { status: string; valid_until: string; effective_date: string; expiration_date: string },
  today: string,
): string[] {
  const out: string[] = [];
  if (quote.status === "superseded") out.push("A newer version of this quote exists; bind the latest version");
  if (quote.status === "bound") out.push("This quote is already bound");
  if (quote.status === "not_taken") out.push("This quote was closed as not taken; issue a new version");
  if (quote.valid_until < today) out.push(`The quote expired on ${whenDate(quote.valid_until)}; issue a revised quote`);
  if (quote.expiration_date <= today) out.push("The policy period has already ended");
  return out;
}

/** Received subjectivities are satisfied; the rest stay open and fall due within SUBJECTIVITY_DUE_DAYS of binding. */
export function subjectivityStatus(subjectivities: string[], received: Set<number>, today: string): SubjectivityStatus[] {
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + SUBJECTIVITY_DUE_DAYS);
  return subjectivities.map((text, i) => received.has(i)
    ? { text, status: "received", due_date: null }
    : { text, status: "open", due_date: due.toISOString().slice(0, 10) });
}

/** "GL-26-00001" and "BND-26-00001" share the sequence number, so a binder points to its policy. */
export function policyNumbers(seq: number, year: number): { policy: string; binder: string } {
  const suffix = `${String(year).slice(-2)}-${String(seq).padStart(5, "0")}`;
  return { policy: `GL-${suffix}`, binder: `BND-${suffix}` };
}
