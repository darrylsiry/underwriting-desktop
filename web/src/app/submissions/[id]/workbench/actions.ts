"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
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
