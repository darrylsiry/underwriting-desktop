import { cookies } from "next/headers";
import { loadUsers } from "@/lib/basic-auth";
import { SESSION_COOKIE } from "@/lib/session";
import { USER_COOKIE } from "@/lib/user";

export const dynamic = "force-dynamic";

/** Sign out: end the session cookie and show the sign-in page. Without the password gate (local development) only the "working as" cookie is cleared. */
export async function GET(req: Request) {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  if (!loadUsers(process.env).size) {
    jar.delete(USER_COOKIE);
    return Response.redirect(new URL("/", req.url), 303);
  }
  return Response.redirect(new URL("/signin?signedout=1", req.url), 303);
}
