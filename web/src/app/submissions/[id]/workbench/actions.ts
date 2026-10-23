"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { bindQuote } from "@/lib/policies";
import { issueQuote } from "@/lib/quotes";
import { clearReferral, money, saveAndRate } from "@/lib/worksheets";

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}/workbench?${new URLSearchParams(params)}`);
}

function formFields(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
}

export async function saveAndRateAction(id: string, form: FormData) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  let msg: string;
  try {
    const rating = await saveAndRate(sub, formFields(form), await currentUser());
    msg = `Rated: ${money(rating.premium)} premium, ${money(rating.total)} total`;
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  back(id, { msg });
}

export async function clearReferralAction(id: string, code: string, form: FormData) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  try {
    await clearReferral(sub, code, String(form.get("note") ?? ""), await currentUser());
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  back(id, { msg: "Referral cleared" });
}

export async function issueQuoteAction(id: string, form: FormData) {
  const sub = await getSubmission(id);
  if (!sub) back(id, { error: "Submission not found" });
  let msg: string;
  try {
    const f = formFields(form);
    const q = await issueQuote(sub, { effective_date: f.effective_date ?? "", expiration_date: f.expiration_date ?? "", subjectivities: f.subjectivities ?? "" }, await currentUser());
    msg = `Quote ${q.quote_number} v${q.version} issued: ${money(q.total)} total`;
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath("/quotes");
  back(id, { msg });
}

export async function bindAction(id: string, quoteId: string, form: FormData) {
  const received = new Set(form.getAll("received").map((v) => Number(v)));
  let msg: string;
  try {
    const p = await bindQuote(quoteId, received, await currentUser());
    msg = `Bound: policy ${p.policy_number}, binder ${p.binder_number}`;
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}/workbench`);
  revalidatePath("/policies");
  back(id, { msg });
}
