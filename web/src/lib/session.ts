// The browser's sign-in: a signed, expiring cookie naming the user, issued by the sign-in page and
// checked by middleware.ts on every request (API clients keep using HTTP Basic). Pure module
// (node:crypto only) for node:test.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "uw_session";
export const SESSION_DAYS = 7;

/**
 * The signing key: SESSION_SECRET when set, else derived from the configured logins, so a
 * deployment needs no extra secret and changing the passwords signs everyone out.
 */
export function sessionKey(env: Record<string, string | undefined>): string {
  return env.SESSION_SECRET || createHash("sha256").update(`uwdesk-session:${env.BASIC_AUTH_USERS ?? ""}:${env.BASIC_AUTH_PASSWORD ?? ""}`).digest("hex");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const mac = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

/** A cookie value for `name`, valid until `expiresAt`. */
export function signSession(name: string, key: string, expiresAt: Date): string {
  const payload = b64(JSON.stringify({ u: name, exp: expiresAt.getTime() }));
  return `${payload}.${mac(payload, key)}`;
}

/** The user a cookie value names, or null when it is missing, tampered with or expired. */
export function verifySession(value: string | undefined | null, key: string, now = new Date()): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot), sig = value.slice(dot + 1);
  const expected = mac(payload, key);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(unb64(payload)) as { u?: unknown; exp?: unknown };
    if (typeof u !== "string" || !u || typeof exp !== "number" || exp <= now.getTime()) return null;
    return u;
  } catch {
    return null;
  }
}
