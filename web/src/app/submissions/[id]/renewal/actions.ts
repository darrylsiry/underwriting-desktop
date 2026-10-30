"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { issueQuote, issuedQuoteHref, type QuoteRow } from "@/lib/quotes";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { money, rerateWorksheet } from "@/lib/worksheets";

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}/renewal?${new URLSearchParams(params)}`);
}

/** Re-rate the renewing terms as saved (e.g. after a rate change), then return to the rating page. */
export async function reRateAction(id: string) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  let msg: string;
  try {
    const r = await rerateWorksheet(sub, await currentUser());
    msg = `Re-rated on rates ${r.rate_version}: ${money(r.premium)} premium, ${money(r.total)} total`;
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath(`/submissions/${id}/renewal`);
  redirect(`/submissions/${id}/workbench?${new URLSearchParams({ msg })}`);
}

export async function issueRenewalQuoteAction(id: string, form: FormData) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  const f = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
  let q: QuoteRow;
  try {
    q = await issueQuote(sub, { effective_date: f.effective_date ?? "", expiration_date: f.expiration_date ?? "", subjectivities: f.subjectivities ?? "" }, await currentUser());
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/renewal`);
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath("/quotes");
  // The first renewal quote is reviewed here, against the expiring policy; a revised one is seen among the quotes.
  if (q.version > 1) redirect(issuedQuoteHref(q.id));
  back(id, { msg: `Renewal quote ${q.quote_number} v${q.version} issued with its memo: ${money(q.total)} total` });
}
