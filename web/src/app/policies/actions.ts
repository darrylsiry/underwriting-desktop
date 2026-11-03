"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { markSubjectivityReceived, nonRenewPolicy, reverseNonRenewal } from "@/lib/file-closure";
import { startRenewal } from "@/lib/renewals";
import { currentUser } from "@/lib/user";

/** Start the renewal of a policy (or go to the one already started). */
export async function startRenewalAction(source: "book" | "desktop", policyId: string) {
  let result: { submissionId: string; created: boolean };
  try {
    result = await startRenewal(source, policyId, await currentUser());
  } catch (err) {
    redirect(`${source === "book" ? `/policies/book/${policyId}` : `/policies/${policyId}`}?error=${encodeURIComponent((err as Error).message)}`);
  }
  if (result.created) {
    redirect(`/submissions/${result.submissionId}/workbench?msg=${encodeURIComponent("Renewal started from the expiring policy's terms. Adjust anything that changed, then Save & rate.")}`);
  }
  redirect(`/submissions/${result.submissionId}/renewal`);
}

const pathOf = (source: "book" | "desktop", id: string) => (source === "book" ? `/policies/book/${id}` : `/policies/${id}`);

/** Run a step on a policy, then come back to its page saying how it went. */
async function onPolicy(path: string, step: () => Promise<void>, msg: string): Promise<never> {
  try {
    await step();
  } catch (err) {
    redirect(`${path}?error=${encodeURIComponent((err as Error).message)}`);
  }
  revalidatePath(path);
  revalidatePath("/");
  redirect(`${path}?msg=${encodeURIComponent(msg)}`);
}

/** Mark a policy non-renewed, with a reason (UX-068). */
export async function nonRenewAction(source: "book" | "desktop", id: string, form: FormData) {
  const input = { reason: String(form.get("reason") ?? ""), note: String(form.get("note") ?? "") };
  const actor = await currentUser();
  await onPolicy(pathOf(source, id), () => nonRenewPolicy(source, id, input, actor), "Marked non-renewed");
}

export async function reverseNonRenewalAction(source: "book" | "desktop", id: string) {
  const actor = await currentUser();
  await onPolicy(pathOf(source, id), () => reverseNonRenewal(source, id, actor), "Non-renewal reversed; the renewal can be started");
}

/** Record that a subjectivity came in (UX-051). */
export async function markReceivedAction(id: string, index: number) {
  const actor = await currentUser();
  await onPolicy(`/policies/${id}`, () => markSubjectivityReceived(id, index, actor), "Marked received");
}
