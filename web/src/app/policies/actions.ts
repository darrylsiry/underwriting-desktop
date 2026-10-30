"use server";

import { redirect } from "next/navigation";
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
