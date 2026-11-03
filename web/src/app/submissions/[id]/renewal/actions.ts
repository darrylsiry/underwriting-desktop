"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSubmission } from "@/lib/submissions";
import { currentUser } from "@/lib/user";
import { money, rerateWorksheet } from "@/lib/worksheets";

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
