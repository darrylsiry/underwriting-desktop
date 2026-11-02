"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { issueQuote, issuedQuoteHref, type QuoteRow } from "@/lib/quotes";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { money, rerateWorksheet } from "@/lib/worksheets";
import type { FormState } from "../action-form";

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}/renewal?${new URLSearchParams(params)}`);
}

/** Re-rate the renewing terms as saved (e.g. after a rate change) and refresh this comparison (UX-024). */
export async function reRateAction(id: string) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  let msg: string;
  try {
    const r = await rerateWorksheet(sub, await currentUser());
    msg = `Re-rated on rates ${r.rate_version}: ${money(r.total)} total`;
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath(`/submissions/${id}/renewal`);
  back(id, { msg });
}

/** Issue a renewal quote (UX-001): a refused submit returns state so the dates and subjectivities stay as typed. */
export async function issueRenewalQuoteAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const sub = await getSubmission(id);
  if (!sub) return { error: "Submission not found" };
  const f = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
  let q: QuoteRow;
  try {
    q = await issueQuote(sub, { effective_date: f.effective_date ?? "", expiration_date: f.expiration_date ?? "", subjectivities: f.subjectivities ?? "", rating_id: f._rating_id }, await currentUser());
  } catch (err) {
    const message = (err as Error).message;
    const field = /^Effective date/.test(message) ? "effective_date" : /^Expiration/.test(message) ? "expiration_date" : undefined;
    return { error: message, field, values: f };
  }
  revalidatePath(`/submissions/${id}/renewal`);
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath("/quotes");
  // The first renewal quote is reviewed here, against the expiring policy; a revised one is seen among the quotes.
  if (q.version > 1) redirect(issuedQuoteHref(q.id));
  back(id, { msg: `Renewal quote ${q.quote_number} v${q.version} issued with its memo: ${money(q.total)} total` });
}
