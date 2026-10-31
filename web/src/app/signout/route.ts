import { cookies } from "next/headers";
import { loadUsers } from "@/lib/basic-auth";
import { CROSS_SITE_REFUSED, sameOrigin } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/session";
import { USER_COOKIE } from "@/lib/user";

export const dynamic = "force-dynamic";

// A relative Location: in the standalone image `req.url` is the server's own 0.0.0.0:3000, not the address the browser used.
const seeOther = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });

/**
 * Sign out: end the session cookie and show the sign-in page. Without the password gate (local
 * development) only the "working as" cookie is cleared. A POST from this site's own pages only
 * (CR-081): a cross-site image or link can't end the session.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req.headers)) return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  if (!loadUsers(process.env).size) {
    jar.delete(USER_COOKIE);
    return seeOther("/");
  }
  return seeOther("/signin?signedout=1");
}

/** A GET (an old bookmark, a typed address) changes nothing: it shows a button that signs out. */
export async function GET() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign out · Underwriting Desktop</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #e2e8f0;border-radius:.5rem;padding:2rem;width:min(22rem,90vw)}h1{font-size:1.125rem;margin:0 0 .5rem}p{color:#475569;font-size:.875rem;margin:0 0 1.25rem}
button{background:#4f46e5;color:#fff;border:0;border-radius:.375rem;padding:.5rem 1rem;font:inherit;cursor:pointer}a{color:#4f46e5;font-size:.875rem;margin-left:1rem}</style></head>
<body><main><h1>Sign out of Underwriting Desktop?</h1><p>You'll be back at the sign-in page.</p>
<form method="post" action="/signout"><button>Sign out</button><a href="/">Stay signed in</a></form></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
