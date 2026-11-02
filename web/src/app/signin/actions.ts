"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, loadUsers } from "@/lib/basic-auth";
import { requestOrigin, safeNextPath } from "@/lib/http";
import { countFailedSignIn, recordLogin, tooManyFailedSignIns } from "@/lib/login-events";
import { clientInfo, UNKNOWN_USER } from "@/lib/login-meta";
import { SESSION_COOKIE, SESSION_DAYS, sessionKey, signSession } from "@/lib/session";

export async function signInAction(form: FormData) {
  const name = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(form.get("next"));
  const users = loadUsers(process.env);
  if (!users.size) redirect("/");
  const h = await headers();
  const { ip } = clientInfo(h);
  if (tooManyFailedSignIns(ip)) redirect(`/signin?${new URLSearchParams({ error: "limited", next, username: name })}`);
  const ok = checkPassword(users, name, password);
  if (!ok) countFailedSignIn(ip);
  // The sign-in log (step 24): who, from where, with what; failures too. A logging problem must
  // never keep an underwriter out, and a failed attempt only names a user that exists.
  await recordLogin(ok || users.has(name) ? name : UNKNOWN_USER, ok, "signin", h).catch((err) => console.error("login-events: sign-in not recorded", err));
  if (!ok) redirect(`/signin?${new URLSearchParams({ error: "1", next, username: name })}`);
  const jar = await cookies();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  jar.set(SESSION_COOKIE, signSession(name, sessionKey(process.env), expires), {
    httpOnly: true, sameSite: "lax", path: "/", expires, secure: requestOrigin(h).startsWith("https://"),
  });
  redirect(next);
}
