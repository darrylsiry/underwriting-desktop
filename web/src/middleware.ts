import { NextResponse, type NextRequest } from "next/server";
import { AUTH_USER_HEADER, authenticate, loadUsers } from "@/lib/basic-auth";
import { SESSION_COOKIE, sessionKey, verifySession } from "@/lib/session";

// The sign-in gate for the public deployment, on when BASIC_AUTH_USERS (or BASIC_AUTH_PASSWORD) is
// set as a Fly secret; off locally. A browser signs in on /signin and carries a signed session
// cookie; other systems and agents send the same logins with HTTP Basic (the API and the MCP
// endpoint document that). Node runtime so secrets are read at runtime and compared in constant time.
export const config = { runtime: "nodejs", matcher: "/((?!_next/static|_next/image|favicon.ico|api/live|signin|signout).*)" };

const CHALLENGE = { "WWW-Authenticate": 'Basic realm="Underwriting Desktop", charset="UTF-8"' };

export function middleware(req: NextRequest) {
  // Only this middleware may say who is signed in: drop anything the client sent under that name.
  const headers = new Headers(req.headers);
  headers.delete(AUTH_USER_HEADER);
  const users = loadUsers(process.env);
  if (!users.size) return NextResponse.next({ request: { headers } });

  const name = verifySession(req.cookies.get(SESSION_COOKIE)?.value, sessionKey(process.env))
    ?? authenticate(req.headers.get("authorization"), users);
  if (name) {
    headers.set(AUTH_USER_HEADER, name);
    return NextResponse.next({ request: { headers } });
  }

  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/")) {
    // API and MCP callers: a JSON error and the Basic challenge their clients understand.
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Authentication required: send an Underwriting Desktop login with HTTP Basic authentication (Authorization: Basic base64(user:password))." } },
      { status: 401, headers: { ...CHALLENGE, "Cache-Control": "no-store" } });
  }
  const navigation = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (navigation) {
    // A person: the sign-in page, which comes back here afterwards.
    const signin = new URL("/signin", req.url);
    const next = `${path}${req.nextUrl.search}`;
    if (next !== "/") signin.searchParams.set("next", next);
    return NextResponse.redirect(signin);
  }
  // A page's own fetch (the assistant, the inbox panel) after the session ended: no browser prompt, just the answer.
  return NextResponse.json({ error: { code: "unauthorized", message: "Your sign-in has ended. Reload the page to sign in again." } }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
