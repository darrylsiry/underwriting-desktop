import { cookies, headers } from "next/headers";
import { AUTH_USER_HEADER } from "./basic-auth";

// Who is working: on the deployed app, the user who signed in (set by middleware.ts after it
// checks their password); locally, where there is no login, a name chosen in the header and
// kept in a cookie. Either way it's what the audit trail records.
export const USER_COOKIE = "uw_user";
export const DEFAULT_USER = "underwriter1";

/** The signed-in user, or null when the password gate is off (local dev). */
export async function signedInUser(): Promise<string | null> {
  return (await headers()).get(AUTH_USER_HEADER);
}

export async function currentUser(): Promise<string> {
  return (await signedInUser()) ?? ((await cookies()).get(USER_COOKIE)?.value || DEFAULT_USER);
}
