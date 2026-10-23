import { NextResponse, type NextRequest } from "next/server";
import { AUTH_USER_HEADER, authenticate, loadUsers } from "@/lib/basic-auth";

// Password gate for the public deployment: every page, action, document and the proxied rate
// admin need one of the user logins when BASIC_AUTH_USERS (or BASIC_AUTH_PASSWORD) is set as a
// Fly secret. Unset locally. Node runtime so secrets are read at runtime and compared in constant time.
export const config = { runtime: "nodejs", matcher: "/((?!_next/static|_next/image|favicon.ico|api/live).*)" };

export function middleware(req: NextRequest) {
  // Only this middleware may say who is signed in: drop anything the client sent under that name.
  const headers = new Headers(req.headers);
  headers.delete(AUTH_USER_HEADER);
  const users = loadUsers(process.env);
  if (!users.size) return NextResponse.next({ request: { headers } });
  const name = authenticate(req.headers.get("authorization"), users);
  if (!name) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Underwriting Desktop", charset="UTF-8"' },
    });
  }
  headers.set(AUTH_USER_HEADER, name);
  return NextResponse.next({ request: { headers } });
}
