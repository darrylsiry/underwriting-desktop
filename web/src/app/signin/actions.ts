"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, loadUsers } from "@/lib/basic-auth";
import { requestOrigin } from "@/lib/http";
import { recordLogin } from "@/lib/login-events";
import { SESSION_COOKIE, SESSION_DAYS, sessionKey, signSession } from "@/lib/session";

/** Where to go after signing in: a local path only ("/x", never "//x" or another host). */
export async function safeNext(next: unknown): Promise<string> {
  const n = String(next ?? "");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && !n.startsWith("/signin") ? n : "/";
}

export async function signInAction(form: FormData) {
  const name = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = await safeNext(form.get("next"));
  const users = loadUsers(process.env);
  if (!users.size) redirect("/");
  const h = await headers();
  const ok = checkPassword(users, name, password);
  // The sign-in log (step 24): who, from where, with what; failures too. A logging problem must
  // never keep an underwriter out, and a failed attempt only names a user that exists.
  await recordLogin(ok || users.has(name) ? name : "(unknown user)", ok, "signin", h).catch((err) => console.error("login-events: sign-in not recorded", err));
  if (!ok) redirect(`/signin?${new URLSearchParams({ error: "1", next, username: name })}`);
  const jar = await cookies();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  jar.set(SESSION_COOKIE, signSession(name, sessionKey(process.env), expires), {
    httpOnly: true, sameSite: "lax", path: "/", expires, secure: requestOrigin(h).startsWith("https://"),
  });
  redirect(next);
}
