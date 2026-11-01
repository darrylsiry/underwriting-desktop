"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnPath } from "@/lib/http";
import { signedInUser, USER_COOKIE } from "@/lib/user";

// The header's "Working as" form, in a module of its own on purpose. The root layout imports it,
// and Next registers every action exported by an imported "use server" module on every page under
// that layout, including the pages outside the sign-in gate (/signin, /request-access). While this
// lived in submissions/actions.ts, uploadSubmission and reviewAction rode along and could be called
// on those pages without signing in (step 27). Keep this file to this one action.

export async function setUserAction(form: FormData) {
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  // Signed-in users are who they logged in as; the free-text name is for local dev only.
  if (name && !(await signedInUser())) (await cookies()).set(USER_COOKIE, name, { maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  // Back to the page the header form was on (same host, local path only).
  const h = await headers();
  redirect(safeReturnPath(h.get("referer"), h.get("host")));
}
