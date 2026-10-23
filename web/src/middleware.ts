import { NextResponse, type NextRequest } from "next/server";
import { basicAuthOk } from "@/lib/basic-auth";

// Password gate for the public deployment: every page, action, document and the proxied rate
// admin need the shared credentials when BASIC_AUTH_PASSWORD is set (Fly secret). Unset locally.
// Node runtime so the secret is read at runtime and compared in constant time.
export const config = { runtime: "nodejs", matcher: "/((?!_next/static|_next/image|favicon.ico|api/live).*)" };

export function middleware(req: NextRequest) {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password) return NextResponse.next();
  if (basicAuthOk(req.headers.get("authorization"), process.env.BASIC_AUTH_USER ?? "underwriter", password)) {
    return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Underwriting Desktop", charset="UTF-8"' },
  });
}
