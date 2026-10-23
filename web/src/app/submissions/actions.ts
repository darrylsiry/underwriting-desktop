"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnPath } from "@/lib/http";
import { inboxFiles, listInbox } from "@/lib/inbox";
import { acceptSubmission, receiveSubmission, saveReview } from "@/lib/submissions";
import { currentUser, USER_COOKIE } from "@/lib/user";

export type UploadState = { error?: string };

export async function uploadSubmission(_: UploadState, form: FormData): Promise<UploadState> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { error: "Choose at least one document" };
  let id: string;
  try {
    id = await receiveSubmission(files, await currentUser());
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath("/submissions");
  redirect(`/submissions/${id}`);
}

/** Extract a submission straight from the broker drop folder: same path as an upload, no file picking. */
export async function extractFromInbox(folder: string): Promise<UploadState> {
  // Check first so a second click (or a stale page) doesn't spend a Claude call; the unique index is the backstop.
  if (!(await listInbox()).some((f) => f.folder === folder)) {
    return { error: `${folder} was already picked up or is no longer in the inbox. Refresh the page.` };
  }
  let id: string;
  try {
    id = await receiveSubmission(inboxFiles(folder), await currentUser(), folder);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath("/submissions");
  redirect(`/submissions/${id}`);
}

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}?${new URLSearchParams(params)}`);
}

export async function saveReviewAction(id: string, form: FormData) {
  const inputs = Object.fromEntries(
    [...form.entries()].filter(([k, v]) => k.includes(".") && typeof v === "string") as [string, string][],
  );
  let changed: number;
  try {
    changed = await saveReview(id, inputs, await currentUser(), String(form.get("_fingerprint") ?? ""));
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath(`/submissions/${id}`);
  back(id, { msg: changed ? `Saved ${changed} correction${changed === 1 ? "" : "s"}` : "Nothing changed" });
}

export async function acceptAction(id: string) {
  try {
    await acceptSubmission(id, await currentUser());
  } catch (err) {
    back(id, { error: (err as Error).message });
  }
  revalidatePath("/submissions");
  back(id, { msg: "Intake accepted. The submission is ready for underwriting." });
}

export async function setUserAction(form: FormData) {
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  if (name) (await cookies()).set(USER_COOKIE, name, { maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  // Back to the page the header form was on (same host, local path only).
  const h = await headers();
  redirect(safeReturnPath(h.get("referer"), h.get("host")));
}
