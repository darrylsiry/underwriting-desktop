"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, loadUsers } from "@/lib/basic-auth";
import { requestOrigin } from "@/lib/http";
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
  if (!checkPassword(users, name, password)) {
    redirect(`/signin?${new URLSearchParams({ error: "1", next, username: name })}`);
  }
  const h = await headers();
  const jar = await cookies();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  jar.set(SESSION_COOKIE, signSession(name, sessionKey(process.env), expires), {
    httpOnly: true, sameSite: "lax", path: "/", expires, secure: requestOrigin(h).startsWith("https://"),
  });
  redirect(next);
}
