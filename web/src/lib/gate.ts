// The sign-in gate's decisions, pure for node:test: which paths are public, who a request proves it
// is, and the headers the app is allowed to see. middleware.ts applies them to every request.
import { AUTH_USER_HEADER, authenticate, type Users } from "./basic-auth.ts";
import { verifySession } from "./session.ts";

/** Reachable without signing in (the publish route has its own token). Anchored, so a route added as /signin-help is gated, not public by accident. */
export const PUBLIC_PATH = /^\/(signin|signout|request-access|api\/live|api\/reports\/publish)(\/|$)/;

/** Who the request proves it is: a live session of a login that still exists (CR-083), or HTTP Basic. */
export function requestUser(cookie: string | undefined, authorization: string | null, users: Users, key: string): string | null {
  return sessionUser(cookie, users, key) ?? authenticate(authorization, users);
}

const sessionUser = (cookie: string | undefined, users: Users, key: string) => {
  const name = verifySession(cookie, key);
  return name && users.has(name) ? name : null;
};

/** The login when HTTP Basic is what proved it, for the sign-in report: a browser session isn't a new login (CR-093). */
export function basicUser(cookie: string | undefined, authorization: string | null, users: Users, key: string): string | null {
  return sessionUser(cookie, users, key) ? null : authenticate(authorization, users);
}

/** The request's headers as the app sees them: only a verified user is named, whatever the client sent (CR-099). */
export function forwardedHeaders(request: Headers, user: string | null): Headers {
  const headers = new Headers(request);
  headers.delete(AUTH_USER_HEADER);
  if (user) headers.set(AUTH_USER_HEADER, user);
  return headers;
}
