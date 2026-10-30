// HTTP Basic auth check for the public deployment. Pure module for node:test.
import { timingSafeEqual } from "node:crypto";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `header` ("Basic base64(user:pass)") carries exactly these credentials. */
export function basicAuthOk(header: string | null, user: string, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  // Compare both parts even if the first fails, so timing doesn't reveal which was wrong.
  const userOk = same(decoded.slice(0, i), user);
  const passOk = same(decoded.slice(i + 1), password);
  return userOk && passOk;
}

/** Request header middleware.ts sets to the signed-in username (and strips from client requests). */
export const AUTH_USER_HEADER = "x-uw-signed-in-user";

/** username -> password. Empty means the password gate is off (local dev). */
export type Users = Map<string, string>;

/**
 * BASIC_AUTH_USERS="underwriter1:pw1,underwriter2:pw2" (comma-separated; a password may contain ":"
 * but not ","). Falls back to the single BASIC_AUTH_USER / BASIC_AUTH_PASSWORD pair.
 */
export function loadUsers(env: Record<string, string | undefined>): Users {
  const users: Users = new Map();
  for (const entry of (env.BASIC_AUTH_USERS ?? "").split(",")) {
    const i = entry.indexOf(":");
    const name = entry.slice(0, i).trim();
    const password = entry.slice(i + 1).trim();
    if (i > 0 && name && password) users.set(name, password);
  }
  if (!users.size && env.BASIC_AUTH_PASSWORD) users.set(env.BASIC_AUTH_USER || "underwriter1", env.BASIC_AUTH_PASSWORD);
  return users;
}

/** True when `password` is `name`'s password. Checks every user so timing doesn't reveal which names exist. */
export function checkPassword(users: Users, name: string, password: string): boolean {
  let ok = false;
  for (const [n, p] of users) {
    const nameOk = same(n, name);
    const passOk = same(p, password);
    if (nameOk && passOk) ok = true;
  }
  return ok;
}

/** The username whose credentials `header` carries, or null. Checks every user so timing doesn't reveal which names exist. */
export function authenticate(header: string | null, users: Users): string | null {
  let match: string | null = null;
  for (const [name, password] of users) {
    if (basicAuthOk(header, name, password)) match = name;
  }
  return match;
}
