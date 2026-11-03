"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { closeQuote } from "@/lib/file-closure";
import { currentUser } from "@/lib/user";

/** Close the live quote as not taken, with a reason (UX-068). */
export async function closeQuoteAction(id: string, form: FormData) {
  try {
    await closeQuote(id, { reason: String(form.get("reason") ?? ""), note: String(form.get("note") ?? "") }, await currentUser());
  } catch (err) {
    redirect(`/quotes/${id}?error=${encodeURIComponent((err as Error).message)}`);
  }
  revalidatePath("/quotes");
  revalidatePath("/");
  redirect(`/quotes/${id}?msg=${encodeURIComponent("Closed as not taken")}`);
}
