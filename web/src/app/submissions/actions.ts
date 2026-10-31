"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnPath } from "@/lib/http";
import { FIELD_DEFS, fromInput, getPath, isEmpty, setPath, type SubmissionData } from "@/lib/submission";
import { acceptSubmission, getSubmission, missingForRating, receiveSubmission, saveReview } from "@/lib/submissions";
import { currentUser, signedInUser, USER_COOKIE } from "@/lib/user";
import type { FormState } from "./[id]/action-form";

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

function back(id: string, params: Record<string, string>): never {
  redirect(`/submissions/${id}?${new URLSearchParams(params)}`);
}

/**
 * The intake review form (UX-001, UX-002). One form, two submit buttons: `intent=save` saves the
 * corrections; `intent=accept` saves them and then accepts the intake, so nothing typed is lost
 * to the wrong button. A rejected value comes back as state (message, field, what was typed)
 * instead of a redirect that would re-render the page from the database.
 */
export async function reviewAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const values = Object.fromEntries(
    [...form.entries()].filter(([k, v]) => k.includes(".") && typeof v === "string") as [string, string][],
  );
  const accept = form.get("intent") === "accept";
  // Validate every field first so the error names the input and nothing is half-saved.
  for (const def of FIELD_DEFS) {
    if (!(def.path in values)) continue;
    try {
      fromInput(def, values[def.path]);
    } catch (err) {
      return { error: (err as Error).message, field: def.path, values };
    }
  }
  if (accept) {
    // What the data will look like once saved: refuse before saving if rating still lacks something.
    const sub = await getSubmission(id);
    if (!sub) return { error: "Submission not found", values };
    const data = structuredClone(sub.data) as SubmissionData;
    for (const def of FIELD_DEFS) if (def.path in values) setPath(data, def.path, fromInput(def, values[def.path]));
    const missing = missingForRating(data);
    if (missing.length) return { error: `Fill in before accepting: ${missing.join(", ")}`, field: missing[0], values };
    if (isEmpty(getPath(data, "applicant.name"))) return { error: "Fill in the named insured before accepting", field: "applicant.name", values };
  }
  let changed: number;
  try {
    changed = await saveReview(id, values, await currentUser(), String(form.get("_fingerprint") ?? ""));
  } catch (err) {
    return { error: (err as Error).message, values };
  }
  if (accept) {
    try {
      await acceptSubmission(id, await currentUser());
    } catch (err) {
      // The corrections are saved; show the page as it now is with the reason.
      revalidatePath(`/submissions/${id}`);
      back(id, { error: (err as Error).message });
    }
    revalidatePath("/submissions");
    revalidatePath(`/submissions/${id}`);
    back(id, { msg: `${changed ? `Saved ${changed} correction${changed === 1 ? "" : "s"}. ` : ""}Intake accepted. The submission is ready for underwriting.` });
  }
  revalidatePath(`/submissions/${id}`);
  back(id, { msg: changed ? `Saved ${changed} correction${changed === 1 ? "" : "s"}` : "Nothing changed" });
}

export async function setUserAction(form: FormData) {
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  // Signed-in users are who they logged in as; the free-text name is for local dev only.
  if (name && !(await signedInUser())) (await cookies()).set(USER_COOKIE, name, { maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  // Back to the page the header form was on (same host, local path only).
  const h = await headers();
  redirect(safeReturnPath(h.get("referer"), h.get("host")));
}
