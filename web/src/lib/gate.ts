// The sign-in gate's decisions, pure for node:test: which paths are public, who a request proves it
// is, and the headers the app is allowed to see. middleware.ts applies them to every request.
import { AUTH_USER_HEADER, authenticate, type Users } from "./basic-auth.ts";
import { verifySession } from "./session.ts";

/** Reachable without signing in. Anchored, so a route added as /signin-help is gated, not public by accident. */
export const PUBLIC_PATH = /^\/(signin|signout|request-access|api\/live)(\/|$)/;

/** Who the request proves it is: a live session of a login that still exists (CR-083), or HTTP Basic. */
export function requestUser(cookie: string | undefined, authorization: string | null, users: Users, key: string): string | null {
  const fromSession = verifySession(cookie, key);
  return fromSession && users.has(fromSession) ? fromSession : authenticate(authorization, users);
}

/** The request's headers as the app sees them: only a verified user is named, whatever the client sent (CR-099). */
export function forwardedHeaders(request: Headers, user: string | null): Headers {
  const headers = new Headers(request);
  headers.delete(AUTH_USER_HEADER);
  if (user) headers.set(AUTH_USER_HEADER, user);
  return headers;
}
