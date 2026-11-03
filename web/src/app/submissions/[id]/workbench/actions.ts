"use server";

import { policiesForSubmission } from "@/lib/policies";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { bindQuote } from "@/lib/policies";
import { issueQuote, issuedQuoteHref, type QuoteRow } from "@/lib/quotes";
import { FieldError, StaleWorksheetError } from "@/lib/worksheet";
import { clearReferral, money, saveAndRate } from "@/lib/worksheets";
import type { FormState } from "../action-form";

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}/workbench?${new URLSearchParams(params)}`);
}

function formFields(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
}

/**
 * Save & rate (UX-001). A value the worksheet refuses comes back as state, with the field and what
 * was typed, so the form is shown as typed. Anything after the save (the rating service down,
 * say) still reloads the page: the inputs are saved, the message says what happened.
 */
export async function saveAndRateAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  const values = formFields(form);
  // UX-037: a bound file's worksheet is frozen, even from a stale tab.
  const [bound] = await policiesForSubmission(id);
  if (bound) return { error: `Bound as ${bound.policy_number}; the worksheet can't change. Changes to a bound policy need an endorsement.`, values };
  let msg: string;
  try {
    const rating = await saveAndRate(sub, values, await currentUser());
    msg = `Rated: ${money(rating.premium)} premium, ${money(rating.total)} total`;
  } catch (err) {
    if (err instanceof FieldError) return { error: err.message, field: err.field, values };
    if (err instanceof StaleWorksheetError) return { error: err.message, values };   // CR-017: what they typed stays on screen
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  back(id, { msg });
}

/** Clear a referral (UX-076): a refusal returns state, so the note stays typed. Lands back on the Referrals card, with the next one in view (UX-069). */
export async function clearReferralAction(id: string, code: string, _prev: FormState, form: FormData): Promise<FormState> {
  const sub = await getSubmission(id);
  if (!sub) return { error: "Submission not found" };
  const note = String(form.get("note") ?? "");
  try {
    await clearReferral(sub, code, note, await currentUser(), null, String(form.get("detail") ?? "") || undefined);
  } catch (err) {
    return { error: (err as Error).message, values: { note } };
  }
  revalidatePath(`/submissions/${id}/workbench`);
  redirect(`/submissions/${id}/workbench?${new URLSearchParams({ msg: "Referral cleared" })}#referrals`);
}

/** Issue a quote (UX-001): a refused submit returns state so the dates and subjectivities stay as typed. */
export async function issueQuoteAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const sub = await getSubmission(id);
  if (!sub) return { error: "Submission not found" };
  const f = formFields(form);
  let q: QuoteRow;
  try {
    q = await issueQuote(sub, { effective_date: f.effective_date ?? "", expiration_date: f.expiration_date ?? "", subjectivities: f.subjectivities ?? "", rating_id: f._rating_id }, await currentUser());
  } catch (err) {
    return { error: (err as Error).message, field: quoteField((err as Error).message), values: f };
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath(`/submissions/${id}/renewal`);
  revalidatePath("/quotes");
  if (sub.kind === "renewal") {
    // The first renewal quote: review it against the expiring policy. A revised one: see it among the quotes.
    if (q.version === 1) redirect(`/submissions/${id}/renewal?${new URLSearchParams({ msg: `Renewal quote ${q.quote_number} v1 issued with its memo: ${money(q.total)} total` })}`);
    redirect(issuedQuoteHref(q.id));
  }
  back(id, { msg: `Quote ${q.quote_number} v${q.version} issued: ${money(q.total)} total` });
}

/** Which date input a quote-issuing message is about, if any (not exported: a "use server" export would be an endpoint). */
function quoteField(message: string): string | undefined {
  return /^Effective date/.test(message) ? "effective_date" : /^Expiration/.test(message) ? "expiration_date" : undefined;
}

export async function bindAction(id: string, quoteId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const ticked = form.getAll("received").map(String);
  let msg: string;
  try {
    const p = await bindQuote(quoteId, new Set(ticked.map(Number)), await currentUser());
    msg = `Bound: policy ${p.policy_number}, binder ${p.binder_number}`;
  } catch (err) {
    return { error: (err as Error).message, values: { received: ticked.join(",") } };   // UX-076: the boxes stay ticked
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath("/policies");
  back(id, { msg });
}
