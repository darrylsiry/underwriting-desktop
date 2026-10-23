import { cookies } from "next/headers";

// No login yet (the demo can't depend on accounts): the underwriter's name is
// a cookie set from the header, and it's what the audit trail records.
export const USER_COOKIE = "uw_user";

export async function currentUser(): Promise<string> {
  return (await cookies()).get(USER_COOKIE)?.value || "underwriter";
}
